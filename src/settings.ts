// Réglages de l'app (hors carnet et hors profils) — localStorage, JSON.
// Le profil actif est géré par le Store ; ici vivent la voix, le seuil de silence,
// le métier, le scénario par défaut et le mode sous-titres.

import { DEFAULT_SILENCE_MS } from './agent/liveConfig';
import { DEFAULT_VOICE } from './agent/live';
import { DEFAULT_INTERLOCUTEUR, type InterlocuteurId, type ScenarioId } from './tutor/persona';

export type SubtitleMode = 'off' | 'en' | 'bi';

export interface Settings {
  /** Interlocuteur choisi (partenaire pro, prof d'anglais, prof d'espagnol). */
  interlocuteur: InterlocuteurId;
  voice: string;
  silenceMs: number;
  job: string;
  scenario: ScenarioId;
  subtitles: SubtitleMode;
  /**
   * Volume de la voix du prof (0..1), appliqué par un gain maître DANS l'app. Sur
   * Android, la voix sort par le haut-parleur via un flux que les boutons de volume
   * du téléphone ne pilotent pas toujours ; ce réglage-là marche quoi qu'il arrive.
   */
  volume: number;
}

const SETTINGS_KEY = 'loro.settings';

export function defaultSettings(): Settings {
  return {
    interlocuteur: DEFAULT_INTERLOCUTEUR,
    voice: DEFAULT_VOICE,
    silenceMs: DEFAULT_SILENCE_MS,
    job: '',
    scenario: 'libre',
    subtitles: 'bi',
    volume: 1,
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
