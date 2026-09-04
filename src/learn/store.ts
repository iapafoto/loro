// Persistance du carnet et des profils — localStorage, en JSON (PLAN §3).
//
// Tout passe par try/catch : le localStorage peut être refusé (navigation privée)
// ou évincé (cf. pwa.ts). L'app ne doit jamais casser pour ça — au pire elle perd
// la mémoire, ce qui la ramène à « une bonne app de conversation » sans le plus.

import { emptyNotebook, type Notebook, type Profile } from './types';

const PROFILES_KEY = 'loro.profiles';
const ACTIVE_KEY = 'loro.activeProfile';
const NOTEBOOK_PREFIX = 'loro.notebook.';

const DEFAULT_PROFILE: Profile = { id: 'moi', name: 'Moi' };

export class Store {
  private profiles: Profile[];
  private activeId: string;

  constructor() {
    this.profiles = readJson<Profile[]>(PROFILES_KEY) ?? [DEFAULT_PROFILE];
    if (this.profiles.length === 0) this.profiles = [DEFAULT_PROFILE];
    const active = readRaw(ACTIVE_KEY);
    this.activeId = this.profiles.some((p) => p.id === active) ? active! : this.profiles[0].id;
    this.persistProfiles();
  }

  getProfiles(): Profile[] {
    return [...this.profiles];
  }

  getActiveId(): string {
    return this.activeId;
  }

  getActiveProfile(): Profile {
    return this.profiles.find((p) => p.id === this.activeId) ?? this.profiles[0];
  }

  setActive(id: string): void {
    if (!this.profiles.some((p) => p.id === id)) return;
    this.activeId = id;
    writeRaw(ACTIVE_KEY, id);
  }

  addProfile(name: string): Profile {
    const clean = name.trim() || `Profil ${this.profiles.length + 1}`;
    const id = slug(clean) + '-' + Math.random().toString(36).slice(2, 6);
    const p: Profile = { id, name: clean };
    this.profiles.push(p);
    this.persistProfiles();
    return p;
  }

  renameProfile(id: string, name: string): void {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return;
    p.name = name.trim() || p.name;
    this.persistProfiles();
  }

  /** Charge (ou crée) le carnet d'un profil. */
  getNotebook(id = this.activeId): Notebook {
    const nb = readJson<Notebook>(NOTEBOOK_PREFIX + id);
    if (nb && nb.profileId === id) {
      // Rétro-compatibilité douce : garantit la présence des tableaux.
      nb.sessions ??= [];
      nb.producedWords ??= [];
      return nb;
    }
    return emptyNotebook(id);
  }

  save(nb: Notebook): void {
    writeJson(NOTEBOOK_PREFIX + nb.profileId, nb);
  }

  /** Vide le carnet d'un profil (garde le profil lui-même). */
  clearNotebook(id = this.activeId): void {
    writeJson(NOTEBOOK_PREFIX + id, emptyNotebook(id));
  }

  /** Remplace le carnet d'un profil (import). */
  replaceNotebook(nb: Notebook): void {
    if (!this.profiles.some((p) => p.id === nb.profileId)) {
      this.profiles.push({ id: nb.profileId, name: nb.profileId });
      this.persistProfiles();
    }
    this.save(nb);
  }

  private persistProfiles(): void {
    writeJson(PROFILES_KEY, this.profiles);
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // diacritiques combinants
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profil'
  );
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage refusé */
  }
}

function readJson<T>(key: string): T | null {
  const raw = readRaw(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  writeRaw(key, JSON.stringify(value));
}
