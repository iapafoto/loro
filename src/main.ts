import './style.css';
import { FaceState, REST_FACE } from './face/faceState';
import { FaceRenderer } from './face/faceRenderer';
import { startAutoBlink } from './face/expressions';
import { LiveConversation } from './agent/live';
import { TutorDispatcher, type TutorHandlers, type SessionSummary } from './agent/dispatcher';
import { assembleSystemInstruction, interlocuteurById, INTERLOCUTEURS, type ScenarioId } from './tutor/persona';
import { compileBriefing } from './tutor/briefing';
import { Store } from './learn/store';
import { newSession, type Notebook, type SessionRecord, type TranscriptEntry } from './learn/types';
import { loadSettings, saveSettings, type Settings } from './settings';
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

// Chien de garde « le prof ne répond pas ». Le modèle peut se taire sans fermer la
// session ni lever d'erreur : micro allumé, mais aucun son, aucune bouche qui bouge,
// et rien à l'écran. On ARME ce guet quand une réponse est attendue (après l'accueil,
// et après chaque tour de l'élève) ; il est DÉSARMÉ dès que le prof produit quoi que
// ce soit. S'il expire, on affiche un bandeau rouge — sinon la panne est invisible.
let responseWatch = 0;
const RESPONSE_TIMEOUT_MS = 14000;
// On n'attend une réponse QUE si un VRAI tour de l'élève vient de se clore. On
// s'appuie sur le compteur de tours de la VAD (SpeechMeter : ≥400 ms de parole,
// ≥400 ms de silence) — pas sur un pic isolé, sinon un bruit ou une respiration
// armait le guet et l'alerte rouge tombait alors que tout allait bien.
let lastTurns = 0;
function armResponseWatch(): void {
  clearResponseWatch();
  responseWatch = window.setTimeout(() => {
    responseWatch = 0;
    if (live?.active && !tutorSpeaking) {
      app.showAlert('Le prof ne répond pas. Vérifie ta connexion, ou appuie sur Stop puis Parler.');
    }
  }, RESPONSE_TIMEOUT_MS);
}
function clearResponseWatch(): void {
  if (responseWatch) {
    clearTimeout(responseWatch);
    responseWatch = 0;
  }
}
/** Le prof a produit quelque chose : la session répond → on désarme et on efface l'alerte. */
function tutorResponded(): void {
  clearResponseWatch();
  app.clearAlert();
}

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
  corrige: (c) => {
    app.showCorrection(c);
    logTranscript('correction', `${c.dit} → ${c.correct}`, c.pourquoi);
  },
  evaluate: (s) => {
    currentSession?.scores.push({ ...s, ts: Date.now() });
    app.setGauge(s);
    if (s.feedback?.trim()) logTranscript('feedback', s.feedback.trim());
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
      if (status === 'error') app.showAlert(detail ? `⚠ ${detail}` : '⚠ La connexion au prof a été coupée. Appuie sur Parler pour reprendre.');
      if (status === 'idle' || status === 'error') {
        clearResponseWatch();
        clearConclusion();
        endSession(); // sauvegarde les métriques si la séance n'a pas été clôturée par le prof
      }
    },
    onUserText: (t) => {
      app.addLine('user', t);
      countNewWords(t);
      logTranscript('user', t);
    },
    onTutorText: (t) => {
      tutorResponded();
      app.addLine('tutor', t);
      logTranscript('tutor', t);
    },
    onSpeakingChange: (sp) => {
      tutorSpeaking = sp;
      if (sp) {
        tutorResponded(); // le prof parle : la session répond bien
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
      // Guet « pas de réponse » : armé UNIQUEMENT quand un vrai tour de l'élève vient
      // de se clore (meter.turns, filtré du bruit). Désarmé dès que le prof répond
      // (tutorResponded). Le silence pur n'arme rien → plus de fausse alerte rouge.
      if (meter.turns > lastTurns) {
        lastTurns = meter.turns;
        if (!tutorSpeaking) armResponseWatch();
      }
    },
    onStalled: (reason) => console.warn('[loro] voix débloquée :', reason),
    onResumed: () => console.info('[loro] session reprise (au-delà du plafond ~15 min)'),
    onReady: () => {
      // La session est prête. On fait parler le prof EN PREMIER pour l'accueil —
      // mais une seule fois par séance : `onReady` refire à chaque reprise (~15 min),
      // et on ne veut re-saluer qu'à la première ouverture.
      if (greeted) return;
      greeted = true;
      live?.notify(interlocuteurById(settings.interlocuteur).accueil);
      armResponseWatch(); // on attend le bonjour du prof

    },
    dispatch: (call) => dispatcher.dispatch(call),
  });
  // ⚠️ APPLIQUER LES RÉGLAGES ENREGISTRÉS AVANT LA PREMIÈRE SÉANCE. Sans ça, la voix
  // et surtout le SEUIL DE SILENCE (temps de réflexion) restaient au défaut tant que
  // l'utilisateur n'avait pas re-touché le curseur — d'où un délai de réponse plus
  // long que réglé à la première conversation. Les setters ne relancent rien ici
  // (aucune session encore ouverte) : ils ne font que mémoriser la valeur.
  void live.setVoice(settings.voice);
  void live.setSilenceMs(settings.silenceMs);
  live.setVolume(settings.volume);
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
    onModeChange: (value) => {
      // Le menu du haut mêle scénarios (partenaire pro) et profs autonomes. Un id
      // d'interlocuteur non-« pro » (prof-anglais, prof-espagnol) sélectionne ce
      // prof en conversation libre ; sinon c'est un scénario, joué par le pro.
      const inter = INTERLOCUTEURS.find((i) => i.id === value && i.id !== 'pro');
      const next: Settings = inter
        ? { ...settings, interlocuteur: inter.id, scenario: 'libre' }
        : { ...settings, interlocuteur: 'pro', scenario: value as ScenarioId };
      if (next.interlocuteur === settings.interlocuteur && next.scenario === settings.scenario) return;
      settings = next;
      saveSettings(settings);
      app.setSettings(settings); // garde le menu en phase
      // ⚠️ CHANGEMENT À CHAUD : le prompt système (persona + langue + scénario) est
      // figé au démarrage d'une session. Pour que le nouvel interlocuteur prenne la
      // main TOUT DE SUITE — nouvelle langue, nouveau bonjour — on réinitialise : on
      // clôt la séance en cours et on en rouvre une fraîche avec le nouveau mode.
      if (live?.active) void restartLive();
    },
    onSettingsChange: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      if (patch.voice) void live?.setVoice(patch.voice);
      if (patch.silenceMs) void live?.setSilenceMs(patch.silenceMs);
      if (patch.volume !== undefined) live?.setVolume(patch.volume);
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
    onScreenChange: (screen) => {
      // Le visage est un shader plein écran, caché derrière les panneaux opaques
      // Carnet/Réglages. On coupe son rendu là-bas pour ne pas saturer le GPU du
      // téléphone (sinon le retour à la conversation traîne). Il reprend ici.
      if (screen === 'conversation') renderer.start();
      else renderer.stop();
    },
  },
});

// --- Cycle de séance ---------------------------------------------------------

/** Construit le system prompt du jour : persona + scénario + fiche élève (briefing). */
function buildSystem(): string {
  nb = store.getNotebook();
  const inter = interlocuteurById(settings.interlocuteur);
  const fiche = compileBriefing(nb, {
    profileName: store.getActiveProfile().name,
    job: settings.job,
    enteteFiche: inter.enteteFiche,
  });
  return assembleSystemInstruction({
    interlocuteur: settings.interlocuteur,
    scenario: settings.scenario,
    ficheEleve: fiche,
  });
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
  clearResponseWatch();
  lastTurns = 0;
  app.clearAlert();
  void keepAwake();
  await live.start(buildSystem());
}

/**
 * Réinitialise la séance en cours et en rouvre une avec le mode courant — appelé
 * quand on change d'interlocuteur/scénario en pleine conversation. `live.stop()`
 * déclenche onStatus('idle') → endSession() (la séance en cours est clôturée) ;
 * `startLive()` en ouvre une fraîche (nouveau carnet, `greeted=false` → re-bonjour)
 * avec le prompt reconstruit. Un verrou évite les relances qui se chevauchent si on
 * change de mode plusieurs fois de suite.
 */
let restarting = false;
async function restartLive(): Promise<void> {
  if (!live || restarting) return;
  restarting = true;
  try {
    await live.stop();
    await startLive();
  } finally {
    restarting = false;
  }
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

/** Journalise une ligne du déroulé (conversation + tips) pour la relecture de fin. */
function logTranscript(kind: TranscriptEntry['kind'], text: string, note?: string): void {
  if (!currentSession) return;
  const clean = text.trim();
  if (!clean) return;
  (currentSession.transcript ??= []).push({ kind, text: clean, note, ts: Date.now() });
  persist();
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
