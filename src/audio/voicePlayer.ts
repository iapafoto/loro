// Lecture en flux de la voix de Mochi.
//
// Gemini Live renvoie la voix en morceaux base64 (PCM 16 bits mono @ 24 kHz). On
// les joue sans trou en chaînant des AudioBufferSourceNode sur une horloge
// (`nextTime`). Sait tout couper net (barge-in du modèle ou réflexe « stop »
// local) et signale quand Mochi parle — pour animer la bouche et couper le micro.

const OUTPUT_RATE = 24000;
/**
 * Marge du chien de garde apres la fin THEORIQUE de l'audio programme (cf.
 * armWatchdog). Large : on ne veut surtout pas couper une voix qui parle encore,
 * seulement rattraper un evenement de fin qui ne viendra jamais.
 */
const WATCHDOG_MARGIN_MS = 700;

const OFF_HANGOVER_MS = 140; // évite le clignotement parle/écoute entre 2 morceaux, sans trop retarder la reprise du micro
const MAKEUP_GAIN = 3.0; // le PCM de Gemini n'est pas à pleine échelle → on remonte (limiteur derrière)
/**
 * Drive FIXE placé juste avant le limiteur (après le gain de compensation). Il
 * pousse le signal (déjà bas côté Gemini) contre le plafond du limiteur → un niveau
 * de sortie fort ET constant, indispensable car le flux « voix » d'Android
 * (haut-parleur imposé par le micro actif) n'est pas piloté par les boutons du
 * téléphone. Le RÉGLAGE de volume, lui, est APRÈS le limiteur (cf. setVolume) : c'est
 * la seule position qui donne une atténuation proportionnelle. Mettre le volume AVANT
 * le limiteur ne marche pas — le limiteur ré-écrase tout au plafond, d'où un curseur
 * « tout ou rien » (fort si >0, coupé si 0).
 */
const DRIVE_GAIN = 4.0;

/**
 * Anti-clic (les « bips » hérités du player Mochi). Un buffer PCM qui démarre sur
 * une valeur non nulle claque. Ça arrive au DÉBUT d'une salve de voix — la première
 * fois, ou après un trou quand un chunk réseau tarde. On lisse de deux façons :
 *   • START_LEAD_S : un petit coussin avant de jouer le premier chunk d'une salve,
 *     pour que les suivants aient le temps d'arriver sans sous-alimenter le flux
 *     (moins de trous, donc moins de clics) — quelques dizaines de ms, inaudible.
 *   • DECLICK_S : un fondu d'attaque de quelques ms sur ce premier chunk, qui tue le
 *     claquement résiduel.
 * EN COURS de salve, les chunks sont contigus échantillon à échantillon : on n'y
 * touche pas (un fondu y creuserait un trou à chaque jointure).
 */
const START_LEAD_S = 0.06;
const DECLICK_S = 0.005;

export interface VoicePlayerCallbacks {
  /** true dès qu'un morceau est planifié, false quand la file se vide (après hangover). */
  onSpeaking(speaking: boolean): void;
  /** Amplitude crête 0..1 du dernier morceau (anime la bouche). */
  onLevel?(level: number): void;
  /**
   * Par où sort la voix, une fois `resume()` tranché. `viaElement = false` sur
   * Android veut dire volume d'appel : c'est la cause n°1 de « Mochi ne parle pas
   * fort », et sans ce rapport elle est INVISIBLE — le son sort quand même.
   */
  onRoute?(viaElement: boolean, detail: string): void;
  /**
   * Le chien de garde a dû forcer le retour à l'écoute (cf. armWatchdog). À
   * journaliser : c'est le seul témoin d'un blocage qui, sans lui, rendait Mochi
   * sourd sans laisser la moindre trace.
   */
  onStalled?(reason: string): void;
}

export class VoicePlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null; // compensation FIXE, alimente l'analyseur (lip-sync stable)
  private volumeGain: GainNode | null = null; // volume utilisateur, APRÈS le limiteur → atténuation proportionnelle
  private volume = 1; // 0..1, piloté par le réglage in-app (cf. setVolume)
  private tail: AudioNode | null = null; // dernier nœud avant la sortie (limiteur → volume)
  // Enveloppe de la voix EN COURS de lecture, pour la synchro labiale (lip-sync).
  private analyser: AnalyserNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> = new Float32Array(0);
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private sinkEl: HTMLAudioElement | null = null;
  private routedToElement = false; // true si la sortie passe par le <audio> (haut-parleur mobile)
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private speaking = false;
  private offTimer: number | null = null;
  private watchdog: number | null = null;
  private pitch = 1; // >1 = voix plus aiguë (et un peu plus rapide) → effet « bébé »

  constructor(private readonly cb: VoicePlayerCallbacks) {}

  /** Décale la hauteur de la voix (1 = naturelle, 1.1–1.3 = plus aiguë/bébé). */
  setPitch(factor: number): void {
    this.pitch = Math.max(0.5, Math.min(2, factor));
  }

  /**
   * Volume de sortie 0..1, appliqué APRÈS le limiteur : c'est la seule position qui
   * donne une atténuation PROPORTIONNELLE (moitié = moitié, 0 = silence). Le seul
   * réglage de niveau fiable côté mobile, car la voix sort sur le flux « voix »
   * d'Android que les boutons du téléphone ne pilotent pas. Le niveau fort à 1 vient
   * du drive fixe en amont (cf. DRIVE_GAIN). Fondu court pour éviter le clic d'un
   * changement brusque.
   */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.volumeGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.volumeGain.gain.setTargetAtTime(this.volume, now, 0.02);
    }
  }

  /**
   * Niveau instantané (RMS 0..1) du son EN COURS de lecture — pour caler la bouche
   * sur la voix (lip-sync). Lu sur le graphe audio via un AnalyserNode : c'est
   * exactement le signal que le lecteur émet à cet instant, pas la crête d'un chunk
   * déjà passé. Rend 0 quand rien ne joue (le graphe est silencieux au repos).
   */
  currentLevel(): number {
    const a = this.analyser;
    if (!a) return 0;
    if (this.levelBuf.length !== a.fftSize) this.levelBuf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    return Math.sqrt(sum / this.levelBuf.length);
  }

  /** À appeler dans un geste utilisateur pour autoriser l'audio. */
  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;

    // IMPORTANT : démarrer le <audio> element AVANT tout `await`, pendant qu'on
    // est encore dans la fenêtre synchrone du geste utilisateur. Une capture
    // micro (getUserMedia) active fait basculer Android sur le flux « voice
    // communication » (volume d'appel, faible) pour l'AudioContext. Jouer via un
    // HTMLAudioElement le remet sur le flux « média » (STREAM_MUSIC), fort, comme
    // une vidéo. On garde ctx.destination en repli tant que l'élément ne joue pas.
    if (this.sinkEl && !this.routedToElement) {
      const play = this.sinkEl.play();
      if (play) {
        play
          .then(() => {
            this.tail?.disconnect(ctx.destination); // évite le double son
            this.routedToElement = true;
            this.cb.onRoute?.(true, `sortie via <audio> (flux média) @ ${Math.round(ctx.sampleRate)} Hz`);
          })
          .catch((e: Error) => {
            // Repli sur ctx.destination. ⚠️ CE REPLI EST SILENCIEUX ET C'EST SON
            // DÉFAUT : le son sort quand même, simplement sur le flux communication
            // d'Android — volume d'appel, donc faible. Rien ne casse, rien ne
            // s'affiche, et on cherche du côté du micro ou du modèle. D'où ce
            // rapport : c'est la seule façon de savoir, depuis le téléphone, quel
            // chemin a gagné.
            this.cb.onRoute?.(false, `<audio> refusé (${e.name}) — repli AudioContext @ ${Math.round(ctx.sampleRate)} Hz`);
          });
      } else {
        this.cb.onRoute?.(false, 'play() sans promesse — repli AudioContext');
      }
    } else if (!this.sinkEl) {
      this.cb.onRoute?.(false, 'pas de MediaStreamDestination — repli AudioContext');
    }

    if (ctx.state === 'suspended') await ctx.resume();
  }

  enqueue(base64Pcm24: string): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const pcm = base64ToInt16(base64Pcm24);
    if (pcm.length === 0) return;

    const buf = ctx.createBuffer(1, pcm.length, OUTPUT_RATE);
    const ch = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768;
      ch[i] = v;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this.pitch; // aigu = lecture plus rapide

    // Début d'une salve (rien en cours, ou flux sous-alimenté) → coussin + fondu
    // d'attaque, pour supprimer le clic de démarrage (cf. START_LEAD_S / DECLICK_S).
    const salveStart = this.nextTime <= ctx.currentTime;
    const start = salveStart ? ctx.currentTime + START_LEAD_S : this.nextTime;
    if (salveStart) {
      const declick = ctx.createGain();
      declick.gain.setValueAtTime(0.0001, start);
      declick.gain.linearRampToValueAtTime(1, start + DECLICK_S);
      src.connect(declick);
      declick.connect(this.gain!);
    } else {
      src.connect(this.gain!);
    }
    src.start(start);
    this.nextTime = start + buf.duration / this.pitch; // durée réelle = durée / vitesse

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this.markSpeaking(false);
    };

    this.markSpeaking(true);
    this.armWatchdog(ctx);
    this.cb.onLevel?.(peak);
  }

  /**
   * Chien de garde de la parole. Sans lui, « Mochi parle » pouvait rester vrai
   * POUR TOUJOURS, et comme l'envoi micro est coupé pendant qu'il parle, il
   * devenait complètement sourd — jusqu'à ce qu'un barge-in ou le bouton STOP
   * appelle `clear()`. Symptôme vécu : « il ne m'entend plus du tout pendant une
   * à deux minutes », avec l'impression que ce sont les actions qui le coupent
   * (elles arrivent au moment où il parle, d'où la confusion).
   *
   * ⚠️ LA CAUSE EST QUE `speaking` NE RETOMBAIT QUE PAR `src.onended`. Cet
   * événement ne se produit pas si le contexte audio se suspend — écran éteint,
   * appli passée en arrière-plan, bridage du navigateur : les sources programmées
   * ne se terminent jamais, l'ensemble ne se vide pas, et plus rien ne remet le
   * micro en marche. Un seul événement manquant suffisait à le rendre muet aux
   * autres, définitivement.
   *
   * On sait pourtant exactement quand l'audio DOIT être fini : `nextTime`. Passé
   * ce moment plus une marge, si on se croit encore en train de parler, c'est que
   * l'événement s'est perdu — on force le retour à l'écoute.
   */
  private armWatchdog(ctx: AudioContext): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    const remainingMs = Math.max(0, (this.nextTime - ctx.currentTime) * 1000);
    this.watchdog = window.setTimeout(() => {
      this.watchdog = null;
      if (!this.speaking) return;
      // Le contexte suspendu est LE cas pathologique : le temps audio ne s'écoule
      // plus, donc `nextTime` ne sera jamais atteint et aucune source ne finira.
      const stalled = ctx.state !== 'running';
      if (!stalled && ctx.currentTime < this.nextTime - 0.05) {
        this.armWatchdog(ctx); // encore de l'audio devant : on repousse
        return;
      }
      for (const s of this.sources) {
        try {
          s.onended = null;
          s.stop();
        } catch {
          /* déjà terminée */
        }
      }
      this.sources.clear();
      this.nextTime = 0;
      this.speaking = false;
      this.cb.onSpeaking(false);
      this.cb.onLevel?.(0);
      this.cb.onStalled?.(stalled ? `moteur audio « ${ctx.state} »` : 'fin de parole perdue');
    }, remainingMs + WATCHDOG_MARGIN_MS);
  }

  /** Coupe tout immédiatement (barge-in ou réflexe « stop »). */
  clear(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* déjà stoppé */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (this.offTimer !== null) {
      clearTimeout(this.offTimer);
      this.offTimer = null;
    }
    if (this.speaking) {
      this.speaking = false;
      this.cb.onSpeaking(false);
      this.cb.onLevel?.(0);
    }
  }

  async close(): Promise<void> {
    this.clear();
    if (this.sinkEl) {
      try {
        this.sinkEl.pause();
        this.sinkEl.srcObject = null;
        this.sinkEl.remove();
      } catch {
        /* déjà libéré */
      }
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.ctx = null;
    this.gain = null;
    this.volumeGain = null;
    this.tail = null;
    this.analyser = null;
    this.streamDest = null;
    this.sinkEl = null;
    this.routedToElement = false;
  }

  private markSpeaking(on: boolean): void {
    if (on) {
      if (this.offTimer !== null) {
        clearTimeout(this.offTimer);
        this.offTimer = null;
      }
      if (!this.speaking) {
        this.speaking = true;
        this.cb.onSpeaking(true);
      }
      return;
    }
    // Passage à « ne parle plus » différé : un nouveau morceau peut arriver.
    if (this.offTimer !== null) return;
    this.offTimer = window.setTimeout(() => {
      this.offTimer = null;
      if (this.sources.size === 0 && this.speaking) {
        this.speaking = false;
        this.cb.onSpeaking(false);
        this.cb.onLevel?.(0);
      }
    }, OFF_HANGOVER_MS);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    // Contexte forcé au débit de Gemini (24 kHz). SINON le contexte tourne au débit
    // natif (souvent 48 kHz) et CHAQUE chunk est rééchantillonné indépendamment :
    // l'interpolation repart à zéro à chaque buffer, semant une micro-discontinuité
    // à chaque jointure → un grain/bip « type buffer » pendant la parole que le
    // fondu d'attaque (anti-clic de début) ne peut pas rattraper. À 24 kHz, les
    // buffers jouent échantillon pour échantillon : jointures parfaites, plus de bip.
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive', sampleRate: OUTPUT_RATE });
    } catch {
      // Débit refusé par le navigateur : on retombe sur le natif (rééchantillonné).
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    }

    this.gain = this.ctx.createGain();
    this.gain.gain.value = MAKEUP_GAIN;

    // Limiteur : empêche la saturation quand on pousse le gain de compensation.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    // Analyseur inséré EN LIGNE, juste après la compensation FIXE (gain → analyseur) :
    // le lip-sync voit un niveau stable, indépendant du curseur de volume (sinon la
    // bouche rétrécirait quand on baisse le son). Il est toujours « tiré » par le
    // graphe, quel que soit le routage de sortie.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512; // ~10 ms de fenêtre : assez fin pour l'enveloppe
    this.analyser.smoothingTimeConstant = 0; // on lisse via le tau du visage, pas ici
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);

    // Drive FIXE : pousse le signal contre le plafond du limiteur → niveau fort et
    // constant. Après l'analyseur pour ne pas fausser le lip-sync.
    const drive = this.ctx.createGain();
    drive.gain.value = DRIVE_GAIN;
    this.analyser.connect(drive);
    drive.connect(limiter);

    // Volume utilisateur, APRÈS le limiteur : atténuation proportionnelle jusqu'au
    // silence (à 1 = plein niveau limité, donc fort).
    this.volumeGain = this.ctx.createGain();
    this.volumeGain.gain.value = this.volume;
    limiter.connect(this.volumeGain);
    this.tail = this.volumeGain;

    // Chemin direct (repli, actif par défaut). resume() bascule vers le <audio>
    // element s'il parvient à jouer (haut-parleur mobile au lieu de l'écouteur).
    this.volumeGain.connect(this.ctx.destination);
    try {
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.volumeGain.connect(this.streamDest);
      const el = new Audio();
      el.autoplay = true;
      el.volume = 1;
      (el as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
      el.srcObject = this.streamDest.stream;
      // Attaché au DOM (invisible) : certains Android ne routent l'élément vers
      // le flux « média » que s'il fait partie du document.
      el.style.display = 'none';
      document.body.appendChild(el);
      this.sinkEl = el;
    } catch {
      /* MediaStreamDestination indisponible : on reste sur ctx.destination */
    }
    return this.ctx;
  }
}

/** base64 → Int16Array (little-endian), sur un buffer propre et aligné. */
function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  const len = n >> 1; // 2 octets par échantillon
  const out = new Int16Array(len);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < len; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}
