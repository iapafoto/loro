// Vocabulaire d'outils du prof — défini UNE fois en format neutre (OpenAPI-ish),
// exposé à Gemini Live comme functionDeclarations, dispatché vers le carnet / le
// tableau / la jauge / le visage.
//
// Deux familles, comme chez Mochi (intents.ts), mais ici la distinction est
// SILENCIEUX vs VISIBLE, pas expression vs déplacement :
//   — SILENCIEUX (note_erreur, note_mot, note_reussite) : journalisation pure,
//     aucun effet à l'écran. Le prof les appelle en parlant, sans les annoncer.
//   — VISIBLE (ecris, corrige, evaluate_english_level, fin_de_seance) : ça bouge à
//     l'écran (tableau, carte de correction, jauge, écran de bilan).
//   — EXPRESSION (express, look) : le visage, repris de Mochi. Le clignement, lui,
//     est automatique (startAutoBlink), pas un outil.
//
// ⚠️ Ne mets aucun détail réseau ici sauf `toGeminiTools`, qui adapte au SDK — et
// qui est isolé en bas de fichier pour que le banc `test-live-config.mjs` charge la
// MÊME conversion que l'app (une config refusée par le serveur = app muette).

import { Type } from '@google/genai';

/** Schéma de paramètre neutre (sous-ensemble OpenAPI utilisé par Gemini). */
export interface ParamSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  /** Type des éléments, quand `type === 'array'`. */
  items?: ParamSchema;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'object';
    properties: Record<string, ParamSchema>;
    required?: string[];
  };
}

/** Un appel d'outil résolu (nom + arguments). */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

const STRING: ParamSchema = { type: 'string' };

export const TUTOR_DECLARATIONS: FunctionDeclaration[] = [
  // --- SILENCIEUX : journalisation, aucun effet visible ---------------------
  {
    name: 'note_erreur',
    description:
      "JOURNAL SILENCIEUX (ne l'annonce jamais, n'en parle pas). Consigne une faute de l'élève "
      + 'pour le carnet. À appeler à l’instant où la faute tombe, sans couper la phrase — la '
      + 'correction explicite, elle, vient à la fin du tour (corrige). Le `type` « registre » est '
      + 'le plus important : c’est là que la traduction littérale du français passe pour brutale.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['grammaire', 'vocabulaire', 'prononciation', 'registre'],
          description: 'Nature de la faute.',
        },
        dit: { type: 'string', description: "Ce que l'élève a dit (la forme fautive)." },
        correct: { type: 'string', description: 'La forme correcte.' },
        regle: {
          type: 'string',
          description:
            'La règle en jeu, courte et RÉUTILISABLE — c’est la clé de regroupement du carnet '
            + '(ex. « accord sujet-verbe », « must → could pour une demande polie »). '
            + 'Formule-la de la même façon d’une fois sur l’autre pour une même faute.',
        },
      },
      required: ['type', 'dit', 'correct', 'regle'],
    },
  },
  {
    name: 'note_mot',
    description:
      'JOURNAL SILENCIEUX (ne l’annonce pas). Ajoute un mot/expression utile au carnet, pour le '
      + 'faire réutiliser plus tard.',
    parameters: {
      type: 'object',
      properties: {
        mot: { type: 'string', description: 'Le mot ou l’expression en anglais.' },
        traduction: { type: 'string', description: 'Traduction française courte.' },
        exemple: { type: 'string', description: 'Une phrase d’exemple naturelle.' },
      },
      required: ['mot'],
    },
  },
  {
    name: 'note_reussite',
    description:
      'JOURNAL SILENCIEUX (ne l’annonce pas). Note une chose que l’élève a bien faite — sert à '
      + 'ouvrir la séance suivante sur une réussite.',
    parameters: {
      type: 'object',
      properties: { quoi: { type: 'string', description: 'Ce qui a été réussi, en une phrase.' } },
      required: ['quoi'],
    },
  },

  // --- VISIBLE --------------------------------------------------------------
  {
    name: 'ecris',
    description:
      'LE TABLEAU. Affiche à l’écran un mot ou une phrase qu’on vient d’entendre — pour le VOIR '
      + 'écrit, pas seulement l’entendre. À utiliser quand l’orthographe aide (un mot nouveau, une '
      + 'expression idiomatique, une tournure à retenir).',
    parameters: {
      type: 'object',
      properties: {
        texte: { type: 'string', description: 'Le texte à afficher.' },
        type: {
          type: 'string',
          enum: ['phrase', 'mot', 'liste'],
          description: 'phrase, mot isolé, ou petite liste (une par ligne).',
        },
        traduction: { type: 'string', description: 'Traduction française (facultative).' },
      },
      required: ['texte', 'type'],
    },
  },
  {
    name: 'corrige',
    description:
      'CARTE DE CORRECTION (visible) + journal. Sers-t’en RÉGULIÈREMENT, dès qu’une tournure '
      + 'mérite d’être VUE écrite, pas seulement quand une faute se répète. C’est la trace '
      + 'écrite du cours : un écran resté vide toute la séance = un cours sans corrections. '
      + 'Vise plusieurs cartes par séance. Évite juste de corriger CHAQUE broutille (le reste '
      + 'passe par reformulation naturelle). La carte vient à la fin de ton tour, en plus de '
      + 'ta réponse parlée. Montre la forme fautive, la forme correcte, et pourquoi, en une ligne.',
    parameters: {
      type: 'object',
      properties: {
        dit: { type: 'string', description: 'Ce que l’élève a dit.' },
        correct: { type: 'string', description: 'La forme correcte.' },
        pourquoi: { type: 'string', description: 'La raison, courte.' },
      },
      required: ['dit', 'correct', 'pourquoi'],
    },
  },
  {
    name: 'evaluate_english_level',
    description:
      'LA JAUGE LIVE. Estime le niveau de l’élève d’après ce que tu viens d’entendre. Appelle-la '
      + 'TOUTES LES 2-3 RÉPLIQUES, et tout de suite si l’élève la demande — dans ce cas mets 0 '
      + 'partout si tu n’as pas encore de quoi juger, plutôt que de sauter l’appel. C’est ce qui '
      + 'fait bouger la jauge pendant la conversation. '
      + 'SOIS CALIBRÉ, PAS COMPLAISANT : note ce que tu entends VRAIMENT, pas ce qui ferait '
      + 'plaisir. Un quasi-débutant (phrases très courtes, fautes de base, hésitations, passages '
      + 'en français) = A1 avec des scores BAS (0,1–0,3). Un niveau scolaire moyen = A2/B1 (0,3–0,5). '
      + 'Réserve 0,7+ et B2/C1 à une aisance réelle et soutenue. Encourageant dans le TON (feedback), '
      + 'HONNÊTE dans les chiffres — une jauge gonflée ne rend pas service.',
    parameters: {
      type: 'object',
      properties: {
        fluency: { type: 'number', minimum: 0, maximum: 1, description: 'Fluidité (0-1).' },
        accuracy: { type: 'number', minimum: 0, maximum: 1, description: 'Précision grammaticale (0-1).' },
        vocabulary: { type: 'number', minimum: 0, maximum: 1, description: 'Richesse du vocabulaire (0-1).' },
        level: {
          type: 'string',
          enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
          description: 'Niveau CEFR estimé.',
        },
        feedback: { type: 'string', description: 'Retour court et encourageant.' },
      },
      required: ['fluency', 'accuracy', 'vocabulary', 'level', 'feedback'],
    },
  },
  {
    name: 'fin_de_seance',
    description:
      'ÉCRAN DE BILAN + notes du prof pour la prochaine fois. À appeler quand la conversation '
      + 'touche à sa fin (silence prolongé, « on s’arrête là », ou la cloche de fin). Ordre voulu '
      + 'du bilan : le bravo d’abord.',
    parameters: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: 'Résumé de la séance, deux ou trois phrases.' },
        a_travailler: {
          type: 'array',
          items: STRING,
          description: 'Points à retravailler la prochaine fois.',
        },
        bravo: { type: 'array', items: STRING, description: 'Ce qui a été réussi aujourd’hui.' },
      },
      required: ['resume'],
    },
  },

  // --- EXPRESSION (visage, repris de Mochi) ---------------------------------
  {
    name: 'express',
    description:
      'Affiche une émotion sur le visage du prof. À utiliser dès que la réponse a une couleur '
      + '(content d’une belle phrase, surpris, curieux de ce que tu racontes).',
    parameters: {
      type: 'object',
      properties: {
        emotion: {
          type: 'string',
          enum: ['joy', 'surprise', 'curiosity', 'neutral'],
          description: 'L’émotion à exprimer.',
        },
        intensity: { type: 'number', minimum: 0, maximum: 1, description: 'Intensité 0-1 (défaut 0.8).' },
      },
      required: ['emotion'],
    },
  },
  {
    name: 'look',
    description: 'Oriente le regard (les yeux seulement).',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          enum: ['left', 'right', 'up', 'down', 'center'],
          description: 'Direction du regard.',
        },
      },
      required: ['dir'],
    },
  },
  // Pas d'outil `blink` : le clignement est géré par le soft (startAutoBlink), en
  // continu et automatiquement. L'IA ne pilote pas les paupières.
];

const TYPE_MAP: Record<ParamSchema['type'], Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
};

/** Convertit un schéma neutre (récursivement, pour les tableaux) au format SDK. */
function toGeminiParam(p: ParamSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: TYPE_MAP[p.type] };
  if (p.description) out.description = p.description;
  if (p.enum) out.enum = p.enum;
  if (p.items) out.items = toGeminiParam(p.items);
  return out;
}

/** Adapte nos déclarations neutres au schéma attendu par le SDK (@google/genai). */
export function toGeminiTools() {
  const functionDeclarations = TUTOR_DECLARATIONS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters
      ? {
          type: Type.OBJECT,
          properties: Object.fromEntries(
            Object.entries(d.parameters.properties).map(([k, p]) => [k, toGeminiParam(p)]),
          ),
          required: d.parameters.required ?? [],
        }
      : undefined,
  }));
  return [{ functionDeclarations }];
}
