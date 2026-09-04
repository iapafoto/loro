import './style.css';
import { FaceState, REST_FACE } from './face/faceState';
import { FaceRenderer } from './face/faceRenderer';
import { startAutoBlink } from './face/expressions';
import { LiveConversation } from './agent/live';
import { TutorDispatcher, type TutorHandlers, type SessionSummary } from './agent/dispatcher';
import { assembleSystemInstruction } from './tutor/persona';
import { compileBriefing } from './tutor/briefing';
import { Store } from './learn/store';
import { newSession, type Notebook, type SessionRecord } from './learn/types';
import { loadSettings, saveSettings } from './settings';
import { loadGeminiKey, saveGeminiKey } from './agent/apiKey';
import { buildExport, downloadExport, parseImport, applyImport } from './learn/export';
import { App } from './ui/app';
import { setupPwa } from './pwa';

// --- Visage ------------------------------------------------------------------
const faceCanvas = document.getElementById('face') as HTMLCanvasElement;
const face = new FaceState();
const renderer = new FaceRenderer(faceCanvas, face);
renderer.start();
startAutoBlink(face);

// --- État ---------------------------------------------------------------------
const store = new Store();
let settings = loadSettings();
let nb: Notebook = store.getNotebook();
let currentSession: SessionRecord | null = null;

const { key: geminiKey, source: keySource } = loadGeminiKey();

// --- Métrique de temps de parole (VAD locale minimale, PLAN §4) --------------
//
// Bien plus léger que la LocalVad de Mochi : ici on ne pilote pas un robot, on
// COMPTE seulement — combien de temps l'élève a parlé, en combien de tours. Un
// simple seuil avec rémanence suffit (téléphone en main, voix de près).
class SpeechMeter {
  private static readonly THRESHOLD = 0.05;
  private static readonly HANGOVER_MS = 400;
  private static readonly MIN_TURN_MS = 400;
  private speaking = false;
  private startMs = 0;
  private lastLoudMs = 0;
  totalMs = 0;
  turns = 0;

  reset(): void {
    this.speaking = false;
    this.totalMs = 0;
    this.turns = 0;
  }
  push(peak: number): void {
    const now = Date.now();
    if (peak > SpeechMeter.THRESHOLD) {
      if (!this.speaking) {
        this.speaking = true;
        this.startMs = now;
      }
      this.lastLoudMs = now;
    } else if (this.speaking && now - this.lastLoudMs > SpeechMeter.HANGOVER_MS) {
      this.close();
    }
  }
  flush(): void {
    if (this.speaking) this.close();
  }
  private close(): void {
    const dur = this.lastLoudMs - this.startMs;
    this.speaking = false;
    if (dur >= SpeechMeter.MIN_TURN_MS) {
      this.totalMs += dur;
      this.turns++;
    }
  }
}
const meter = new SpeechMeter();
let tutorSpeaking = false;

// Accueil (un seul par séance) et conclusion (bilan de fin déclenché par Stop).
let greeted = false;
let concluding = false;
let concludeFallback = 0;
const CONCLUDE_FALLBACK_MS = 15000; // si le prof n'appelle pas fin_de_seance, on ferme quand même

// --- Synchro labiale ---------------------------------------------------------
//
// La bouche suit l'ENVELOPPE de la voix réellement jouée (RMS lu sur le graphe
// audio via un AnalyserNode, cf. voicePlayer.currentLevel), image par image. Fini
// l'ouverture aléatoire « fait semblant » : la bouche est calée sur le son.
let mouthRAF = 0;
function startMouthSync(): void {
  if (mouthRAF) return;
  const tick = () => {
    const lvl = live?.voiceLevel() ?? 0;
    // RMS de parole ~0.05..0.3 après le gain de compensation → ouverture bornée.
    // tau court (0.04 s) : la bouche colle au son sans trembler entre deux images.
    const open = Math.min(0.72, REST_FACE.mouthOpen + lvl * 2.4);
    face.setChannel('mouthOpen', open, 0.04);
    mouthRAF = requestAnimationFrame(tick);
  };
  mouthRAF = requestAnimationFrame(tick);
}
function stopMouthSync(): void {
  if (mouthRAF) {
    cancelAnimationFrame(mouthRAF);
    mouthRAF = 0;
  }
  face.setChannel('mouthOpen', REST_FACE.mouthOpen, 0.12);
}

// --- Dispatcher (outils du prof → carnet / écran / visage) -------------------
const handlers: TutorHandlers = {
  noteErreur: (e) => {
    currentSession?.errors.push({ ...e, ts: Date.now() });
    persist();
  },
  noteMot: (w) => {
    currentSession?.words.push({ ...w, ts: Date.now() });
    persist();
  },
  noteReussite: (quoi) => {
    currentSession?.successes.push({ quoi, ts: Date.now() });
    persist();
  },
  ecris: (x) => app.showBoard(x),
  corrige: (c) => app.showCorrection(c),
  evaluate: (s) => {
    currentSession?.scores.push({ ...s, ts: Date.now() });
    app.setGauge(s);
    persist();
  },
  finDeSeance: (f) => onFinDeSeance(f),
};
const dispatcher = new TutorDispatcher(face, handlers);

// --- Session Live ------------------------------------------------------------
let live: LiveConversation | null = null;
if (geminiKey) {
  live = new LiveConversation(geminiKey, {
    onStatus: (status, detail) => {
      app.setStatus(status, detail);
      if (status === 'idle' || status === 'error') {
        clearConclusion();
        endSession(); // sauvegarde les métriques si la séance n'a pas été clôturée par le prof
      }
    },
    onUserText: (t) => {
      app.addLine('user', t);
      countNewWords(t);
    },
    onTutorText: (t) => app.addLine('tutor', t),
    onSpeakingChange: (sp) => {
      tutorSpeaking = sp;
      if (sp) {
        startMouthSync();
        meter.flush(); // le prof prend la parole : on clôt le tour de l'élève
      } else {
        stopMouthSync();
      }
    },
    onMicLevel: (peak, sending) => app.setMicLevel(peak, sending),
    onMicFrame: (peak) => {
      // On ne compte le temps de parole que quand le prof se TAIT : sinon sa propre
      // voix (que le micro entend malgré l'annulation d'écho) gonflerait le compteur.
      if (!tutorSpeaking) meter.push(peak);
    },
    onStalled: (reason) => console.warn('[loro] voix débloquée :', reason),
    onResumed: () => console.info('[loro] session reprise (au-delà du plafond ~15 min)'),
    onReady: () => {
      // La session est prête. On fait parler le prof EN PREMIER pour l'accueil —
      // mais une seule fois par séance : `onReady` refire à chaque reprise (~15 min),
      // et on ne veut re-saluer qu'à la première ouverture.
      if (greeted) return;
      greeted = true;
      live?.notify(
        "la séance commence. Accueille l'élève chaleureusement EN ANGLAIS, une à deux phrases. "
          + "Si sa fiche montre une réussite de la dernière fois, ouvre dessus pour l'encourager "
          + '(sans réciter la fiche ni parler de tes outils). Puis lance la conversation par une '
          + 'question ouverte.',
      );
    },
    dispatch: (call) => dispatcher.dispatch(call),
  });
}

// --- Interface ---------------------------------------------------------------
const app = new App({
  root: document.getElementById('app') as HTMLElement,
  store,
  settings,
  buildId: __BUILD_ID__,
  hasKey: !!geminiKey,
  keySource,
  callbacks: {
    onStartStop: () => {
      if (!live?.active) {
        void startLive();
      } else if (!concluding) {
        requestConclusion(); // 1er Stop : on demande un bilan avant de fermer
      } else {
        void hardStop(); // 2e Stop : arrêt immédiat (échappatoire)
      }
    },
    onScenarioChange: (id) => {
      settings = { ...settings, scenario: id };
      saveSettings(settings);
    },
    onSettingsChange: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      if (patch.voice) void live?.setVoice(patch.voice);
      if (patch.silenceMs) void live?.setSilenceMs(patch.silenceMs);
    },
    onProfileChange: (id) => {
      store.setActive(id);
      nb = store.getNotebook();
      app.refreshNotebook();
    },
    onAddProfile: (name) => {
      const p = store.addProfile(name);
      store.setActive(p.id);
      nb = store.getNotebook();
      app.setSettings(settings); // re-render du panneau réglages (nouvelle liste de profils)
    },
    onKeyChange: (key) => {
      // L'agent Live est construit UNE fois à partir de la clé : la seule façon
      // honnête de la changer à chaud est de recharger (ça ferme aussi une session
      // ouverte avec l'ancienne clé). Repris de Mochi.
      saveGeminiKey(key);
      location.reload();
    },
    onExport: () => downloadExport(buildExport(store, settings)),
    onImportFile: (file) => void importFile(file),
    onWordTap: (word) => {
      if (word && live?.active) {
        live.notify(`l'élève vient de taper le mot « ${word} » à l'écran : écris-le au tableau avec sa traduction (ecris), et note-le (note_mot)`);
      }
    },
    onClearNotebook: () => {
      store.clearNotebook();
      nb = store.getNotebook();
      app.refreshNotebook();
    },
  },
});

// --- Cycle de séance ---------------------------------------------------------

/** Construit le system prompt du jour : persona + scénario + fiche élève (briefing). */
function buildSystem(): string {
  nb = store.getNotebook();
  const fiche = compileBriefing(nb, { profileName: store.getActiveProfile().name, job: settings.job });
  return assembleSystemInstruction({ scenario: settings.scenario, ficheEleve: fiche });
}

async function startLive(): Promise<void> {
  if (!live) {
    app.setStatus('error', 'ajoute ta clé Gemini');
    app.showScreen('reglages');
    return;
  }
  if (live.active) return;
  nb = store.getNotebook();
  currentSession = newSession(settings.scenario);
  nb.sessions.push(currentSession);
  persist();
  meter.reset();
  greeted = false; // l'accueil (onReady) resalue à la première ouverture de CETTE séance
  clearConclusion();
  void keepAwake();
  await live.start(buildSystem());
}

/** 1er Stop : on demande au prof un bilan de fin avant de fermer (PLAN §3). */
function requestConclusion(): void {
  if (!live?.active || concluding) return;
  concluding = true;
  app.setConcluding(true);
  live.notify(
    "l'élève souhaite s'arrêter maintenant : fais un bilan COURT et encourageant (fin_de_seance), "
      + 'le bravo d’abord, puis dis-lui au revoir en une phrase.',
  );
  // Filet : si le prof n'appelle pas fin_de_seance, on ferme quand même.
  concludeFallback = window.setTimeout(() => void hardStop(), CONCLUDE_FALLBACK_MS);
}

/** Arrêt immédiat (échappatoire, ou fin du décompte de secours). */
async function hardStop(): Promise<void> {
  clearConclusion();
  await live?.stop(); // déclenche onStatus('idle') → endSession
}

function clearConclusion(): void {
  concluding = false;
  if (concludeFallback) {
    clearTimeout(concludeFallback);
    concludeFallback = 0;
  }
}

function onFinDeSeance(f: SessionSummary): void {
  const s = finalizeSession(f);
  clearConclusion();
  app.refreshNotebook();
  if (s) app.showBilan(f, s);
  // Laisse la voix finir ses derniers mots (l'au revoir), puis referme proprement.
  window.setTimeout(() => {
    if (live?.active) void live.stop();
  }, 6000);
}

/** Termine la séance en cours SANS bilan (arrêt manuel, coupure). */
function endSession(): void {
  finalizeSession();
}

/** Écrit les métriques finales, marque la séance terminée, la détache. Rend la
 * séance clôturée (ou null si aucune n'était en cours). */
function finalizeSession(summary?: SessionSummary): SessionRecord | null {
  if (!currentSession) return null;
  meter.flush();
  currentSession.endedAt = Date.now();
  currentSession.spokenMs = meter.totalMs;
  currentSession.turns = meter.turns;
  if (summary) {
    currentSession.resume = summary.resume;
    currentSession.aTravailler = summary.aTravailler;
    currentSession.bravo = summary.bravo;
  }
  persist();
  const s = currentSession;
  currentSession = null;
  return s;
}

function persist(): void {
  store.save(nb);
}

/** Compte les mots produits pour la PREMIÈRE fois (métrique §4). */
function countNewWords(text: string): void {
  if (!currentSession) return;
  const known = new Set(nb.producedWords);
  for (const raw of text.toLowerCase().split(/[^\p{L}'’-]+/u)) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    if (w.length < 2 || known.has(w)) continue;
    known.add(w);
    nb.producedWords.push(w);
    currentSession.newWords?.push(w);
  }
  persist();
}

async function importFile(file: File): Promise<void> {
  try {
    const bundle = parseImport(await file.text());
    const importedSettings = applyImport(store, bundle);
    if (importedSettings) {
      settings = importedSettings;
      saveSettings(settings);
    }
    nb = store.getNotebook();
    app.setSettings(settings);
    app.refreshNotebook();
    app.setStatus('idle', undefined);
  } catch (e) {
    alert(`Import impossible : ${(e as Error).message}`);
  }
}

/** Screen Wake Lock — évite la veille pendant une séance. */
async function keepAwake(): Promise<void> {
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request('screen');
  } catch {
    /* non critique */
  }
}

// --- Démarrage ---------------------------------------------------------------
app.setStatus('idle'); // affiche « prêt » ou « ajoute ta clé » dès l'ouverture
setupPwa({ log: (line) => console.info('[loro]', line) });

// Premier contact avec l'écran : débloque l'audio (politique d'autoplay). La séance,
// elle, démarre sur le bouton « Parler » — un geste explicite, choisi (PLAN §4).
window.addEventListener(
  'pointerdown',
  () => {
    const hint = document.getElementById('wake');
    if (hint) hint.hidden = true;
  },
  { once: true },
);

console.info('[loro] prêt — build', __BUILD_ID__, '· clé Gemini :', keySource);
