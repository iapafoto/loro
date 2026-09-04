// Capture micro → PCM 16 kHz mono (Int16), poussé par paquets ~40 ms en base64.
//
// ⚠️ VERSION SIMPLIFIÉE PAR RAPPORT À MOCHI, ET C'EST LE POINT. Mochi parlait à un
// robot POSÉ À 50 CM dans une pièce : d'où sa machinerie — `echoCancellation:false`
// (pour ne pas raboter une voix lointaine), gain logiciel, portillons `setSilenced`
// avec timers d'aveuglement, soupape de réouverture. Loro se tient DANS LA MAIN,
// micro près de la bouche : c'est exactement le cas nominal de la téléphonie, celui
// où l'annulation d'écho du navigateur fait le travail toute seule. On garde donc le
// traitement standard et on jette tout le reste.
//
// Ce module ne connaît pas Gemini : il émet des chunks, c'est LiveConversation qui
// les envoie à la session.

const WORKLET_URL = new URL('./pcm-recorder.worklet.js', import.meta.url);

/** Période de remontée du niveau micro — assez lent pour l'œil, assez vif pour parler. */
const LEVEL_PERIOD_MS = 150;

export interface MicCallbacks {
  /** Un paquet PCM 16 bits @ 16 kHz, encodé base64, prêt à envoyer. */
  onChunk(base64Pcm16: string): void;
  onError(message: string): void;
  /**
   * Niveau crête (0..1), lissé sur ~150 ms — pour une jauge à l'écran. `sending`
   * dit si le paquet part vraiment (l'envoi est coupé pendant que le prof parle).
   */
  onLevel?(peak: number, sending: boolean): void;
  /**
   * Niveau crête de CHAQUE paquet (~40 ms), sans lissage — pour la détection de
   * parole locale (mesure du temps de parole de l'élève, cf. PLAN §4).
   */
  onFrame?(peak: number): void;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _active = false;
  private _sending = true;
  private lastLevelMs = 0;
  private peakAcc = 0;

  constructor(private readonly cb: MicCallbacks) {}

  get active(): boolean {
    return this._active;
  }

  /**
   * Coupe/rétablit l'envoi des paquets (le micro tourne, on jette juste). Sert
   * d'anti-larsen trivial : on ne s'écoute pas parler. Une ligne, là où Mochi avait
   * besoin d'envoyer du silence pour ne pas suspendre la VAD du serveur — ici, le
   * prof parle par phrases entières, couper franchement suffit.
   */
  setSending(on: boolean): void {
    this._sending = on;
  }

  async start(): Promise<boolean> {
    if (this._active) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Traitement téléphonie ACTIF (contrairement à Mochi) : téléphone en
          // main, l'annulation d'écho retire la voix du prof captée par le micro,
          // et la réduction de bruit + AGC nettoient une voix de près.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.cb.onError(`micro refusé : ${(err as Error).message}`);
      return false;
    }

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // On demande 16 kHz ; si le navigateur impose un autre débit, le worklet
    // rééchantillonne quand même (il lit le `sampleRate` réel).
    this.ctx = new Ctor({ sampleRate: 16000, latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      this.cb.onError(`worklet audio indisponible : ${(err as Error).message}`);
      await this.stop();
      return false;
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder');
    this.node.port.onmessage = (e) => {
      const pcm = e.data as Int16Array;
      this.reportLevel(pcm);
      if (!this._sending) return;
      this.cb.onChunk(int16ToBase64(pcm));
    };
    this.source.connect(this.node);
    // Le node doit être « tiré » par le graphe : on le relie à la sortie. Il n'écrit
    // rien dans ses buffers de sortie → silence (aucun larsen).
    this.node.connect(this.ctx.destination);
    this._active = true;
    return true;
  }

  /** Crête sur la période (pas moyenne : c'est la parole qu'on veut voir). */
  private reportLevel(pcm: Int16Array): void {
    if (!this.cb.onLevel && !this.cb.onFrame) return;
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > peak) peak = v;
    }
    this.cb.onFrame?.(peak / 32768);
    if (!this.cb.onLevel) return;
    if (peak > this.peakAcc) this.peakAcc = peak;
    const now = Date.now();
    if (now - this.lastLevelMs < LEVEL_PERIOD_MS) return;
    this.lastLevelMs = now;
    this.cb.onLevel(this.peakAcc / 32768, this._sending);
    this.peakAcc = 0;
  }

  async stop(): Promise<void> {
    this._active = false;
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** Int16Array → base64 (par tranches pour ne pas exploser la pile d'arguments). */
function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
