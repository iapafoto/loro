// Export / import du carnet — un fichier JSON pour changer de téléphone (PLAN §3).
//
// On exporte TOUT (profils + carnets + réglages) : « changer de téléphone » veut
// dire retrouver sa progression entière, pas un profil isolé.

import type { Store } from './store';
import type { Notebook, Profile } from './types';
import type { Settings } from '../settings';

export interface ExportBundle {
  app: 'loro';
  version: 1;
  exportedAt: number;
  profiles: Profile[];
  notebooks: Notebook[];
  settings?: Settings;
}

export function buildExport(store: Store, settings: Settings): ExportBundle {
  const profiles = store.getProfiles();
  return {
    app: 'loro',
    version: 1,
    exportedAt: Date.now(),
    profiles,
    notebooks: profiles.map((p) => store.getNotebook(p.id)),
    settings,
  };
}

/** Déclenche le téléchargement du fichier (geste utilisateur). */
export function downloadExport(bundle: ExportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date(bundle.exportedAt).toISOString().slice(0, 10);
  a.href = url;
  a.download = `loro-carnet-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Valide et parse un fichier importé. Lève une erreur lisible si c'est autre chose. */
export function parseImport(text: string): ExportBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('fichier illisible (pas du JSON)');
  }
  const b = data as Partial<ExportBundle>;
  if (b?.app !== 'loro' || !Array.isArray(b.profiles) || !Array.isArray(b.notebooks)) {
    throw new Error("ce n'est pas un carnet Loro");
  }
  return b as ExportBundle;
}

/** Applique un import : remplace profils/carnets, rend les réglages éventuels. */
export function applyImport(store: Store, bundle: ExportBundle): Settings | undefined {
  for (const nb of bundle.notebooks) store.replaceNotebook(nb);
  return bundle.settings;
}
