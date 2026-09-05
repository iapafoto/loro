// Route un ToolCall du prof vers ses effets : carnet (silencieux), tableau / carte
// de correction / jauge / bilan (visibles), et visage (expression).
//
// Point unique de traduction « outil → effet ». Les effets sur les données passent
// par des handlers fournis par main.ts (il possède le carnet et l'UI) ; le visage,
// lui, est piloté ici, comme chez Mochi.

import { REST_FACE, type FaceState } from '../face/faceState';
import { express, look, type Emotion, type LookDir } from '../face/expressions';
import type { ToolCall } from './tutorTools';
import type { ErrorType } from '../learn/types';

export interface CorrectionCard {
  dit: string;
  correct: string;
  pourquoi: string;
}
export interface BoardEntry {
  texte: string;
  type: 'phrase' | 'mot' | 'liste';
  traduction?: string;
}
export interface LiveScore {
  fluency: number;
  accuracy: number;
  vocabulary: number;
  level: string;
  feedback: string;
}
export interface SessionSummary {
  resume: string;
  aTravailler: string[];
  bravo: string[];
}

/** Ce que main.ts branche : les effets qui touchent le carnet et l'écran. */
export interface TutorHandlers {
  noteErreur(e: { type: ErrorType; dit: string; correct: string; regle: string }): void;
  noteMot(w: { mot: string; traduction?: string; exemple?: string }): void;
  noteReussite(quoi: string): void;
  ecris(x: BoardEntry): void;
  corrige(c: CorrectionCard): void;
  evaluate(s: LiveScore): void;
  finDeSeance(f: SessionSummary): void;
}

export interface DispatchResult {
  ok: boolean;
  detail: string;
}

const ERROR_TYPES: readonly ErrorType[] = ['grammaire', 'vocabulaire', 'prononciation', 'registre'];

export class TutorDispatcher {
  private browTimer: number | null = null;

  constructor(
    private readonly face: FaceState,
    private readonly h: TutorHandlers,
  ) {}

  dispatch(call: ToolCall): DispatchResult {
    const a = call.args;
    switch (call.name) {
      // --- SILENCIEUX -------------------------------------------------------
      case 'note_erreur': {
        const type = ERROR_TYPES.includes(a.type as ErrorType) ? (a.type as ErrorType) : 'grammaire';
        this.h.noteErreur({
          type,
          dit: str(a.dit),
          correct: str(a.correct),
          regle: str(a.regle),
        });
        // ⚠️ LE SOURCIL QUI SE LÈVE, AUTOMATIQUEMENT (PLAN §3). Pas d'outil dédié :
        // le dispatcher branche le journal ET le visage. La faute est signalée à
        // l'instant où elle tombe, sans couper la phrase.
        this.raiseBrow();
        return ok(`erreur ${type} notée`);
      }
      case 'note_mot': {
        this.h.noteMot({ mot: str(a.mot), traduction: opt(a.traduction), exemple: opt(a.exemple) });
        return ok('mot noté');
      }
      case 'note_reussite': {
        this.h.noteReussite(str(a.quoi));
        return ok('réussite notée');
      }

      // --- VISIBLE ----------------------------------------------------------
      case 'ecris': {
        const type = a.type === 'mot' || a.type === 'liste' ? a.type : 'phrase';
        this.h.ecris({ texte: str(a.texte), type, traduction: opt(a.traduction) });
        return ok('affiché au tableau');
      }
      case 'corrige': {
        this.h.corrige({ dit: str(a.dit), correct: str(a.correct), pourquoi: str(a.pourquoi) });
        this.raiseBrow();
        return ok('correction affichée');
      }
      case 'evaluate_english_level': {
        this.h.evaluate({
          fluency: clamp01(num(a.fluency)),
          accuracy: clamp01(num(a.accuracy)),
          vocabulary: clamp01(num(a.vocabulary)),
          level: str(a.level) || 'N/A',
          feedback: str(a.feedback),
        });
        return ok('jauge mise à jour');
      }
      case 'fin_de_seance': {
        this.h.finDeSeance({
          resume: str(a.resume),
          aTravailler: strList(a.a_travailler),
          bravo: strList(a.bravo),
        });
        return ok('séance clôturée');
      }

      // --- EXPRESSION -------------------------------------------------------
      case 'express': {
        const emotion = String(a.emotion ?? 'neutral') as Emotion;
        express(this.face, emotion, clamp01(num(a.intensity, 0.8)));
        return ok(emotion);
      }
      case 'look': {
        look(this.face, String(a.dir ?? 'center') as LookDir);
        return ok(String(a.dir ?? 'center'));
      }
      // Le clignement N'EST PAS un outil : il est géré par le soft (startAutoBlink),
      // en continu et automatiquement — l'IA n'a pas à le piloter.

      default:
        return { ok: false, detail: 'outil inconnu' };
    }
  }

  /** Lève brièvement les sourcils (réaction à une faute), puis relâche. */
  private raiseBrow(): void {
    this.face.setTarget({ channels: { browRaiseL: 0.7, browRaiseR: 0.7, pupil: 0.6 }, tau: 0.1 });
    if (this.browTimer !== null) window.clearTimeout(this.browTimer);
    this.browTimer = window.setTimeout(() => {
      this.browTimer = null;
      this.face.setTarget({
        channels: {
          browRaiseL: REST_FACE.browRaiseL,
          browRaiseR: REST_FACE.browRaiseR,
          pupil: REST_FACE.pupil,
        },
        tau: 0.4,
      });
    }, 700);
  }
}

function ok(detail: string): DispatchResult {
  return { ok: true, detail };
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function opt(v: unknown): string | undefined {
  const s = str(v).trim();
  return s || undefined;
}
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x).trim()).filter(Boolean);
}
function num(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : dflt;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
