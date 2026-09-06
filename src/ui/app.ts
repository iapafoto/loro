// Coquille d'interface de Loro — trois écrans, pas plus (PLAN §4) :
//   1. Conversation : visage plein écran + jauge live + tableau + corrections +
//      sous-titres + menu de scénario + minuteur.
//   2. Carnet : bilan de la séance + historique (niveau, erreurs, mots, temps).
//   3. Réglages : clé, profil, métier, voix, seuil de silence, sous-titres, export.
//
// L'App ne fait que du RENDU et remonte des callbacks ; main.ts tient la logique.

import { el, clear, svgEl } from './dom';
import { SCENARIOS, INTERLOCUTEURS } from '../tutor/persona';
import { LIVE_VOICES } from '../agent/live';
import type { LiveStatus } from '../agent/live';
import type { KeySource } from '../agent/apiKey';
import type { Settings, SubtitleMode } from '../settings';
import type { Store } from '../learn/store';
import type { SessionRecord } from '../learn/types';
import type { BoardEntry, CorrectionCard, LiveScore, SessionSummary } from '../agent/dispatcher';
import { aggregateErrors, reusableWords, RECUR_MIN } from '../tutor/briefing';

export type Screen = 'conversation' | 'carnet' | 'reglages';

export interface AppCallbacks {
  onStartStop(): void;
  /**
   * Choix dans le menu du haut. La valeur est soit un scénario (partenaire pro),
   * soit un interlocuteur autonome ('prof-anglais', 'prof-espagnol'). main.ts en
   * déduit l'interlocuteur ET le scénario.
   */
  onModeChange(value: string): void;
  onSettingsChange(patch: Partial<Settings>): void;
  onProfileChange(id: string): void;
  onAddProfile(name: string): void;
  onKeyChange(key: string): void;
  onExport(): void;
  onImportFile(file: File): void;
  onWordTap(word: string): void;
  onClearNotebook(): void;
  /** Écran affiché — pour mettre le rendu du visage en pause hors conversation. */
  onScreenChange?(screen: Screen): void;
}

export interface AppDeps {
  root: HTMLElement;
  store: Store;
  settings: Settings;
  callbacks: AppCallbacks;
  buildId: string;
  hasKey: boolean;
  keySource: KeySource;
}

const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** Durée d'affichage d'un mot/phrase au tableau avant fondu de disparition. */
const BOARD_VISIBLE_MS = 15000;

export class App {
  private readonly cb: AppCallbacks;
  private readonly store: Store;
  private settings: Settings;
  private hasKey: boolean;
  private concluding = false;

  // Écrans
  private screens!: Record<Screen, HTMLElement>;
  // Conversation
  private micBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private micBar!: HTMLElement;
  private scenarioSel!: HTMLSelectElement;
  private subToggle!: HTMLButtonElement;
  private board!: HTMLElement;
  private boardTimer = 0;
  private corrections!: HTMLElement;
  private alertEl!: HTMLElement;
  private subtitles!: HTMLElement;
  private gaugeBars!: Record<'fluency' | 'accuracy' | 'vocabulary', HTMLElement>;
  private cefrBadge!: HTMLElement;
  private bilan!: HTMLElement;
  // Carnet / Réglages : conteneurs re-rendus à la demande
  private carnetBody!: HTMLElement;
  private reglagesBody!: HTMLElement;

  private buildId: string;
  private keySource: KeySource;

  constructor(deps: AppDeps) {
    this.cb = deps.callbacks;
    this.store = deps.store;
    this.settings = deps.settings;
    this.hasKey = deps.hasKey;
    this.buildId = deps.buildId;
    this.keySource = deps.keySource;
    this.build(deps.root);
    this.showScreen('conversation');
  }

  // --- Construction ----------------------------------------------------------

  private build(root: HTMLElement): void {
    clear(root);
    const convo = this.buildConversation();
    const carnet = el('section', { class: 'screen screen-panel', id: 'screen-carnet' }, [
      this.buildPanelHeader('Carnet'),
      (this.carnetBody = el('div', { class: 'panel-body' })),
    ]);
    const reglages = el('section', { class: 'screen screen-panel', id: 'screen-reglages' }, [
      this.buildPanelHeader('Réglages'),
      (this.reglagesBody = el('div', { class: 'panel-body' })),
    ]);
    this.screens = { conversation: convo, carnet, reglages };
    root.append(convo, carnet, reglages);
  }

  private buildPanelHeader(title: string): HTMLElement {
    const back = el('button', { class: 'back-btn', 'aria-label': 'Retour à la conversation' }, [
      '‹ Conversation',
    ]);
    back.onclick = () => this.showScreen('conversation');
    return el('header', { class: 'panel-header' }, [back, el('h1', { text: title })]);
  }

  private buildConversation(): HTMLElement {
    // Barre du haut — UN seul menu : les scénarios (avec le partenaire pro), puis
    // les profs autonomes (anglais, espagnol). La valeur est un ScenarioId OU un
    // InterlocuteurId ; main.ts démêle les deux (cf. onModeChange).
    this.scenarioSel = el('select', { class: 'scenario', 'aria-label': 'Mode' }) as HTMLSelectElement;
    const grpPro = el('optgroup', { label: 'Partenaire pro (anglais)' });
    for (const s of SCENARIOS) grpPro.append(el('option', { value: s.id }, [s.label]));
    const grpCours = el('optgroup', { label: 'Cours de langue' });
    for (const i of INTERLOCUTEURS) {
      if (i.id === 'pro') continue; // le « pro » est déjà représenté par ses scénarios
      grpCours.append(el('option', { value: i.id }, [i.label]));
    }
    this.scenarioSel.append(grpPro, grpCours);
    this.scenarioSel.value = this.comboValue();
    this.scenarioSel.onchange = () => this.cb.onModeChange(this.scenarioSel.value);

    const carnetTab = el('button', { class: 'icon-btn', 'aria-label': 'Carnet' }, ['📓']);
    carnetTab.onclick = () => this.showScreen('carnet');
    const reglagesTab = el('button', { class: 'icon-btn', 'aria-label': 'Réglages' }, ['⚙']);
    reglagesTab.onclick = () => this.showScreen('reglages');

    // Sous-titres du prof : bascule à portée de main (en plus du réglage). Actif =
    // fond teal ; couper efface aussi la ligne affichée.
    this.subToggle = el('button', { class: 'icon-btn', 'aria-label': 'Sous-titres du prof' }, ['💬']) as HTMLButtonElement;
    this.subToggle.onclick = () => {
      const next: SubtitleMode = this.settings.subtitles === 'off' ? 'bi' : 'off';
      this.patch({ subtitles: next });
      if (next === 'off') clear(this.subtitles);
    };

    const topbar = el('div', { class: 'topbar' }, [carnetTab, this.scenarioSel, this.subToggle, reglagesTab]);

    // Jauge live (3 barres + CEFR)
    this.gaugeBars = {
      fluency: el('span', { class: 'bar-fill' }),
      accuracy: el('span', { class: 'bar-fill' }),
      vocabulary: el('span', { class: 'bar-fill' }),
    };
    this.cefrBadge = el('span', { class: 'cefr', text: '—' });
    const gauge = el('div', { class: 'gauge' }, [
      this.gaugeRow('Fluidité', this.gaugeBars.fluency),
      this.gaugeRow('Précision', this.gaugeBars.accuracy),
      this.gaugeRow('Vocabulaire', this.gaugeBars.vocabulary),
      el('div', { class: 'cefr-wrap' }, [this.cefrBadge]),
    ]);

    // Scène centrale (transparente sur le visage)
    this.board = el('div', { class: 'board', hidden: true });
    this.corrections = el('div', { class: 'corrections' });
    // Bandeau d'alerte (rouge) : coupure/silence du prof, rendu VISIBLE à l'écran —
    // le statut en bas passe inaperçu quand on regarde le visage.
    this.alertEl = el('div', { class: 'alert', hidden: true });
    const stage = el('div', { class: 'stage' }, [this.alertEl, this.board, this.corrections]);

    // Sous-titres
    this.subtitles = el('div', { class: 'subtitles' });

    // Contrôles
    this.micBtn = el('button', { class: 'mic', 'aria-label': 'Démarrer' }, ['Parler']);
    this.micBtn.onclick = () => this.cb.onStartStop();
    this.statusEl = el('div', { class: 'status' });
    this.micBar = el('span', { class: 'mic-bar-fill' });
    const controls = el('div', { class: 'controls' }, [
      el('div', { class: 'mic-bar' }, [this.micBar]),
      this.micBtn,
      this.statusEl,
    ]);

    // Overlay de bilan
    this.bilan = el('div', { class: 'bilan', hidden: true });

    this.syncSubToggle();

    return el('section', { class: 'screen screen-convo' }, [
      topbar,
      gauge,
      stage,
      this.subtitles,
      controls,
      this.bilan,
    ]);
  }

  /** Reflète l'état des sous-titres sur le bouton 💬 de la barre du haut. */
  private syncSubToggle(): void {
    const on = this.settings.subtitles !== 'off';
    this.subToggle.classList.toggle('on', on);
    this.subToggle.setAttribute('aria-pressed', String(on));
    this.subToggle.title = on ? 'Sous-titres du prof : affichés' : 'Sous-titres du prof : masqués';
  }

  private gaugeRow(label: string, fill: HTMLElement): HTMLElement {
    return el('div', { class: 'gauge-row' }, [
      el('span', { class: 'gauge-label', text: label }),
      el('span', { class: 'bar' }, [fill]),
    ]);
  }

  // --- Navigation ------------------------------------------------------------

  showScreen(s: Screen): void {
    // Referme le clavier virtuel : un champ resté focus (Android) piège les taps et
    // donne l'impression de rester « bloqué » sur le panneau.
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const [name, node] of Object.entries(this.screens)) {
      node.hidden = name !== s;
    }
    if (s === 'carnet') this.renderCarnet();
    if (s === 'reglages') this.renderReglages();
    this.cb.onScreenChange?.(s); // après avoir démasqué : le renderer relit la taille
  }

  // --- Mises à jour Conversation --------------------------------------------

  setStatus(status: LiveStatus, detail?: string): void {
    const running = status !== 'idle' && status !== 'error';
    if (status === 'idle' || status === 'error') this.concluding = false;
    // Pendant la conclusion, le bouton reste « Terminer » : on ne le laisse pas
    // repasser à « Stop » à chaque bascule parle/écoute du bilan en cours.
    if (!this.concluding) {
      this.micBtn.textContent = running ? 'Stop' : 'Parler';
      this.micBtn.classList.toggle('on', running);
    }
    const labels: Record<LiveStatus, string> = {
      idle: this.hasKey ? 'prêt' : 'ajoute ta clé dans ⚙ Réglages',
      connecting: 'connexion…',
      listening: 'à toi',
      speaking: 'le prof parle…',
      error: detail ? `⚠ ${detail}` : '⚠ erreur',
    };
    if (this.concluding && running) {
      this.statusEl.textContent = 'le prof conclut la séance…';
      this.statusEl.classList.remove('error');
    } else {
      this.statusEl.textContent = labels[status];
      this.statusEl.classList.toggle('error', status === 'error');
    }
  }

  /** Passe le bouton en mode « Terminer » pendant que le prof fait son bilan de fin. */
  setConcluding(on: boolean): void {
    this.concluding = on;
    if (on) {
      this.micBtn.textContent = 'Terminer';
      this.micBtn.classList.add('on');
      this.statusEl.textContent = 'le prof conclut la séance…';
    }
  }

  setMicLevel(peak: number, sending: boolean): void {
    this.micBar.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
    this.micBar.classList.toggle('muted', !sending);
  }

  setGauge(s: LiveScore): void {
    // La jauge (barres + niveau) se met à jour en SILENCE. Le retour texte (l'ancien
    // bandeau orange) n'est plus affiché en direct : il parasitait le dialogue. Le
    // feedback reste consigné dans le bilan de fin.
    this.gaugeBars.fluency.style.width = `${Math.round(s.fluency * 100)}%`;
    this.gaugeBars.accuracy.style.width = `${Math.round(s.accuracy * 100)}%`;
    this.gaugeBars.vocabulary.style.width = `${Math.round(s.vocabulary * 100)}%`;
    this.cefrBadge.textContent = s.level || '—';
  }

  showBoard(entry: BoardEntry): void {
    clear(this.board);
    window.clearTimeout(this.boardTimer);
    this.board.classList.remove('fade');
    this.board.hidden = false;
    const body =
      entry.type === 'liste'
        ? el(
            'ul',
            { class: 'board-list' },
            entry.texte.split(/\r?\n/).filter(Boolean).map((line) => el('li', { text: line })),
          )
        : el('div', { class: `board-text board-${entry.type}` }, [this.tappable(entry.texte)]);
    this.board.append(body);
    if (entry.traduction) this.board.append(el('div', { class: 'board-tr', text: entry.traduction }));
    // Disparaît en fondu au bout d'un moment, plutôt que de rester jusqu'à ce qu'un
    // autre mot le chasse. Chaque nouveau tableau relance le compte (timer effacé
    // ci-dessus). Le fondu (classe .fade) dure ~0,8 s, cf. style.css.
    this.boardTimer = window.setTimeout(() => {
      this.board.classList.add('fade');
      this.boardTimer = window.setTimeout(() => {
        this.board.hidden = true;
        this.board.classList.remove('fade');
        clear(this.board);
      }, 900);
    }, BOARD_VISIBLE_MS);
  }

  /** Bandeau rouge visible (coupure, silence du prof…). Persiste jusqu'à clearAlert. */
  showAlert(message: string): void {
    this.alertEl.textContent = message;
    this.alertEl.hidden = false;
  }

  clearAlert(): void {
    this.alertEl.hidden = true;
    this.alertEl.textContent = '';
  }

  showCorrection(card: CorrectionCard): void {
    const node = el('div', { class: 'correction' }, [
      el('span', { class: 'wrong', text: card.dit }),
      el('span', { class: 'arrow', text: '→' }),
      el('span', { class: 'right', text: card.correct }),
      el('div', { class: 'why', text: card.pourquoi }),
    ]);
    this.corrections.prepend(node);
    while (this.corrections.children.length > 3) this.corrections.lastChild?.remove();
    window.setTimeout(() => node.classList.add('fade'), 12000);
    window.setTimeout(() => node.remove(), 13000);
  }

  /**
   * Sous-titre du PROF uniquement, et seulement la DERNIÈRE phrase (pas d'historique
   * empilé). La transcription de l'élève, peu fiable, n'est plus affichée — elle reste
   * dans le compte rendu (cf. main.ts). Désactivable (bouton 💬 / réglage Sous-titres).
   */
  addLine(who: 'user' | 'tutor', text: string): void {
    if (who !== 'tutor') return;
    if (this.settings.subtitles === 'off') return;
    if (!text.trim()) return;
    clear(this.subtitles);
    this.subtitles.append(el('div', { class: 'sub sub-tutor' }, [this.tappable(text)]));
  }

  /** Rend chaque mot tappable : un tap → traduction + ajout au carnet (PLAN §4). */
  private tappable(text: string): HTMLElement {
    const span = el('span');
    const parts = text.split(/(\s+)/);
    for (const p of parts) {
      if (/^\s+$/.test(p) || !p) {
        span.append(p);
        continue;
      }
      const word = el('span', { class: 'word' }, [p]);
      word.onclick = () => this.cb.onWordTap(p.replace(/[^\p{L}\p{N}'’-]/gu, ''));
      span.append(word);
    }
    return span;
  }

  showBilan(summary: SessionSummary, session: SessionRecord | null): void {
    clear(this.bilan);
    const card = el('div', { class: 'bilan-card' }, [el('h2', { text: 'Bilan de la séance' })]);
    if (summary.bravo.length) {
      card.append(el('h3', { class: 'good', text: '👏 Bravo' }));
      card.append(el('ul', {}, summary.bravo.map((b) => el('li', { text: b }))));
    }
    if (summary.resume) card.append(el('p', { class: 'resume', text: summary.resume }));
    if (summary.aTravailler.length) {
      card.append(el('h3', { text: 'À retravailler' }));
      card.append(el('ul', {}, summary.aTravailler.map((a) => el('li', { text: a }))));
    }
    if (session) card.append(this.metricsLine(session));

    // La conversation rejouée, avec les conseils intercalés — lisibles à tête
    // reposée, contrairement à l'orange en pleine session.
    const review = session ? this.buildReview(session) : null;
    if (review) card.append(review);

    const seeCarnet = el('button', { class: 'primary' }, ['Voir le carnet']);
    seeCarnet.onclick = () => {
      this.bilan.hidden = true;
      this.showScreen('carnet');
    };
    const close = el('button', { class: 'ghost' }, ['Fermer']);
    close.onclick = () => (this.bilan.hidden = true);
    const actions = el('div', { class: 'bilan-actions' }, [seeCarnet, close]);
    // Partage du bilan (mail, WhatsApp… via le partage natif du téléphone).
    if (this.canShare()) {
      const share = el('button', { class: 'ghost' }, ['Partager']);
      share.onclick = () => void this.shareBilan(summary, session);
      actions.append(share);
    }
    card.append(actions);
    this.bilan.append(card);
    this.bilan.hidden = false;
  }

  /** Déroulé de la séance (conversation + tips) pour la relecture de fin. */
  private buildReview(s: SessionRecord): HTMLElement | null {
    const entries = s.transcript ?? [];
    if (!entries.length) return null;
    const list = el('div', { class: 'review' });
    for (const e of entries) {
      if (e.kind === 'user' || e.kind === 'tutor') {
        list.append(el('div', { class: `r-line r-${e.kind}` }, [e.text]));
      } else {
        // correction (coral) / feedback (or) — un conseil intercalé.
        const tip = el('div', { class: `r-tip r-${e.kind}` }, [el('span', { class: 'r-tip-text', text: e.text })]);
        if (e.note) tip.append(el('span', { class: 'r-tip-note', text: e.note }));
        list.append(tip);
      }
    }
    return el('details', { class: 'review-wrap' }, [
      el('summary', {}, ['Revoir la conversation et les conseils']),
      list,
    ]);
  }

  private canShare(): boolean {
    return typeof navigator !== 'undefined' && (!!navigator.share || !!navigator.clipboard);
  }

  /** Partage le bilan en texte (partage natif → mail/WhatsApp ; repli presse-papier). */
  private async shareBilan(summary: SessionSummary, session: SessionRecord | null): Promise<void> {
    const text = bilanToText(summary, session);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Bilan Loro', text });
        return;
      }
    } catch {
      /* partage annulé ou refusé : on tente le repli */
    }
    try {
      await navigator.clipboard.writeText(text);
      alert('Bilan copié — colle-le dans un mail ou WhatsApp.');
    } catch {
      alert('Partage indisponible sur cet appareil.');
    }
  }

  private metricsLine(s: SessionRecord): HTMLElement {
    const spokenMin = ((s.spokenMs ?? 0) / 60000).toFixed(1);
    const words = s.newWords?.length ?? 0;
    return el('div', { class: 'metrics', text: `Temps de parole ${spokenMin} min · ${s.turns ?? 0} tours · ${words} mots nouveaux` });
  }

  // --- Carnet ---------------------------------------------------------------

  refreshNotebook(): void {
    if (!this.screens.carnet.hidden) this.renderCarnet();
  }

  private renderCarnet(): void {
    clear(this.carnetBody);
    const nb = this.store.getNotebook();
    const done = nb.sessions.filter((s) => s.endedAt);
    if (done.length === 0) {
      this.carnetBody.append(el('p', { class: 'empty', text: 'Pas encore de séance terminée. Ouvre une conversation, puis reviens ici.' }));
      return;
    }
    const last = done[done.length - 1];

    // Dernier bilan
    if (last.resume || last.bravo?.length) {
      const sec = el('div', { class: 'card' }, [el('h2', { text: 'Dernière séance' })]);
      if (last.bravo?.length) sec.append(el('p', { class: 'good', text: '👏 ' + last.bravo.join(' · ') }));
      if (last.resume) sec.append(el('p', { text: last.resume }));
      sec.append(this.metricsLine(last));
      this.carnetBody.append(sec);
    }

    // Courbe du niveau + scores dans le temps
    this.carnetBody.append(this.levelChart(done));

    // Erreurs par récurrence
    const errs = aggregateErrors(nb);
    if (errs.length) {
      const sec = el('div', { class: 'card' }, [el('h2', { text: 'Ce qui revient' })]);
      const list = el('ul', { class: 'errlist' });
      for (const e of errs.slice(0, 10)) {
        const recur = e.count >= RECUR_MIN;
        list.append(
          el('li', { class: recur ? 'recur' : '' }, [
            el('span', { class: 'tag', text: e.type }),
            el('span', { class: 'count', text: `${e.count}×` }),
            el('span', { class: 'regle', text: e.regle }),
          ]),
        );
      }
      sec.append(list);
      this.carnetBody.append(sec);
    }

    // Mots à réutiliser
    const words = reusableWords(nb, 6, 20);
    if (words.length) {
      const sec = el('div', { class: 'card' }, [el('h2', { text: 'À réutiliser' })]);
      const wrap = el('div', { class: 'chips' });
      for (const w of words) {
        wrap.append(el('span', { class: 'chip', title: w.traduction ?? '' }, [w.mot]));
      }
      sec.append(wrap);
      this.carnetBody.append(sec);
    }
  }

  /** Petite courbe SVG : niveau CEFR (0..5) et les trois scores dans le temps. */
  private levelChart(sessions: SessionRecord[]): HTMLElement {
    const pts = sessions
      .map((s) => avgScore(s))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (pts.length < 1) return el('div');
    const W = 300;
    const H = 90;
    const n = Math.max(pts.length - 1, 1);
    const x = (i: number) => (i / n) * (W - 10) + 5;
    const y = (v: number) => H - 10 - v * (H - 20); // v ∈ [0,1]
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    const series: [string, (p: NonNullable<ReturnType<typeof avgScore>>) => number][] = [
      ['s-flu', (p) => p.fluency],
      ['s-acc', (p) => p.accuracy],
      ['s-voc', (p) => p.vocabulary],
    ];
    for (const [cls, get] of series) {
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(' ');
      svg.append(svgEl('path', { d, class: cls, fill: 'none' }));
    }
    // Niveau CEFR : ligne + dernier libellé
    const cefrD = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cefr / 5).toFixed(1)}`)
      .join(' ');
    svg.append(svgEl('path', { d: cefrD, class: 's-cefr', fill: 'none' }));
    const lastCefr = CEFR[Math.round(pts[pts.length - 1].cefr)] ?? '—';
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Progression' }),
      svg,
      el('div', { class: 'legend' }, [
        el('span', { class: 'lg lg-cefr', text: `Niveau ${lastCefr}` }),
        el('span', { class: 'lg lg-flu', text: 'Fluidité' }),
        el('span', { class: 'lg lg-acc', text: 'Précision' }),
        el('span', { class: 'lg lg-voc', text: 'Vocabulaire' }),
      ]),
    ]);
  }

  // --- Réglages -------------------------------------------------------------

  setKeyState(hasKey: boolean, source: KeySource): void {
    this.hasKey = hasKey;
    this.keySource = source;
    if (!this.screens.reglages.hidden) this.renderReglages();
  }

  private renderReglages(): void {
    clear(this.reglagesBody);
    const s = this.settings;

    // Clé Gemini
    const keyInput = el('input', {
      type: 'password',
      placeholder: this.hasKey ? '•••••• (clé enregistrée)' : 'colle ta clé Gemini',
      class: 'field',
    }) as HTMLInputElement;
    const keyBtn = el('button', { class: 'primary' }, ['Enregistrer la clé']);
    keyBtn.onclick = () => {
      if (keyInput.value.trim()) this.cb.onKeyChange(keyInput.value.trim());
    };
    this.reglagesBody.append(
      this.card('Clé Gemini', [
        el('p', { class: 'hint', text: `Source actuelle : ${this.keySource}. La clé reste sur cet appareil.` }),
        keyInput,
        keyBtn,
      ]),
    );

    // Profil
    const profileSel = el('select', { class: 'field' }) as HTMLSelectElement;
    for (const p of this.store.getProfiles()) {
      const opt = el('option', { value: p.id }, [p.name]);
      profileSel.append(opt);
    }
    profileSel.value = this.store.getActiveId();
    profileSel.onchange = () => this.cb.onProfileChange(profileSel.value);
    const newProfile = el('input', { type: 'text', placeholder: 'nouveau profil', class: 'field' }) as HTMLInputElement;
    const addBtn = el('button', { class: 'ghost' }, ['Ajouter']);
    addBtn.onclick = () => {
      if (newProfile.value.trim()) {
        this.cb.onAddProfile(newProfile.value.trim());
        newProfile.value = '';
      }
    };
    this.reglagesBody.append(this.card('Profil', [profileSel, el('div', { class: 'row' }, [newProfile, addBtn])]));

    // Métier
    const job = el('input', { type: 'text', value: s.job, placeholder: 'ton métier en une phrase', class: 'field' }) as HTMLInputElement;
    job.onchange = () => this.patch({ job: job.value });
    this.reglagesBody.append(
      this.card('Métier', [
        el('p', { class: 'hint', text: 'Rend le vocabulaire pertinent. Évite les noms de clients réels.' }),
        job,
      ]),
    );

    // Voix
    const voiceSel = el('select', { class: 'field' }) as HTMLSelectElement;
    for (const v of LIVE_VOICES) voiceSel.append(el('option', { value: v.name }, [v.label]));
    voiceSel.value = s.voice;
    voiceSel.onchange = () => this.patch({ voice: voiceSel.value });
    this.reglagesBody.append(this.card('Voix du prof', [voiceSel]));

    // Volume — réglage in-app : sur mobile, la voix sort par le haut-parleur via un
    // flux que les boutons de volume du téléphone ne pilotent pas toujours ; ce
    // curseur, lui, agit toujours (gain maître, cf. VoicePlayer.setVolume).
    const volPct = Math.round(s.volume * 100);
    const vol = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(volPct), class: 'range' }) as HTMLInputElement;
    const volVal = el('span', { class: 'range-val', text: `${volPct} %` });
    vol.oninput = () => {
      volVal.textContent = `${vol.value} %`;
      this.patch({ volume: Number(vol.value) / 100 }); // à chaud : on entend le réglage en direct
    };
    this.reglagesBody.append(
      this.card('Volume', [
        el('p', { class: 'hint', text: 'Niveau de la voix du prof. Réglable ici car sur téléphone les boutons de volume n’agissent pas toujours sur ce son.' }),
        el('div', { class: 'row' }, [vol, volVal]),
      ]),
    );

    // Seuil de silence
    const sil = el('input', { type: 'range', min: '100', max: '1500', step: '50', value: String(s.silenceMs), class: 'range' }) as HTMLInputElement;
    const silVal = el('span', { class: 'range-val', text: `${s.silenceMs} ms` });
    sil.oninput = () => (silVal.textContent = `${sil.value} ms`);
    sil.onchange = () => this.patch({ silenceMs: Number(sil.value) });
    this.reglagesBody.append(
      this.card('Temps de réflexion', [
        el('p', { class: 'hint', text: 'Silence à attendre avant que le prof réponde. Bas = réponse plus rapide (mais il risque de te couper si tu hésites) ; haut = il te laisse chercher tes mots. C’est le seul délai réglable — la valeur choisie est appliquée telle quelle.' }),
        el('div', { class: 'row' }, [sil, silVal]),
      ]),
    );

    // Sous-titres
    const subSel = el('select', { class: 'field' }) as HTMLSelectElement;
    const subOpts: [SubtitleMode, string][] = [
      ['off', 'Aucun'],
      ['en', 'Anglais'],
      ['bi', 'Bilingue'],
    ];
    for (const [val, label] of subOpts) subSel.append(el('option', { value: val }, [label]));
    subSel.value = s.subtitles;
    subSel.onchange = () => this.patch({ subtitles: subSel.value as SubtitleMode });
    this.reglagesBody.append(this.card('Sous-titres', [subSel]));

    // Export / import
    const exportBtn = el('button', { class: 'ghost' }, ['Exporter le carnet']);
    exportBtn.onclick = () => this.cb.onExport();
    const importInput = el('input', { type: 'file', accept: 'application/json', class: 'field' }) as HTMLInputElement;
    importInput.onchange = () => {
      const f = importInput.files?.[0];
      if (f) this.cb.onImportFile(f);
    };
    const clearBtn = el('button', { class: 'danger' }, ['Vider ce carnet']);
    clearBtn.onclick = () => {
      if (confirm('Vider le carnet de ce profil ? (irréversible)')) this.cb.onClearNotebook();
    };
    this.reglagesBody.append(
      this.card('Carnet', [exportBtn, el('p', { class: 'hint', text: 'Importer un fichier Loro :' }), importInput, clearBtn]),
    );

    // Build id
    this.reglagesBody.append(el('div', { class: 'buildid', text: `build ${this.buildId}` }));
  }

  private patch(p: Partial<Settings>): void {
    this.settings = { ...this.settings, ...p };
    this.cb.onSettingsChange(p);
    if ('subtitles' in p) this.syncSubToggle();
  }

  /** Reçoit les réglages courants (après import, p.ex.) pour re-synchroniser les formulaires. */
  setSettings(s: Settings): void {
    this.settings = s;
    this.scenarioSel.value = this.comboValue();
    this.syncSubToggle();
    if (!this.screens.reglages.hidden) this.renderReglages();
  }

  /**
   * Valeur du menu du haut : l'interlocuteur s'il n'est pas le partenaire « pro »
   * (prof d'anglais/espagnol), sinon le scénario en cours.
   */
  private comboValue(): string {
    return this.settings.interlocuteur !== 'pro' ? this.settings.interlocuteur : this.settings.scenario;
  }

  private card(title: string, children: (Node | string)[]): HTMLElement {
    return el('div', { class: 'card' }, [el('h2', { text: title }), ...children]);
  }
}

/** Met le bilan en texte simple, pour le partage (mail / WhatsApp). */
function bilanToText(summary: SessionSummary, session: SessionRecord | null): string {
  const L: string[] = ['Bilan de séance — Loro', ''];
  if (summary.bravo.length) {
    L.push('👏 Bravo :');
    for (const b of summary.bravo) L.push(`  • ${b}`);
    L.push('');
  }
  if (summary.resume) L.push(summary.resume, '');
  if (summary.aTravailler.length) {
    L.push('À retravailler :');
    for (const a of summary.aTravailler) L.push(`  • ${a}`);
    L.push('');
  }
  const entries = session?.transcript ?? [];
  if (entries.length) {
    L.push('— La conversation et les conseils —', '');
    for (const e of entries) {
      if (e.kind === 'user') L.push(`Moi : ${e.text}`);
      else if (e.kind === 'tutor') L.push(`Prof : ${e.text}`);
      else if (e.kind === 'correction') L.push(`  ✎ ${e.text}${e.note ? ` (${e.note})` : ''}`);
      else L.push(`  💡 ${e.text}`);
    }
  }
  return L.join('\n');
}

/** Score moyen d'une séance + niveau CEFR moyen (0..5), null si aucune notation. */
function avgScore(s: SessionRecord): { fluency: number; accuracy: number; vocabulary: number; cefr: number } | null {
  const valid = s.scores.filter((x) => x.fluency || x.accuracy || x.vocabulary);
  if (valid.length === 0) return null;
  const mean = (get: (x: (typeof valid)[number]) => number) => valid.reduce((a, x) => a + get(x), 0) / valid.length;
  const cefrIdx = (lvl: string) => {
    const i = CEFR.indexOf(lvl);
    return i < 0 ? NaN : i;
  };
  const cefrVals = valid.map((x) => cefrIdx(x.level)).filter((n) => !Number.isNaN(n));
  const cefr = cefrVals.length ? cefrVals.reduce((a, b) => a + b, 0) / cefrVals.length : 0;
  return { fluency: mean((x) => x.fluency), accuracy: mean((x) => x.accuracy), vocabulary: mean((x) => x.vocabulary), cefr };
}
