// Conversation vocale Live — le cœur de Loro.
//
// Session Gemini Live en modalité AUDIO (gemini-3.1-flash-live-preview) :
//   micro streamé (PCM 16 kHz)  →  session  →  voix du prof (PCM 24 kHz) jouée en
//   flux, + function calls (carnet / tableau / jauge / visage) dispatchés en //.
//
// Repris de Mochi (live.ts) mais ALLÉGÉ (téléphone en main, cf. mic.ts) : plus de
// portillons micro, de blips, de gain logiciel. Ce qui est AJOUTÉ, en revanche, est
// la seule chose vraiment neuve du socle audio : la REPRISE DE SESSION (PLAN §1b),
// pour qu'une conversation traverse le plafond des ~15 min sans que ça se voie.

import { GoogleGenAI, type Session, type LiveServerMessage } from '@google/genai';
import { LIVE_MODEL, liveSessionConfig } from './liveConfig';
import { toGeminiTools, type ToolCall } from './tutorTools';
import { MicCapture } from '../audio/mic';
import { VoicePlayer } from '../audio/voicePlayer';

/** Voix préfabriquées du modèle Live (un sous-ensemble amical parmi les ~30). Un
 * prof doit sonner natif : pitch laissé à 1.0 (défaut de VoicePlayer). */
export const LIVE_VOICES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'Achird', label: 'Achird — amical' },
  { name: 'Puck', label: 'Puck — enjoué' },
  { name: 'Charon', label: 'Charon — posé' },
  { name: 'Kore', label: 'Kore — clair' },
  { name: 'Aoede', label: 'Aoede — doux' },
  { name: 'Fenrir', label: 'Fenrir — énergique' },
];

/** Voix par défaut : Achird (amical) — cf. PLAN §2. */
export const DEFAULT_VOICE = 'Achird';

/**
 * Combien de temps AVANT la fermeture annoncée par `goAway` on rouvre la session.
 * On veut que la nouvelle soit prête pendant que l'ancienne parle encore, pour que
 * le trou soit court — mais pas trop tôt, sinon on rouvre pour rien.
 */
const RECONNECT_MARGIN_MS = 3000;

/** Plafond du tampon micro pendant le trou de reprise (~10 s @ 40 ms/paquet). */
const MAX_MIC_BUFFER = 260;

export type LiveStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

export interface LiveConversationCallbacks {
  onStatus(status: LiveStatus, detail?: string): void;
  /** Transcription de ce que dit l'élève (micro). */
  onUserText(text: string): void;
  /** Transcription de ce que dit le prof (voix). */
  onTutorText(text: string): void;
  /** Le prof commence/arrête de parler (bouche + gating micro). */
  onSpeakingChange?(speaking: boolean): void;
  /** Amplitude 0..1 de la voix (anime la bouche). */
  onLevel?(level: number): void;
  /** Chemin de sortie audio retenu (diagnostic du volume Android, cf. VoicePlayer). */
  onRoute?(viaElement: boolean, detail: string): void;
  /** Niveau crête du micro (0..1) et si le paquet part vraiment. */
  onMicLevel?(peak: number, sending: boolean): void;
  /** Niveau crête de chaque paquet (~40 ms), non lissé — détection de parole locale. */
  onMicFrame?(peak: number): void;
  /** La lecture de la voix s'est bloquée et le chien de garde l'a débloquée. */
  onStalled?(reason: string): void;
  /**
   * La session est PRÊTE (`setupComplete` reçu). Fire à chaque ouverture, reprise
   * comprise : c'est le seul moment où l'on peut envoyer un tour client (ex. faire
   * parler le prof EN PREMIER pour l'accueil). L'appelant dédoublonne s'il ne veut
   * agir qu'à la première ouverture (cf. le greeting dans main.ts).
   */
  onReady?(): void;
  /** Une reprise de session vient d'avoir lieu (au-delà du plafond de ~15 min). */
  onResumed?(): void;
  /**
   * Un function call du prof → effet (carnet / tableau / jauge / visage). Le retour
   * repart vers le MODÈLE comme réponse d'outil.
   */
  dispatch(call: ToolCall): { ok: boolean; detail: string } | void;
}

export class LiveConversation {
  private readonly tools = toGeminiTools();
  private readonly mic: MicCapture;
  private readonly player: VoicePlayer;
  private session: Session | null = null;
  private stopping = false;
  private voice = DEFAULT_VOICE;
  private silenceMs: number | undefined;
  private systemInstruction = ''; // mémorisé pour relancer sur changement de voix

  /**
   * Génération de session : chaque `connect` l'incrémente, et les callbacks d'une
   * session ne s'exécutent que si elle est encore la courante. C'est ce qui permet
   * de fermer l'ANCIENNE session pendant une reprise sans que son `onclose` soit
   * pris pour une panne (elle a une génération périmée).
   */
  private gen = 0;

  // Reprise de session (PLAN §1b).
  private resumeHandle: string | undefined;
  private reconnecting = false;
  private reconnectTimer: number | null = null;
  private micBuffer: string[] = [];

  // Accumulateurs de transcription (vidés à chaque fin de tour).
  private inBuf = '';
  private outBuf = '';
  private userFlushed = false;

  constructor(
    private readonly apiKey: string,
    private readonly cb: LiveConversationCallbacks,
  ) {
    this.player = new VoicePlayer({
      onSpeaking: (sp) => {
        this.mic.setSending(!sp); // on ne s'écoute pas parler
        this.cb.onSpeakingChange?.(sp);
        if (this.session && !this.reconnecting) this.cb.onStatus(sp ? 'speaking' : 'listening');
      },
      onLevel: (lvl) => this.cb.onLevel?.(lvl),
      onRoute: (viaElement, detail) => this.cb.onRoute?.(viaElement, detail),
      onStalled: (reason) => {
        this.mic.setSending(true);
        this.cb.onStalled?.(reason);
      },
    });
    this.mic = new MicCapture({
      onChunk: (b64) => this.sendMic(b64),
      onError: (m) => this.fail(m),
      onLevel: (peak, sending) => this.cb.onMicLevel?.(peak, sending),
      onFrame: (peak) => this.cb.onMicFrame?.(peak),
    });
  }

  get active(): boolean {
    return this.session !== null;
  }

  /** Change la voix (figée à la connexion) : relance la conversation si elle tourne. */
  async setVoice(name: string): Promise<void> {
    if (name === this.voice) return;
    this.voice = name;
    await this.relaunch();
  }

  /** Volume de la voix du prof (0..1) — appliqué à chaud, aucune relance. */
  setVolume(v: number): void {
    this.player.setVolume(v);
  }

  /** Change le seuil de fin de parole (figé à la connexion) : relance si elle tourne. */
  async setSilenceMs(ms: number): Promise<void> {
    if (ms === this.silenceMs) return;
    this.silenceMs = ms;
    await this.relaunch();
  }

  private async relaunch(): Promise<void> {
    if (!this.session) return;
    const sys = this.systemInstruction;
    await this.stop();
    await this.start(sys);
  }

  /** Ouvre une NOUVELLE conversation (contexte frais). `systemInstruction` = fiche du jour. */
  async start(systemInstruction: string): Promise<void> {
    if (this.session) return;
    this.stopping = false;
    this.reconnecting = false;
    this.resumeHandle = undefined; // nouvelle conversation : pas de reprise
    this.micBuffer = [];
    this.systemInstruction = systemInstruction;
    this.cb.onStatus('connecting');
    await this.player.resume(); // dans le geste utilisateur (clic « démarrer »)

    if (!(await this.connect())) return;

    const micOk = await this.mic.start();
    if (!micOk) {
      await this.stop();
      return;
    }
    if (this.session) this.cb.onStatus('listening');
  }

  /**
   * Ouvre une session (fraîche ou reprise selon `this.resumeHandle`) et l'installe
   * comme session courante. Rend false en cas d'échec (déjà signalé).
   */
  private async connect(): Promise<boolean> {
    const myGen = ++this.gen;
    try {
      const ai = new GoogleGenAI({ apiKey: this.apiKey });
      const session = await ai.live.connect({
        model: LIVE_MODEL,
        callbacks: {
          onmessage: (m) => {
            if (myGen !== this.gen) return; // session périmée (reprise en cours)
            this.handle(m);
          },
          onerror: (e) => {
            if (myGen !== this.gen) return;
            this.fail(e.message || 'erreur de session');
          },
          // ⚠️ UNE SESSION QUI MEURT TOUTE SEULE DOIT LE DIRE (leçon de Mochi). Ce
          // n'est PAS un arrêt volontaire : le serveur a fermé la socket. Sans ce
          // message, écran muet et micro coupé, indiscernables d'un prof devenu
          // sourd. On distingue la fermeture d'une session périmée (reprise réussie,
          // silencieuse) de celle de la session courante (vraie coupure à signaler).
          onclose: (e) => {
            if (myGen !== this.gen || this.stopping) return;
            const why = [e?.code, (e?.reason ?? '').trim()].filter(Boolean).join(' ');
            void this.teardown('error', `session fermée par le serveur${why ? ` (${why})` : ''}`);
          },
        },
        config: liveSessionConfig(this.systemInstruction, this.voice, this.tools, {
          resumeHandle: this.resumeHandle,
          silenceMs: this.silenceMs,
        }),
      });
      this.session = session;
      return true;
    } catch (err) {
      this.fail(`connexion Live échouée : ${(err as Error).message}`);
      return false;
    }
  }

  /** Ferme proprement (arrêt volontaire). */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.teardown('idle');
  }

  /**
   * Dit au modèle ce qui vient de changer, sans que ce soit un tour de l'élève —
   * canal de « régie » (ex. « [[il reste une minute, propose de conclure]] »).
   * Encadré par [[ ]] : le persona sait que ce n'est pas quelqu'un qui parle.
   */
  notify(text: string): void {
    if (!this.session) return;
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `[[${text}]]` }] }],
      turnComplete: true,
    });
  }

  /** Coupe la voix immédiatement (barge-in local). */
  stopReflex(): void {
    this.player.clear();
  }

  /** Niveau instantané (RMS 0..1) de la voix en cours de lecture — synchro labiale. */
  voiceLevel(): number {
    return this.player.currentLevel();
  }

  // --- Reprise de session (PLAN §1b) -----------------------------------------

  private sendMic(b64: string): void {
    // Pendant le trou de reprise, on TAMPONNE au lieu d'envoyer à une session
    // mourante — sinon un mot prononcé pile à ce moment-là est perdu (le plan
    // insiste : « en tamponnant les paquets micro pendant le trou »).
    if (this.reconnecting || !this.session) {
      if (this.micBuffer.length < MAX_MIC_BUFFER) this.micBuffer.push(b64);
      return;
    }
    this.session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
  }

  private scheduleReconnect(timeLeftMs: number): void {
    if (this.reconnectTimer !== null || this.reconnecting || this.stopping) return;
    const delay = Math.max(0, timeLeftMs - RECONNECT_MARGIN_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  /**
   * Rouvre la session avec le handle de reprise, EN GARDANT le micro et le lecteur
   * vivants — c'est le piège que le `teardown()` de Mochi tendait (il tue les deux).
   * On ne remplace que la `Session`, et on rejoue le tampon micro dans la nouvelle.
   */
  private async reconnect(): Promise<void> {
    if (!this.session || this.stopping || this.reconnecting) return;
    if (!this.resumeHandle) return; // pas de point de reprise : on laisse mourir/rattraper par onclose
    this.reconnecting = true;
    const old = this.session;

    const ok = await this.connect(); // ++gen : l'ancienne session est désormais périmée
    if (!ok) {
      this.reconnecting = false;
      return; // fail() déjà appelé
    }

    // Rejoue les paquets micro accumulés pendant le trou, puis reprend l'envoi direct.
    const buffered = this.micBuffer;
    this.micBuffer = [];
    for (const b64 of buffered) {
      this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
    }
    this.reconnecting = false;

    try {
      old.close(); // son onclose est ignoré (génération périmée)
    } catch {
      /* déjà fermée */
    }
    this.cb.onResumed?.();
  }

  // --- Réception --------------------------------------------------------------

  private async teardown(status: LiveStatus, detail?: string): Promise<void> {
    this.gen++; // invalide les callbacks de la session courante
    const s = this.session;
    this.session = null;
    this.reconnecting = false;
    this.micBuffer = [];
    this.inBuf = this.outBuf = '';
    this.userFlushed = false;
    await this.mic.stop();
    await this.player.close();
    try {
      s?.close();
    } catch {
      /* déjà fermée */
    }
    this.cb.onStatus(status, detail);
  }

  private handle(m: LiveServerMessage): void {
    // La session est prête : l'appelant peut désormais envoyer un tour client.
    if (m.setupComplete) this.cb.onReady?.();

    // 0) Reprise de session : mémoriser le dernier handle, anticiper la fermeture.
    const newHandle = m.sessionResumptionUpdate?.newHandle;
    if (newHandle) this.resumeHandle = newHandle;
    if (m.goAway?.timeLeft) this.scheduleReconnect(parseDurationMs(m.goAway.timeLeft));

    // 1) Function calls → effets + réponse d'outil à la volée.
    const fcs = m.toolCall?.functionCalls;
    if (fcs?.length) {
      const results = fcs.map((fc) => ({
        fc,
        outcome: this.cb.dispatch({
          name: fc.name ?? '',
          args: (fc.args ?? {}) as Record<string, unknown>,
        }),
      }));
      this.session?.sendToolResponse({
        functionResponses: results.map(({ fc, outcome }) => ({
          id: fc.id,
          name: fc.name,
          response:
            outcome?.ok === false
              ? { result: 'sans effet', raison: outcome.detail }
              : { result: 'ok', ...(outcome?.detail ? { detail: outcome.detail } : {}) },
        })),
      });
    }

    // 2) Voix du prof (m.data = concat des inlineData audio du message).
    if (typeof m.data === 'string' && m.data.length) this.player.enqueue(m.data);

    // 3) Transcriptions (entrée = élève, sortie = prof).
    const sc = m.serverContent;
    const it = sc?.inputTranscription?.text;
    if (it) this.inBuf += it;
    const ot = sc?.outputTranscription?.text;
    if (ot) {
      if (this.inBuf && !this.userFlushed) {
        this.cb.onUserText(this.inBuf.trim());
        this.userFlushed = true;
      }
      this.outBuf += ot;
    }

    if (sc?.interrupted) this.player.clear(); // barge-in : le prof se tait
    if (sc?.turnComplete) this.flushTurn();
  }

  private flushTurn(): void {
    if (this.inBuf && !this.userFlushed) this.cb.onUserText(this.inBuf.trim());
    if (this.outBuf.trim()) this.cb.onTutorText(this.outBuf.trim());
    this.inBuf = this.outBuf = '';
    this.userFlushed = false;
  }

  private fail(msg: string): void {
    if (this.stopping) return;
    this.stopping = true;
    void this.teardown('error', msg);
  }
}

/** « 10s », « 9.5s », « 500ms » → millisecondes. Défensif : le serveur renvoie une
 * chaîne de durée, pas un nombre. */
function parseDurationMs(d: string): number {
  const s = d.trim();
  const ms = s.match(/^([\d.]+)\s*ms$/);
  if (ms) return Math.round(parseFloat(ms[1]));
  const sec = s.match(/^([\d.]+)\s*s$/);
  if (sec) return Math.round(parseFloat(sec[1]) * 1000);
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
