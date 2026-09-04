// Le serveur ACCEPTE-T-IL la config Live que Loro envoie ?
// Lance : npm run test:config   (node scripts/test-live-config.mjs)
//
// POURQUOI CE BANC EXISTE (leçon de Mochi). La config part au serveur au moment du
// `connect` : s'il refuse un champ, la session ne s'ouvre PAS — pas de dégradation,
// le prof est simplement muet, sur le téléphone, hors de portée du débogueur.
// TypeScript valide la FORME (le SDK connaît le champ), pas le fait que le service
// l'accepte POUR CE MODÈLE. `sessionResumption.transparent` et
// `contextWindowCompression` sont exactement le genre de champs à vérifier ainsi.
//
// Ce banc envoie le bloc RÉEL (src/agent/liveConfig.ts), attend `setupComplete`, et
// fait EN PLUS un contrôle négatif : une voix inexistante DOIT échouer (1007).

import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { build } from 'esbuild';

delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('VITE_GEMINI_API_KEY absent de .env.local');

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

const { LIVE_MODEL, liveSessionConfig } = await load('../src/agent/liveConfig.ts');
const { toGeminiTools } = await load('../src/agent/tutorTools.ts');
const { assembleSystemInstruction } = await load('../src/tutor/persona.ts');

const systemInstruction = assembleSystemInstruction({ scenario: 'libre' });
const ai = new GoogleGenAI({ apiKey });

/** Ouvre une session avec la voix donnée et rend { ok, why }. */
async function tryConnect(voiceName, resumeHandle) {
  const config = liveSessionConfig(systemInstruction, voiceName, toGeminiTools(), { resumeHandle });
  let regler;
  const verdict = new Promise((r) => (regler = r));
  const minuteur = setTimeout(() => regler({ ok: false, why: 'aucun setupComplete en 20 s' }), 20000);
  let session = null;
  try {
    session = await ai.live.connect({
      model: LIVE_MODEL,
      callbacks: {
        onmessage: (m) => {
          if (m.setupComplete) regler({ ok: true });
        },
        onerror: (e) => regler({ ok: false, why: e.message || 'erreur de session' }),
        onclose: (e) =>
          regler({ ok: false, why: `fermée (${[e?.code, e?.reason].filter(Boolean).join(' ')})` }),
      },
      config,
    });
  } catch (e) {
    regler({ ok: false, why: `connexion refusée : ${e.message}` });
  }
  const r = await verdict;
  clearTimeout(minuteur);
  try {
    session?.close();
  } catch {
    /* déjà fermée */
  }
  return r;
}

const config = liveSessionConfig(systemInstruction, 'Achird', toGeminiTools());
console.log(`modèle      ${LIVE_MODEL}`);
console.log(`champs      ${Object.keys(config).join(', ')}`);
console.log(`resumption  ${JSON.stringify(config.sessionResumption)}`);
console.log(`compression ${config.contextWindowCompression ? JSON.stringify(config.contextWindowCompression) : '(ABSENTE)'}`);

// 1) Positif : la config réelle doit être acceptée.
const pos = await tryConnect('Achird');
console.log(pos.ok ? '\n✓ config acceptée (setupComplete reçu)' : `\n✗ config REFUSÉE — ${pos.why}`);

// 2) Négatif : une voix inexistante doit être REFUSÉE (sinon le banc ne prouve rien).
const neg = await tryConnect('CeciNestPasUneVoix');
const negOk = !neg.ok; // on ATTEND un échec
console.log(negOk ? `✓ contrôle négatif OK (voix bidon rejetée — ${neg.why})` : '✗ contrôle négatif : la voix bidon a été ACCEPTÉE ?!');

const allOk = pos.ok && negOk;
console.log(allOk ? '\nOK — le serveur accepte la config de Loro.' : '\nÉCHEC.');
process.exit(allOk ? 0 : 1);
