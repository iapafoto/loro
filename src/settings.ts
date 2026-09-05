// Réglages de l'app (hors carnet et hors profils) — localStorage, JSON.
// Le profil actif est géré par le Store ; ici vivent la voix, le seuil de silence,
// le métier, le scénario par défaut et le mode sous-titres.

import { DEFAULT_SILENCE_MS } from './agent/liveConfig';
import { DEFAULT_VOICE } from './agent/live';
import { DEFAULT_INTERLOCUTEUR, type InterlocuteurId, type ScenarioId } from './tutor/persona';

// Sous-titres : uniquement ceux du PROF (la transcription de l'élève, peu fiable —
// elle partait parfois en caractères CJK — n'est plus affichée, seulement gardée
// dans le compte rendu). Simple bascule marche/arrêt.
export type SubtitleMode = 'off' | 'on';

export interface Settings {
  /** Interlocuteur choisi (partenaire pro, prof d'anglais, prof d'espagnol). */
  interlocuteur: InterlocuteurId;
  voice: string;
  silenceMs: number;
  job: string;
  scenario: ScenarioId;
  subtitles: SubtitleMode;
  /** Emotes/réactions (icônes qui montent au-dessus du visage). Désactivable. */
  emotes: boolean;
  /** Nombre d'icônes par réaction du prof (emoji libre), 1-10. */
  emoteCount: number;
}

const SETTINGS_KEY = 'loro.settings';

export function defaultSettings(): Settings {
  return {
    interlocuteur: DEFAULT_INTERLOCUTEUR,
    voice: DEFAULT_VOICE,
    silenceMs: DEFAULT_SILENCE_MS,
    job: '',
    scenario: 'libre',
    subtitles: 'on',
    emotes: true,
    emoteCount: 3,
  };
}

export function loadSettings(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    return { ...base, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* stockage refusé */
  }
}
