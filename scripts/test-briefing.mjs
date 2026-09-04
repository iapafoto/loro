// Le briefing reste-t-il COURT, et OUBLIE-T-IL les points acquis ? (PLAN §3.5, §7)
// Lance : npm run test:briefing   (node scripts/test-briefing.mjs)
//
// Carnet factice → briefing. On vérifie que :
//   • un point RÉCURRENT dans la fenêtre récente (≥ 3×) remonte dans la fiche ;
//   • un point ancien, hors fenêtre (« déjà acquis »), N'Y revient PAS ;
//   • une faute isolée (1×) ne remonte pas ;
//   • la fiche reste courte.

import { build } from 'esbuild';

const load = async (rel) => {
  const out = await build({
    entryPoints: [new URL(rel, import.meta.url).pathname.replace(/^\//, '')],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'error',
  });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
};

const { compileBriefing, RECENT_SESSIONS } = await load('../src/tutor/briefing.ts');

let t = 1000;
const err = (type, dit, correct, regle) => ({ type, dit, correct, regle, ts: t++ });
const session = (errors, extra = {}) => ({
  id: 's' + t,
  startedAt: t,
  endedAt: t + 1,
  scenario: 'libre',
  errors,
  words: [],
  successes: [],
  scores: [],
  ...extra,
});

// Un point ACQUIS : « I am agree » martelé il y a longtemps (4 séances), puis plus
// jamais. Il doit sortir de la fenêtre récente (RECENT_SESSIONS) et disparaître.
const vieux = [
  session([err('grammaire', 'I am agree', 'I agree', 'agree ne prend pas be')]),
  session([err('grammaire', 'I am agree', 'I agree', 'agree ne prend pas be')]),
  session([err('grammaire', 'I am agree', 'I agree', 'agree ne prend pas be')]),
  session([err('grammaire', 'I am agree', 'I agree', 'agree ne prend pas be')]),
];

// Un point VIVANT : le registre « you must » revient 3× dans les séances récentes.
// Plus une faute isolée qui ne doit pas remonter, et des séances de remplissage —
// assez pour que les 4 vieilles séances tombent hors de la fenêtre récente.
const recents = [
  session([
    err('registre', 'you must send me', 'could you send me…', 'must → could pour une demande polie'),
    err('vocabulaire', 'actual', 'current', 'faux ami actual/current'),
  ]),
  session([err('registre', 'you must call', 'could you call…', 'must → could pour une demande polie')]),
  session([err('registre', 'you must confirm', 'could you confirm…', 'must → could pour une demande polie')]),
  session([err('grammaire', 'he go', 'he goes', 'accord 3e personne (ponctuel)')]),
  session([err('vocabulaire', 'sensible', 'sensitive', 'faux ami (ponctuel)')]),
  session([err('prononciation', 'th', 'th', 'le « th » (ponctuel)')]),
];

// vieux(4) + recents(6) = 10 séances ; la fenêtre ne garde que les 6 dernières,
// donc les 4 « I am agree » disparaissent.
const sessions = [...vieux, ...recents];
const nb = {
  profileId: 'test',
  sessions,
  producedWords: [],
};

const fiche = compileBriefing(nb, { profileName: 'Sébastien', job: 'ingénieur avant-vente' });
console.log('--- FICHE ÉLÈVE ---\n' + fiche + '\n-------------------');

const lines = fiche.split('\n').length;
const checks = [
  ['point récurrent présent', /must → could/.test(fiche)],
  ['point acquis absent', !/I am agree/.test(fiche)],
  ['faute isolée absente', !/actual/.test(fiche)],
  ['métier présent', /ingénieur avant-vente/.test(fiche)],
  [`fiche courte (${lines} lignes ≤ 12)`, lines <= 12],
  [`fenêtre = ${RECENT_SESSIONS} séances`, RECENT_SESSIONS === 6],
];

let allOk = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) allOk = false;
}
console.log(allOk ? '\nOK — briefing court et sélectif.' : '\nÉCHEC.');
process.exit(allOk ? 0 : 1);
