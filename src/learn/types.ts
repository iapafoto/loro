// Modèle de données du carnet (PLAN §3). Tout est du TEXTE : sans enregistrements
// audio, une séance pèse quelques Ko — d'où localStorage plutôt qu'IndexedDB.

export type ErrorType = 'grammaire' | 'vocabulaire' | 'prononciation' | 'registre';

export interface ErrorNote {
  type: ErrorType;
  dit: string;
  correct: string;
  regle: string;
  ts: number;
}

export interface WordNote {
  mot: string;
  traduction?: string;
  exemple?: string;
  ts: number;
}

export interface SuccessNote {
  quoi: string;
  ts: number;
}

/**
 * Une ligne du DÉROULÉ de la séance, pour la relecture de fin (PLAN §4). On garde
 * un journal chronologique de la conversation ET des tips (corrections, avis du
 * prof), pour pouvoir rejouer à la fin « la conversation avec ses conseils
 * intercalés » — trop difficiles à lire en direct. Du texte seulement : quelques Ko.
 */
export type TranscriptKind = 'user' | 'tutor' | 'correction' | 'feedback';

export interface TranscriptEntry {
  kind: TranscriptKind;
  text: string;
  /** Précision facultative (le « pourquoi » d'une correction). */
  note?: string;
  ts: number;
}

/** Une notation à la volée (evaluate_english_level). */
export interface Score {
  fluency: number;
  accuracy: number;
  vocabulary: number;
  level: string; // CEFR
  feedback: string;
  ts: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  /** null tant que la séance est en cours. */
  endedAt: number | null;
  scenario: string;
  errors: ErrorNote[];
  words: WordNote[];
  successes: SuccessNote[];
  scores: Score[];
  /** Déroulé de la conversation + tips, pour la relecture de fin (facultatif : les
   * anciennes séances n'en ont pas). */
  transcript?: TranscriptEntry[];
  /** Renseignés par fin_de_seance. */
  resume?: string;
  aTravailler?: string[];
  bravo?: string[];
  // Métriques calculées localement (PLAN §4), sans modèle.
  /** Temps de parole réel de l'élève (ms, VAD locale). */
  spokenMs?: number;
  /** Nombre de tours de parole de l'élève. */
  turns?: number;
  /** Mots produits pour la PREMIÈRE fois pendant cette séance. */
  newWords?: string[];
}

export interface Profile {
  id: string;
  name: string;
}

export interface Notebook {
  profileId: string;
  sessions: SessionRecord[];
  /** Ensemble des mots déjà produits spontanément (minuscule), pour la métrique
   * « mots produits pour la première fois ». Pas « mots vus » — mots sortis de la
   * bouche de l'élève (cf. PLAN §4). */
  producedWords: string[];
}

export function emptyNotebook(profileId: string): Notebook {
  return { profileId, sessions: [], producedWords: [] };
}

export function newSession(scenario: string): SessionRecord {
  return {
    id: `s${Date.now().toString(36)}`,
    startedAt: Date.now(),
    endedAt: null,
    scenario,
    errors: [],
    words: [],
    successes: [],
    scores: [],
    transcript: [],
    spokenMs: 0,
    turns: 0,
    newWords: [],
  };
}
