// Réglages de la session Gemini Live — SANS aucune dépendance navigateur.
//
// ⚠️ POURQUOI CE FICHIER EXISTE SÉPARÉMENT DE live.ts (leçon de Mochi). Ce bloc part
// au serveur au moment du `connect`, et le serveur peut le REFUSER : un champ qu'il
// n'accepte pas, et la session ne s'ouvre pas du tout — le prof muet, sur le
// téléphone, sans recours. Or `live.ts` importe le micro et le lecteur audio, donc
// `window` : impossible à charger depuis Node. On extrait donc la config ici pour
// que `scripts/test-live-config.mjs` envoie CE bloc-là, celui que l'app envoie
// vraiment, et attende `setupComplete`.

import {
  Modality,
  StartSensitivity,
  EndSensitivity,
  type LiveConnectConfig,
  type ToolListUnion,
} from '@google/genai';

// Modèle audio natif temps réel. Constante UNIQUE (cf. PLAN §8) : ce sont des
// modèles preview, ils peuvent bouger — le banc de config transforme alors « le
// modèle a changé » en échec net plutôt qu'en app muette.
export const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

/**
 * Seuil de fin de parole (ms de silence avant de committer le tour), RÉGLABLE.
 *
 * ⚠️ 650 ms convenait pour donner un ordre à un robot ; quelqu'un qui CHERCHE SES
 * MOTS en anglais hésite plus longtemps, et une hésitation prise pour une fin de
 * tour coupe la phrase en deux — le prof répond à une demi-phrase, et « il ne
 * comprend pas ». On part donc plus patient (900 ms) et on l'expose dans les
 * réglages : un curseur, pas une table par niveau (cf. PLAN §1a).
 */
export const DEFAULT_SILENCE_MS = 900;
/** Durée de parole avant de committer le début de tour. */
export const VAD_PREFIX_MS = 50;

export interface LiveConfigOptions {
  /** Jeton de reprise d'une session précédente (cf. PLAN §1b) — absent = nouvelle session. */
  resumeHandle?: string;
  /** Seuil de fin de parole en ms (défaut DEFAULT_SILENCE_MS). */
  silenceMs?: number;
}

/**
 * Construit la config envoyée à `ai.live.connect`.
 *
 * @param systemInstruction persona + règles + fiche élève (cf. tutor/persona.ts, briefing.ts)
 * @param voiceName voix préfabriquée du modèle
 * @param tools déclarations d'outils déjà converties (cf. tutorTools.toGeminiTools)
 */
export function liveSessionConfig(
  systemInstruction: string,
  voiceName: string,
  tools: ToolListUnion,
  opts: LiveConfigOptions = {},
): LiveConnectConfig {
  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // ⚠️ PAS de `languageCode` : les modèles audio natifs choisissent la langue
    // seuls et refusent ce champ. La langue cible se pilote UNIQUEMENT par le prompt
    // (cf. tutor/persona.ts).
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    /**
     * REPRISE DE SESSION (cf. PLAN §1b). Une session audio seule est plafonnée à
     * ~15 min : le serveur envoie `goAway` puis ferme. En déclarant
     * `sessionResumption`, le serveur nous envoie des handles ; avec un handle, on
     * rouvre une session qui CONTINUE le contexte — le prof se souvient du début.
     *
     * ⚠️ PAS de `transparent: true` : le banc `test:config` l'a fait REFUSER par le
     * serveur (« transparent parameter is not supported in Gemini API » — c'est un
     * champ Vertex only), et une config refusée = aucune session, app muette. On
     * s'en passe sans conséquence : notre tampon micro couvre tout le trou de
     * reprise (borné par MAX_MIC_BUFFER dans live.ts), il n'a pas besoin de l'index
     * du dernier message que `transparent` aurait fait remonter.
     */
    sessionResumption: opts.resumeHandle ? { handle: opts.resumeHandle } : {},
    /**
     * Fenêtre glissante : au lieu de fermer quand le contexte est plein, le serveur
     * jette les plus vieux tours. On perd le début des très longues conversations —
     * mais PAS les instructions système, qui restent hors fenêtre. C'est ce qui fait
     * que la fiche élève et la consigne d'orienter la conversation (PLAN §2, §3.5)
     * survivent à la douzième minute, quand elles servent le plus.
     */
    contextWindowCompression: { slidingWindow: {} },
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        prefixPaddingMs: VAD_PREFIX_MS,
        silenceDurationMs: silenceMs,
      },
    },
  };
}
