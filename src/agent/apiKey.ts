/**
 * Où vit la clé Gemini — et pourquoi elle vit là (repris de Mochi apiKey.ts).
 *
 * Elle est stockée dans le `localStorage` DU TÉLÉPHONE, saisie une fois dans les
 * réglages. Le `localStorage` est cloisonné par ORIGINE et par APPAREIL : un
 * visiteur de la page publique reçoit une app sans clé, qui lui en demande une ; la
 * tienne n'a jamais été déployée nulle part. Elle est donc exactement aussi exposée
 * que le `.env.local` du PC — c'est-à-dire pas — alors qu'une clé mise en dur dans un
 * bundle public se lit en trente secondes. Et surtout : aucun serveur, donc l'app
 * peut être posée sur n'importe quel hébergement statique (GitHub Pages).
 *
 * ⚠️ Contrepartie honnête : tout JS tournant sur cette origine peut la lire. Un
 * plafond de quota côté Google borne les dégâts. Pour une app perso, c'est
 * proportionné. Sans clé saisie, la voix Live est indisponible.
 *
 * Une clé = un quota, partagé par les deux profils (cf. PLAN §8). Deux clés si ça
 * coince ; le stockage par appareil le rend naturel.
 */

const STORAGE_KEY = 'loro.geminiKey';

/** D'où vient la clé qu'on utilise — pour le dire à l'écran plutôt que le deviner. */
export type KeySource = 'stockée' | '.env.local' | 'aucune';

/**
 * La clé courante, et sa provenance. Le `localStorage` PASSE AVANT `.env.local` :
 * saisir une clé dans les réglages est un geste explicite, il doit gagner.
 */
export function loadGeminiKey(): { key?: string; source: KeySource } {
  const stored = read();
  if (stored) return { key: stored, source: 'stockée' };

  if (import.meta.env.DEV) {
    const fromEnv = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim();
    if (fromEnv) return { key: fromEnv, source: '.env.local' };
  }
  return { source: 'aucune' };
}

/** Y a-t-il une clé saisie sur CET appareil ? (indépendant de `.env.local`) */
export function hasStoredKey(): boolean {
  return !!read();
}

/** Enregistre (ou efface, si vide) la clé sur cet appareil. */
export function saveGeminiKey(key: string): void {
  const clean = key.trim();
  try {
    if (clean) localStorage.setItem(STORAGE_KEY, clean);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Stockage refusé (navigation privée) : on ne casse pas l'app pour ça.
  }
}

function read(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}
