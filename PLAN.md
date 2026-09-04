# Loro — partenaire de conversation en anglais

## Context

Deux adultes ont besoin d'anglais opérationnel, sans échéance précise mais en continu : elle doit prendre
la parole en anglais, lui se déplace chez des clients dans le monde entier. Ses points durs à lui sont
identifiés — **vocabulaire métier et small talk**, et **négocier / dire non poliment**, c'est-à-dire les
registres où une traduction littérale du français passe très mal.

Le principe directeur, donné par l'utilisateur : **c'est le dialogue qui fait progresser, et c'est lui qui
motive**. Pas de monologue chronométré, pas de mode exercice solitaire. On ouvre l'app, on parle dix
minutes à quelqu'un, on ferme.

Ce qu'une app perso ajoute et que les autres ne font pas : **elle se souvient**. La séance s'ouvre sur ce
qui a coincé la fois d'avant, et te le refait faire sans le dire.

Mochi a déjà résolu tout le socle audio temps réel sur le vrai matériel : routage Android, portillons
micro, watchdog de parole, clé sur l'appareil, PWA, déploiement Pages. On repart de là.

Et il existe un **précédent direct** : `NetBeansProjects/AI/EnglishTeacher`, une version Java/Swing du même
projet. Elle avait déjà trouvé deux briques qu'on reprend telles quelles (les *concepts*, pas le code
Swing/WebSocket) : la **notation à la volée par function call** (`evaluate_english_level`) et les **notes
du prof réinjectées d'une séance à l'autre** (`synthesize_progress` → `teacher_notes`, dont le
`default_student.json` existant parle déjà du « th » à travailler). Ce plan les porte dans la stack
TS/web de Mochi et ajoute ce qui manquait : un journal d'erreurs structuré pour cibler les lacunes (§3.5).

**Décisions** : adultes d'abord (profils enfants en v2, mais rien construit pour eux) · progression
continue, pas de compte à rebours · visage SDF de Mochi réutilisé · carnet en localStorage avec
export/import · **pas de mode prononciation séparé** (cf. §5).

**Nom** : `loro`. Dépôt GitHub **en minuscules**, `base: '/loro/'` — contrainte héritée de Mochi
(`vite.config.ts:60-72` : github.io est sensible à la casse). Répertoire local `Prof/` comme demandé.
Facile à renommer avant le premier déploiement, coûteux après.

---

## 1. Ce qu'on reprend de Mochi

### Copié tel quel

`src/audio/pcm-recorder.worklet.js` · `src/audio/mic.ts` (garder `echoCancellation:false`, cf.
`mic.ts:70-97`) · `src/audio/vad.ts` · `src/face/*` (4 fichiers) · `src/pwa.ts` ·
`.github/workflows/pages.yml`.

`src/audio/voicePlayer.ts` — une seule modif : `DEFAULT_PITCH` → **1.0** (un prof doit sonner natif).
`src/agent/apiKey.ts` — `STORAGE_KEY` → `loro.geminiKey`.
`vite.config.ts` — `base: '/loro/'` et **`port: 5175`** (5174 est à Mochi ; les deux doivent pouvoir
tourner en même temps).

### Deux adaptations qui comptent

**a) Le seuil de fin de parole.** `VAD_SILENCE_MS = 650` est réglé pour donner un ordre à un robot ;
quelqu'un qui cherche ses mots en anglais hésite plus longtemps, et le commentaire de `liveConfig.ts:28-40`
dit déjà que trop court = phrase coupée en deux = « il ne comprend pas ». **Défaut 900 ms, réglable dans
les réglages.** Un curseur, pas une table par niveau.

**b) Reprise de session.** Une session audio seule est plafonnée à **15 minutes**. Mochi meurt et laisse
relancer (`live.ts:236-248`) ; ici il faut que ça passe inaperçu :

```ts
sessionResumption: { handle: this.resumeHandle, transparent: true }
// onmessage
if (m.sessionResumptionUpdate?.newHandle) this.resumeHandle = m.sessionResumptionUpdate.newHandle;
if (m.goAway?.timeLeft) this.scheduleReconnect(m.goAway.timeLeft);
```

⚠️ Le piège : `teardown()` de Mochi **tue le micro et le lecteur** (`live.ts:299-320`). Une reconnexion
doit garder `MicCapture` et `VoicePlayer` vivants et ne remplacer que la `Session`, en tamponnant les
paquets micro pendant le trou. C'est le seul morceau vraiment neuf du socle audio.

Modèle : `gemini-3.1-flash-live-preview`, constante unique de `liveConfig.ts`.

---

## 2. Le personnage et les règles

`src/tutor/persona.ts`, structure calquée sur `agent/persona.ts` : **PERSONA + RÈGLES + FICHE ÉLÈVE**.

Un interlocuteur anglophone crédible, pas un professeur scolaire — un collègue étranger sympathique qui
te reprend quand c'est utile. Voix préfabriquée au choix parmi les 30 disponibles (départ : `Achird`,
amical, ou `Puck`). Le sélecteur de voix de Mochi se réutilise ; changer de voix relance la session, ce que
`live.ts:146-156` fait déjà.

Note technique : les modèles audio natifs **choisissent la langue seuls** et n'acceptent pas de
`languageCode`. La langue cible se pilote uniquement par le prompt.

Règles à écrire, les non-évidentes d'abord :

- **Le prof travaille les lacunes, il ne fait pas que réagir — mais c'est LUI qui décide lesquelles.**
  La fiche élève lui donne les points qui reviennent, avec leur nombre d'occurrences (cf. §3.5), comme une
  **information objective**, pas comme une liste d'ordres. À lui d'en tenir compte *en connaissance de
  cause* : les croiser avec ce que l'élève demande aujourd'hui, avec le sujet du moment, avec une faiblesse
  qu'il entend apparaître en direct. Quand il a choisi, sa consigne est d'**orienter la conversation pour
  la faire resurgir** sans l'annoncer — amener l'élève sur ses projets de la semaine pour qu'il doive
  employer le futur, parler d'une demande à refuser pour retomber sur la négociation. La manœuvre reste
  invisible : dès qu'elle est annoncée (« on va travailler le présent parfait »), l'exercice remplace la
  conversation, et on retombe dans ce qui n'accroche pas.
  ⚠️ Ne PAS transformer la fiche en programme rigide dans le prompt : « voici ce qui revient souvent, à toi
  de juger quoi en faire » vaut mieux que « travaille ces trois points » — sinon le prof devient borné et
  ignore la personne en face au profit de sa liste.
- **C'est l'élève qui parle.** Objectif explicite : le prof occupe moins d'un tiers du temps de parole. Il
  relance par des questions ouvertes et **ne comble pas les silences**. C'est la règle qui porte tout le
  reste — « parler seul ne fait pas progresser », mais un prof bavard produit exactement ça à l'envers.
- **Correction par reformulation** (*recast*) : reprendre naturellement la forme correcte dans la réponse
  plutôt que de s'arrêter. `corrige` (§3) est réservé à ce qui se répète.
- **Le registre avant la grammaire.** Sur « dire non », « annoncer un retard », « pousser un point », ce
  qui casse n'est pas la grammaire mais le ton : la traduction littérale du français passe pour brutale.
  Le prof signale ça en priorité, et propose la formule anglaise usuelle.
- **Longueur** : deux phrases par défaut. Même raison que dans `persona.ts:46-48` — *pendant qu'il parle,
  il n'entend plus*, donc une tirade oblige à attendre sans pouvoir l'interrompre.
- **Français rare** : seulement si on le demande, ou pour débloquer un mot. Deux phrases maximum d'affilée.
- **Il n'a pas d'yeux** (`persona.ts:29`) — il n'entend que la voix, et le prétendre autrement casse tout.
- **Ne jamais mentionner le carnet ni les outils** (cf. §3).

### Scénarios

Un simple menu ; chaque scénario n'est qu'un paragraphe ajouté au prompt. Coût quasi nul, valeur élevée :

| Scénario | Ce qu'il travaille |
|---|---|
| Conversation libre | l'entretien courant |
| Small talk client | dîner, taxi, avant-réunion — tenir vingt minutes avec un inconnu |
| Dire non, négocier | refuser, annoncer un retard, nuancer, pousser un point |
| Défendre une idée | présenter puis répondre aux objections, **en dialogue** |
| Vocabulaire métier | le prof t'emmène sur ton domaine |

Pour le dernier, un champ dans les réglages : **« ton métier en une phrase »**, injecté dans le prompt.
Deux lignes de code, et c'est ce qui rend le vocabulaire pertinent plutôt que générique.

---

## 3. Le carnet

### Pendant la séance : le prof écrit en parlant

`src/agent/tutorTools.ts`, même format neutre que `intents.ts`, converti par `toGeminiTools()`.

**Silencieux** (journalisation, aucun effet visible) :

| Outil | Arguments |
|---|---|
| `note_erreur` | `type` (grammaire\|vocabulaire\|prononciation\|**registre**), `dit`, `correct`, `regle` |
| `note_mot` | `mot`, `traduction`, `exemple` |
| `note_reussite` | `quoi` |

**Visibles** :

| Outil | Effet |
|---|---|
| `ecris` (`texte`, `type`: phrase\|mot\|liste, `traduction?`) | **le tableau** — voir le mot qu'on vient d'entendre |
| `corrige` (`dit`, `correct`, `pourquoi`) | carte de correction + journalisation |
| `evaluate_english_level` (`fluency`, `accuracy`, `vocabulary` 0-1, `level` CEFR, `feedback`) | **la jauge live** (§4) — repris tel quel de EnglishTeacher |
| `fin_de_seance` (`resume`, `a_travailler[]`, `bravo[]`) | écran de bilan + `teacher_notes` du carnet |

Consigne de déclenchement de la notation, reprise de EnglishTeacher : **toutes les 2-3 répliques**, et
tout de suite si l'élève la demande — « mets 0 partout si tu n'as pas encore de quoi juger » plutôt que de
sauter l'appel. C'est ce qui fait bouger la jauge pendant la conversation, au lieu d'un verdict en fin de
séance seulement.

**Expression** (repris de Mochi) : `express`, `look`, `blink`.

Deux règles de conception héritées de Mochi :

- **Les outils silencieux doivent être déclarés silencieux dans le prompt**, sinon le modèle annonce « je
  note ça ! ». C'est le symétrique exact du piège des didascalies `[[…]]` (`live.ts:275-285`) : dire à un
  modèle de faire quelque chose l'amène à *en parler*.
- **`note_erreur` fait lever un sourcil, automatiquement.** Pas d'outil dédié : le dispatcher branche le
  journal ET le visage. La faute est signalée à l'instant où elle tombe, sans couper la phrase ; la
  correction explicite vient à la fin du tour. C'est aussi ce qui justifie le visage pour des adultes —
  ça, plus le fait de savoir à qui est le tour de parole.

### Entre les séances : le briefing

`src/tutor/briefing.ts` compile le carnet en un bloc court injecté dans le **`systemInstruction`** :

```
FICHE ÉLÈVE — Sébastien. Anglais professionnel, déplacements clients à l'international.
Métier : <la phrase des réglages>.
BRAVO LA DERNIÈRE FOIS : a refusé une demande sans traduire « je ne peux pas » littéralement.
À CORRIGER EN PRIORITÉ (3 occurrences) :
  • « I am agree » → « I agree »
  • registre : « you must send me » → « could you send me… »
À FAIRE RÉUTILISER : to push back · a heads-up · I'd rather · let me get back to you
```

⚠️ **Dans le `systemInstruction`, pas dans un tour de chat.** Le commentaire de `liveConfig.ts:64-84` le
dit : la fenêtre glissante jette les vieux tours, mais les instructions système restent hors fenêtre. Un
briefing envoyé comme message serait oublié vers la douzième minute — quand il sert le plus. C'est aussi
pourquoi le ciblage des lacunes (§2) tient dans la durée : la consigne d'orienter la conversation est dans
le prompt système, elle survit à la compression.

Ordre voulu : **bravo d'abord**. On ouvre sur une réussite.

### 3.5 Comment une lacune est identifiée et ciblée

Le partage du travail est le point clé, et il donne le meilleur des deux mondes : **l'app compte et se
souvient, le modèle juge et décide.**

Ce que fait l'**app** — comptage déterministe, local et gratuit dans `briefing.ts`, aucun appel modèle :

1. `note_erreur` accumule chaque faute avec son `type` et sa `règle`.
2. Le briefing agrège par `(type, règle)` sur les dernières séances et **compte**. Une faute isolée n'est
   pas une lacune ; **la même revenue ≥ 3 fois** ressort comme récurrente.
3. Les points récurrents remontent dans la fiche élève avec leur nombre d'occurrences — c'est une
   photographie factuelle, pas une consigne.
4. Un point qui ne réapparaît plus sur plusieurs séances **redescend** : la fiche reflète ce qui est encore
   vivant. `test-briefing.mjs` (§7) vérifie qu'elle ne s'encombre pas de points éteints.

Pourquoi ce n'est pas le modèle qui compte : à travers la compression du contexte (`liveConfig.ts:64-84`),
il oublie les vieux tours et ne peut pas tenir un décompte fiable sur plusieurs séances. Le comptage est
exactement ce qu'une machine fait mieux qu'un modèle — une **mémoire objective**, non subjective.

Ce que fait le **modèle** : il reçoit cette photographie et **décide en connaissance de cause** quoi
travailler, en la croisant avec la conversation en cours et les demandes de l'élève. Il peut suivre une
récurrence, la laisser de côté parce que l'élève veut autre chose aujourd'hui, ou attaquer une faiblesse
qu'il vient d'entendre et qui n'est pas encore dans la fiche. Le décompte l'informe ; il ne le contraint
pas. C'est ce qui évite le prof borné qui drague sa liste au lieu d'écouter la personne — et c'est aussi
ce qui laisse l'élève **demander à la volée** (« aujourd'hui je veux bosser les prépositions »), ce qu'une
détection rigide interdirait.

### Où ça vit

**localStorage**, en JSON — pas d'IndexedDB. Sans enregistrements audio, le carnet est du texte : quelques
centaines de Ko. `src/learn/store.ts` (lecture/écriture/purge) + `src/learn/export.ts` (un fichier JSON à
exporter/importer pour changer de téléphone). Deux profils, sélectionnés dans les réglages.

---

## 4. Écrans

Trois, pas plus.

1. **Conversation** — visage plein écran ; sous-titres (off / anglais / bilingue, un tap sur un mot →
   traduction et ajout au carnet) ; le tableau ; les cartes de correction ; le menu de scénario ; un
   minuteur ; et **la jauge live** — trois barres (fluidité / précision / vocabulaire) + niveau CEFR,
   mises à jour par `evaluate_english_level` toutes les 2-3 répliques (le `EvaluationPanel` de
   EnglishTeacher, en HTML). Discrète, en coin : elle bouge pendant qu'on parle, c'est le ressort motivant.
   C'est l'écran qu'on ouvre, il doit démarrer en un geste.
2. **Carnet** — bilan de la séance qui vient de finir, puis l'historique : **courbe du niveau CEFR et des
   trois scores** dans le temps (les seuls chiffres qu'on garde), erreurs par type et récurrence, mots à
   réutiliser, temps de parole.
3. **Réglages** — clé Gemini (repris de `devPanel.ts:332-360`), profil, métier, voix, seuil de silence,
   gain micro, export/import.

**Métriques calculées localement**, sans modèle (donc fiables et gratuites) : temps de parole réel (VAD
locale), longueur moyenne de tour, mots/minute, et **les mots produits spontanément pour la première fois**
(jetons de `inputTranscription` comparés à l'ensemble « déjà produit » du profil). Pas « mots vus » — mots
sortis de ta bouche.

**La séance dure dix minutes par conception.** Le plafond de 15 min devient un rituel : cloche à 9 min, le
prof enchaîne sur la récapitulation. La reprise de session (§1b) est là pour ne jamais couper au milieu.

---

## 5. La notation : à la volée, pas en pipeline

On **garde** la notation à la volée de EnglishTeacher (`evaluate_english_level`, §3-§4) : le modèle écoute
la conversation et renvoie fluidité / précision / vocabulaire / niveau CEFR toutes les 2-3 répliques.
Vivant, motivant, quasi gratuit, et déjà éprouvé.

On **ne fait pas** de mode prononciation séparé façon ELSA : phrases de référence fixes, enregistrement
WAV, notation `generateContent` sur schéma JSON, réécoute comparée. Pourquoi :

- « Parler seul ne fait pas progresser » — la prononciation se travaille dans le dialogue. Le prof dit le
  mot, tu le répètes, il te dit ; `note_erreur` type=prononciation accumule les sons qui reviennent, et le
  carnet les affiche par récurrence. C'est ce qui a déjà remonté ton « th » dans l'ancienne version.
- Ce pipeline exigerait un banc de variance préalable, parce que Gemini n'est pas un noteur de phonèmes :
  si le juge note le même clip à ±1 niveau, une courbe d'accent ne mesure rien. Ça reste ajoutable plus
  tard si le besoin d'un vrai chiffre d'accent se fait sentir — mais ce n'est pas la v1.

**Honnêteté sur la jauge** : le score à la volée est l'avis subjectif du modèle sur ce qu'il vient
d'entendre, pas une mesure. Il bouge d'une séance à l'autre pour des raisons qui ne sont pas toutes ta
progression. On l'affiche comme un **indicateur qui encourage**, pas comme une note — c'est le bon usage,
et c'est ainsi qu'il fonctionnait déjà.

- **Pas de compte à rebours ni d'échéance** — progression continue.
- **Pas de profils enfants, pas de jeux, pas de streak.** Le socle (persona et scénarios paramétrés par
  profil) les rend faciles à ajouter en v2 ; on n'en construit rien.
- **Pas d'IndexedDB, pas de SRS formel.** Les mots à réutiliser sont une simple liste triée par
  récurrence et ancienneté.

---

## 6. Étapes

**Phase 0 — squelette et banc de config.** Projet Vite+TS, copie du §1, `liveConfig.ts` adapté
(resumption + seuil réglable), et `scripts/test-live-config.mjs` porté **en premier** : il envoie le vrai
bloc et attend `setupComplete`. Un champ refusé = aucune session, muet, sur le téléphone.

**Phase 1 — une conversation qui tient.** `live.ts` adapté, micro/voix/visage branchés, personnage unique.
Reconnexion sur `goAway`. **Livrable : utilisable tous les jours dès la fin de cette phase** — dix minutes
d'anglais sur le téléphone, sans coupure. Tout le reste améliore ça, rien ne le remplace.

**Phase 2 — le prof enseigne.** `tutorTools.ts` et son dispatcher, tableau, sous-titres +
tap-pour-traduire, cartes de correction, sourcil sur `note_erreur`, **jauge live
(`evaluate_english_level`)**, menu de scénarios, champ métier.

**Phase 3 — la mémoire et la mise en ligne.** Carnet localStorage, profils, `briefing.ts`, écran de bilan,
export/import, PWA (manifeste, service worker, démarrage en un geste), workflow Pages.
C'est ici que la deuxième séance s'ouvre sur ce qui a coincé à la première.

---

## 7. Vérification

- **`scripts/test-live-config.mjs`** — vraie session avec le bloc réel, attend `setupComplete`. Contrôle
  négatif : une voix inexistante doit échouer en `1007 No matching speaker voice found`.
- **`scripts/test-briefing.mjs`** — carnet factice → briefing : vérifie qu'il reste court et qu'un point
  déjà acquis n'y revient pas.
- **Reconnexion** — session poussée au-delà de 15 min : `goAway` reçu, reconnexion silencieuse, et **le
  prof se souvient encore du début** (poser une question sur ce qui a été dit à la minute 2).
- **Sur téléphone, à 50 cm** — le test qui compte. Toute la leçon `mic.ts:70-97` : à 5 cm, tout marche, y
  compris ce qui est cassé. Vérifier aussi le volume de sortie (routage `<audio>`, `onRoute`).
- **Part de parole de l'élève > 60 %** sur une vraie séance (mesurée, §4). Si le prof parle plus que toi,
  le prompt est à reprendre avant toute autre chose.

## 8. À savoir

- **C'est gratuit.** Le palier gratuit couvre `gemini-3.1-flash-live-preview` — et Mochi le démontre déjà
  en Live **avec** function calling, sans jamais toucher de limite (les appels d'outils sont quelques
  dizaines de jetons à côté de l'audio). Les tarifs payants (~0,11 € la séance de 10 min) ne sont qu'un
  filet.
- **La contrainte est le quota, pas la facture.** Les limites du palier gratuit ne sont pas publiées ;
  elles se lisent dans le tableau de bord AI Studio — à relever en phase 1. Une clé = un quota, partagé
  par les deux profils ; deux clés si ça coince, ce que le stockage par appareil rend naturel.
  Ce sont des modèles **preview** : ils peuvent changer. Le nom du modèle est une constante unique, et le
  banc de config transforme « le modèle a bougé » en échec net plutôt qu'en app muette.
- **Une coupure pour quota doit se dire** — leçon du commit `4530a61` de Mochi : une session qui meurt en
  silence est indiscernable d'un prof qui n'écoute plus.
- Au palier gratuit, les conditions de l'API prévoient que le contenu serve à améliorer les produits Google
  et puisse être lu par des évaluateurs. Sans conséquence pour des exercices d'anglais professionnel ;
  éviter simplement les noms de clients réels dans le champ métier.
- **La clé vit dans le localStorage de chaque téléphone** (`apiKey.ts:1-24`) — rien de secret dans le
  bundle, donc hébergement statique.
