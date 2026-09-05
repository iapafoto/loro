// Le briefing — comment une lacune est identifiée et ciblée (PLAN §3.5).
//
// LE PARTAGE DU TRAVAIL EST LE POINT CLÉ : l'app COMPTE et se SOUVIENT (ici,
// déterministe, local, gratuit — aucun appel modèle), le modèle JUGE et DÉCIDE
// (dans la conversation). Le décompte informe le prof ; il ne le contraint pas.
//
// Pourquoi ce n'est pas le modèle qui compte : à travers la compression de contexte
// (liveConfig.ts), il oublie les vieux tours et ne peut pas tenir un décompte fiable
// sur plusieurs séances. Le comptage est exactement ce qu'une machine fait mieux
// qu'un modèle — une mémoire OBJECTIVE.
//
// Ce module est aussi la SOURCE UNIQUE des agrégats affichés dans l'écran Carnet :
// la fiche envoyée au prof et les chiffres montrés à l'élève sortent du même calcul.

import type { ErrorType, Notebook, SessionRecord } from '../learn/types';

/**
 * Fenêtre de récence : on n'agrège que les dernières séances. C'est CE mécanisme
 * qui fait « redescendre » un point qui ne réapparaît plus (PLAN §3.5.4) — pas de
 * logique d'oubli explicite, juste un point sorti de la fenêtre. `test-briefing.mjs`
 * vérifie qu'un point déjà acquis ne revient pas dans la fiche.
 */
export const RECENT_SESSIONS = 6;

/** Occurrences minimales (dans la fenêtre) pour qu'un point soit RÉCURRENT. Une
 * faute isolée n'est pas une lacune ; la même revenue ≥ 3 fois, oui. */
export const RECUR_MIN = 3;

export interface RecurrentError {
  type: ErrorType;
  regle: string;
  count: number;
  /** Nombre de séances distinctes où il est apparu (dans la fenêtre). */
  sessions: number;
  /** Un exemple récent « dit → correct ». */
  exemple: { dit: string; correct: string };
  lastTs: number;
}

export interface ReusableWord {
  mot: string;
  traduction?: string;
  count: number;
  lastTs: number;
}

function recentSessions(nb: Notebook, window = RECENT_SESSIONS): SessionRecord[] {
  // Séances terminées, les plus récentes d'abord n'importe — on prend la queue.
  return nb.sessions.slice(-window);
}

function normRegle(r: string): string {
  return r.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Agrège les fautes par (type, règle) sur la fenêtre récente et compte. Rend TOUS
 * les points (triés), à charge de l'appelant de filtrer sur RECUR_MIN pour la fiche.
 * L'écran Carnet, lui, les montre tous.
 */
export function aggregateErrors(nb: Notebook, window = RECENT_SESSIONS): RecurrentError[] {
  const map = new Map<string, RecurrentError>();
  for (const s of recentSessions(nb, window)) {
    const seenHere = new Set<string>();
    for (const e of s.errors) {
      const key = `${e.type}|${normRegle(e.regle)}`;
      let agg = map.get(key);
      if (!agg) {
        agg = {
          type: e.type,
          regle: e.regle.trim(),
          count: 0,
          sessions: 0,
          exemple: { dit: e.dit, correct: e.correct },
          lastTs: e.ts,
        };
        map.set(key, agg);
      }
      agg.count++;
      if (e.ts >= agg.lastTs) {
        agg.lastTs = e.ts;
        agg.exemple = { dit: e.dit, correct: e.correct }; // l'exemple le plus récent
      }
      if (!seenHere.has(key)) {
        seenHere.add(key);
        agg.sessions++;
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

/** Points RÉCURRENTS (≥ RECUR_MIN occurrences dans la fenêtre) — ce qui remonte dans la fiche. */
export function recurrentErrors(nb: Notebook, window = RECENT_SESSIONS): RecurrentError[] {
  return aggregateErrors(nb, window).filter((e) => e.count >= RECUR_MIN);
}

/** Mots à réutiliser, triés par récurrence puis ancienneté (PLAN §5, pas de SRS formel). */
export function reusableWords(nb: Notebook, window = RECENT_SESSIONS, max = 6): ReusableWord[] {
  const map = new Map<string, ReusableWord>();
  for (const s of recentSessions(nb, window)) {
    for (const w of s.words) {
      const key = w.mot.trim().toLowerCase();
      if (!key) continue;
      const cur = map.get(key);
      if (cur) {
        cur.count++;
        if (w.ts > cur.lastTs) cur.lastTs = w.ts;
        if (!cur.traduction && w.traduction) cur.traduction = w.traduction;
      } else {
        map.set(key, { mot: w.mot.trim(), traduction: w.traduction, count: 1, lastTs: w.ts });
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
    .slice(0, max);
}

/** La réussite la plus récente (pour ouvrir la séance sur un bravo). */
export function latestSuccess(nb: Notebook): string | undefined {
  let best: { quoi: string; ts: number } | undefined;
  for (const s of nb.sessions) {
    for (const su of s.successes) if (!best || su.ts > best.ts) best = su;
    if (s.bravo?.length) {
      const ts = s.endedAt ?? s.startedAt;
      if (!best || ts > best.ts) best = { quoi: s.bravo[0], ts };
    }
  }
  return best?.quoi;
}

const TYPE_LABEL: Record<ErrorType, string> = {
  grammaire: 'grammaire',
  vocabulaire: 'vocabulaire',
  prononciation: 'prononciation',
  registre: 'registre',
};

export interface BriefingOptions {
  profileName: string;
  /** Le métier de l'élève en une phrase (réglages). */
  job?: string;
  /**
   * Cadre d'apprentissage en tête de fiche — dépend de l'interlocuteur choisi
   * (cf. persona.ts, `Interlocuteur.enteteFiche`). C'est ce cadre qui disait
   * « déplacements clients à l'international », d'où les fausses réunions au bonjour :
   * on le laisse piloter par l'appelant. Défaut : le cadre « pro » historique.
   */
  enteteFiche?: string;
}

const ENTETE_PAR_DEFAUT = "Anglais professionnel, déplacements clients à l'international.";

/**
 * Compile le carnet en un bloc COURT injecté dans le `systemInstruction` (PLAN §3).
 *
 * ⚠️ Dans le systemInstruction, PAS dans un tour de chat : la fenêtre glissante
 * jette les vieux tours, mais les instructions système restent hors fenêtre (cf.
 * liveConfig.ts). Un briefing envoyé comme message serait oublié vers la douzième
 * minute — quand il sert le plus.
 *
 * Ordre voulu : BRAVO d'abord. On ouvre sur une réussite.
 */
export function compileBriefing(nb: Notebook, opts: BriefingOptions): string {
  const lines: string[] = [];
  lines.push(`FICHE ÉLÈVE — ${opts.profileName}. ${opts.enteteFiche ?? ENTETE_PAR_DEFAUT}`);
  if (opts.job?.trim()) lines.push(`Métier : ${opts.job.trim()}.`);

  const bravo = latestSuccess(nb);
  if (bravo) lines.push(`BRAVO LA DERNIÈRE FOIS : ${bravo}`);

  const recur = recurrentErrors(nb);
  if (recur.length) {
    lines.push('À CORRIGER EN PRIORITÉ (information objective, à toi de juger quoi en faire) :');
    for (const e of recur.slice(0, 5)) {
      const ex = e.exemple.dit && e.exemple.correct ? ` « ${e.exemple.dit} » → « ${e.exemple.correct} »` : '';
      lines.push(`  • [${TYPE_LABEL[e.type]}, ${e.count}×] ${e.regle}${ex}`);
    }
  }

  const words = reusableWords(nb);
  if (words.length) {
    lines.push(`À FAIRE RÉUTILISER : ${words.map((w) => w.mot).join(' · ')}`);
  }

  // ⚠️ On rappelle au prof, DANS la fiche, que ce sont des faits et pas des ordres —
  // sinon il devient borné et drague sa liste au lieu d'écouter la personne (§2, §3.5).
  if (recur.length || words.length) {
    lines.push(
      "(Ces points reviennent souvent ; à toi de décider quoi travailler aujourd'hui, en les "
        + "croisant avec ce que l'élève veut et ce que tu entends. Ne les annonce pas : fais-les "
        + 'resurgir par la conversation.)',
    );
  }

  return lines.join('\n');
}
