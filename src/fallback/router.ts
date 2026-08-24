/**
 * Router fallbacku: prompt → capability vektor → archetyp nebo `NO_FIT`.
 *
 * Dělba práce je z `ARCHETYPES.md` §1 a nesmí se rozmazat:
 *
 * ```
 * extrakce → capability vektor (uzavřený slovník)
 * kód      → množinová aritmetika nad manifesty → deterministické pořadí → top-1 nebo NO_FIT
 * ```
 *
 * `route()` **nerozhoduje podle slov v promptu**. Vidí vektor a manifesty; text
 * promptu použije jedinou věcí, a to stabilním hashem na rozseknutí remízy (§4).
 * Kdyby rozhodovalo klíčové slovo, `NO_FIT` by přestal být odvozený a systém by
 * uměl tiše nabídnout nejbližší archetyp na prompt, který nesplňuje žádný.
 *
 * Zdrojem vektoru je tady **lexikální matcher**, ne model (`ARCHETYPES.md` §4,
 * „lokální provizorní routa"). Stejné rozhodovací pravidlo, jiný zdroj vektoru —
 * proto fallback nevypadá jako jiný produkt. A hlavně: běží bez sítě a bez
 * placeného modelu, což je celý smysl pojistky.
 */

import {
  CAPABILITY_TOKENS,
  MANIFESTS,
  TOKEN_SENTENCES,
  canonicalVector,
  isCapabilityToken,
  type ArchetypeId,
  type CapabilityToken,
  type Manifest,
} from './manifests';

export type ArchetypeDecision = {
  readonly kind: 'archetype';
  readonly archetype: ArchetypeId;
  readonly title: string;
  /** Všechny proveditelné archetypy, v pořadí, ve kterém prošly řazením §4. */
  readonly feasible: readonly ArchetypeId[];
  readonly required: readonly CapabilityToken[];
  readonly sceneLayout: string;
  readonly reason: string;
};

export type NoFitDecision = {
  readonly kind: 'no_fit';
  /** Kandidát s nejmenším počtem blokujících tokenů. Jeho scénu `NO_FIT` ukáže. */
  readonly nearest: ArchetypeId;
  readonly blocking: readonly CapabilityToken[];
  readonly required: readonly CapabilityToken[];
  readonly sceneLayout: string;
  readonly reason: string;
};

export type RouteDecision = ArchetypeDecision | NoFitDecision;

/**
 * FNV-1a nad UTF-8 bajty. Ručně, ~10 řádků, bez WASM a bez závislosti.
 *
 * Musí být stabilní napříč běhy i platformami, protože na něm visí třetí
 * tie-break z §4 — a ten existuje jen proto, aby nestabilita routování měřila
 * varianci extrakce, ne varianci řadicího kódu.
 */
export function stableHash(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Lexikální pravidla pro extrakci vektoru.
 *
 * Tabulka, ne kód, aby šla přečíst a otestovat celá. Držená pravidla
 * `ARCHETYPES.md` §2:
 *  - modalita (`IN_*`) jen když ji prompt vynucuje;
 *  - výkon a bezpečnost nikdy nejsou tokeny;
 *  - vágní prompt smí skončit prázdným vektorem — to je platný výsledek.
 *
 * Vzory pro `REQ_*` jsou schválně užší než pro `STATE_*`: `REQ_*` tokeny jsou
 * to, co archetypy zakazují, takže falešně pozitivní vzor tam vyrobí zbytečný
 * `NO_FIT`, kdežto u `STATE_*` nanejvýš přidá token, který je všem manifestům
 * lhostejný.
 */
export const LEXICON: readonly (readonly [CapabilityToken, RegExp])[] = [
  ['GOAL_COLLECT_N', /\b(collect|gather|pick up all|find (three|four|five|all)|posbírej)\b/],
  ['GOAL_COLLECT_N', /\b(three|four|five|six|seven|\d+)\s+\w*\s*(keys|coins|orbs|gems|items|shards|stars)\b/],
  ['GOAL_DELIVER', /\b(deliver|bring (the|a|me)?|carry .* to|drop off|take .* back)\b/],
  ['GOAL_ARRANGE', /\b(sort|match(ing)?|arrange|organi[sz]e|pair up|into the right)\b/],
  ['GOAL_SEQUENCE', /\b(in order|correct order|step by step|sequence|one after|combination|digit code)\b/],
  ['GOAL_REACH', /\b(reach|escape|exit|maze|labyrinth|labyrinth|finish line|get to the|race)\b/],
  ['GOAL_SURVIVE_T', /\b(survive|stay alive|hold out|last \d|tower defen[cs]e|floods|evacuat)/],
  ['GOAL_THRESHOLD', /\b(score|points|level up|harvest|grow(s)? (over time|if)|until it reaches|day \d)\b/],

  ['ACT_PLAYER_DIRECT', /(^|\W)(i|me|my|myself)(\W|$)/],
  ['ACT_PLAYER_DIRECT', /\b(player|you can|let me|clicked|when i)\b/],
  ['ACT_PLAYER_INDIRECT', /\b(tower defen[cs]e|place (ramps|defenders|tools|traps)|guide|steer|so (it|they) can|help (it|them) )/],
  ['ACT_AUTONOMOUS', /\b(npc|npcs|guards?|enem(y|ies)|monsters?|animals?|birds?|fish|crowd|traffic|patrol(s|ling)?|merchants?|thieves|shopkeeper|robot|walker|wolves|cat|bee|blacksmith|kovář|minotaurus)\b/],
  ['ACT_AUTONOMOUS', /\b(by (itself|themselves)|on (its|their) own|autonomous|wander|roam|each other)\b/],

  ['STATE_DISCRETE', /\b(when|if|until|unless|after|opens?|closes?|locked|unlocked|toggles?|switch(es)?|light(s)? up|turns? (on|off)|stage|phase|mode)\b/],
  ['STATE_COUNTER', /\b(counter|count|score|points|coins|money|lives|health|stock|how many|number of|budget|change)\b/],
  ['STATE_TIMER', /\b(seconds?|minutes?|timer|countdown|clock|over time|slowly|every \w+ seconds|day and night|day\/night|at night|deadline)\b/],
  ['STATE_QUEUE', /\b(queue|queues|waiting|bottleneck|conveyor|elevator|calls|requests|orders|line up|takes turns|before moving)\b/],
  ['STATE_CONTINUOUS', /\b(momentum|bounc(e|ing|y)|ripples?|airflow|smooth(ly)?|continuous|gravity|falls? (off|over)|flow(s|ing)?|drift|speeds? up|faster and faster|to scale)\b/],
  ['STATE_INVENTORY', /\b(inventory|backpack|carry (only|three|\d)|only carry|drop one|slots?)\b/],
  ['STATE_PERSISTENT_MEMORY', /\b(remember(s|ed)?|memory|previous run|last time|every time i|each time i|persist)\b/],

  ['IN_CLICK', /\b(click(ed|ing)?|tap|press(ing|es)?|button|push the|hit(ting)? (each|the))\b/],
  ['IN_DRAG', /\b(drag|dragging|throw(ing)?|rake|snap|place (it|them|ramps|walls)|put .* (on|onto|in) the)\b/],
  ['IN_MOVE', /\b(walk(ing)? (through|around|close)|move around|run around|explore|navigate|i move|follow(s)? me|stand in)\b/],
  ['IN_AIM', /\b(shoot|shooting|aim|fire at|kill|gun|target(s)? that|střílet)\b/],
  ['IN_TIMED', /\b(rhythm|on the beat|in time with|timing|press when|just as it)\b/],
  ['IN_TEXT', /\b(type|typing|enter the code|write|four digit|tell it|told it)\b/],

  ['REQ_MULTI_SOURCE_INPUT', /\b(at the same time|inside and outside|both .* and the|three (people|players)|two (players|switches|levers))\b/],
  ['REQ_MULTI_SOURCE_INPUT', /\b\w+ and the (sun|wind|power) is\b/],
  ['REQ_DATA_BINDING', /\b(chart|graph|dashboard|data visuali[sz]ation|axis|axes|to scale|stock level|quarterly|labelled atoms|correct .* heights|area updates)\b/],
  ['REQ_PATHFIND_GRID', /\b(grid|maze|labyrinth|path(s)? (to|through)|enemy path|follows me around|pathfind)\b/],
  ['REQ_PATHFIND_FREE', /\b(around moving obstacles|avoid(ing)? each other|free navigation|steer(s)? around)\b/],
  ['REQ_PHYSICS_SIM', /\b(physics|bouncing|stack(ed|ing)|collapse(s)?|topple|marble|ramps?|collide|thrown at|falls? over)\b/],
  ['REQ_FREEFORM_BUILD', /\b(build(er)?|editor|sculpt|draw (new|walls)|drag walls|create geometry|place new)\b/],
  ['REQ_DIALOGUE', /\b(conversation|dialogue|talk(s|ing)? (to|at|once)|says?|say(s)? their|tells? (you|me)|speak|argue|chat)\b/],
  ['REQ_TEXT_RENDER', /\b(label(l?ed|s)?|text|sign(s)?|score|counter|story|its name|readable|number(s)? (on|above)|exit signs|in spanish)\b/],
  ['REQ_MULTI_AGENT', /\b(two (teams|roles|kinds|types)|differently|different behaviour|multiple (agents|characters)|all talking|merchants .* thieves|defenders .* enem)/],
  ['REQ_NARRATIVE', /\b(plot|narrative|chapter|branching|story ?line|ending changes)\b/],
  ['REQ_BEHAVIOUR_EDIT', /\|\s*(now |actually |make |undo)/],
];

const CONTENT_WORD = /[\p{L}]{2,}/gu;

/**
 * Prompt → capability vektor. Deterministické, bez sítě, bez modelu.
 *
 * `GOAL_NONE` se doplní jen tehdy, když prompt popisuje konkrétní scénu a
 * nevyžaduje žádnou výhru. Vágní prompt („a place", „fun") žádný token nedostane
 * — prázdný vektor je podle §2 platný výsledek a znamená „všechny archetypy jsou
 * proveditelné", ne „nevím".
 */
export function extractVector(prompt: string): CapabilityToken[] {
  const text = prompt.normalize('NFC').toLowerCase();
  const found = new Set<CapabilityToken>();

  for (const [token, pattern] of LEXICON) {
    if (pattern.test(text)) {
      found.add(token);
    }
  }

  const hasGoal = [...found].some((token) => token.startsWith('GOAL_'));
  const contentWords = text.match(CONTENT_WORD)?.length ?? 0;
  if (!hasGoal && contentWords >= 4) {
    found.add('GOAL_NONE');
  }

  return canonicalVector(found);
}

/**
 * Token, který ve vektoru stojí, ale **není požadavek**.
 *
 * `GOAL_NONE` podle §2 znamená „prompt nepopisuje žádnou výhru" — to je popis
 * absence požadavku, ne požadavek. Do množinové aritmetiky §4 vstoupit nesmí:
 * není v `supported` ani jednoho ze tří manifestů, takže by **každá statická
 * scéna skončila `NO_FIT` na tom, že po ničem netouží**. Naměřeno: bez téhle
 * výjimky padne 92 ze 116 promptů korpusu na `NO_FIT`, drtivou většinou právě
 * tímhle tokenem.
 */
const NON_REQUIREMENTS: ReadonlySet<CapabilityToken> = new Set<CapabilityToken>(['GOAL_NONE']);

/** `required(v)` z §4: co z vektoru je skutečný požadavek na archetyp. */
export function requirementsOf(vector: readonly CapabilityToken[]): CapabilityToken[] {
  return canonicalVector(vector).filter((token) => !NON_REQUIREMENTS.has(token));
}

/**
 * Tokeny, které prompt vyžaduje a manifest je neumí nebo je přímo vylučuje (§5).
 *
 * Obě podmínky z §4 jsou tu schválně, i když nad dnešními třemi manifesty je ta
 * druhá nadbytečná: žádný token není zároveň v `supported` i `forbidden`, takže
 * `!supported` sama o sobě zamítne všechno zakázané. Nadbytečná je ale jen do
 * chvíle, kdy někdo přidá token do `supported` a zapomene ho vyndat ze zákazu —
 * a `ARCHETYPES.md` §9 říká, že právě manifest je pravděpodobnější místo chyby
 * než prompt. Proto je funkce exportovaná: jinak by tuhle větev nešlo otestovat
 * a tvrzení „zákaz vyhrává" by bylo dekorace.
 */
export function blockingFor(
  manifest: Manifest,
  required: readonly CapabilityToken[],
): CapabilityToken[] {
  const supported = new Set(manifest.supported);
  const forbidden = new Set(manifest.forbidden);
  return requirementsOf(required).filter(
    (token) => !supported.has(token) || forbidden.has(token),
  );
}

function goalOverlap(manifest: Manifest, required: readonly CapabilityToken[]): number {
  const supported = new Set(manifest.supported);
  return required.filter((token) => token.startsWith('GOAL_') && supported.has(token)).length;
}

function humanList(tokens: readonly CapabilityToken[]): string {
  const sentences = tokens.map((token) => `${TOKEN_SENTENCES[token]} (\`${token}\`)`);
  if (sentences.length <= 1) return sentences[0] ?? '';
  return `${sentences.slice(0, -1).join(', ')} or ${sentences[sentences.length - 1]}`;
}

/**
 * Rozhodovací pravidlo z `ARCHETYPES.md` §4. **Čistá funkce** — žádný stav mezi
 * voláními, žádná mutace vstupu, žádné hodiny a žádná globální náhoda.
 *
 * Pořadí uvnitř proveditelné množiny:
 *  1. nejmenší `supported` — nejtěsnější archetyp vyhrává nad obecným, jinak by
 *     široký archetyp postupně pohltil všechno;
 *  2. víc shodných `GOAL_*` tokenů;
 *  3. stabilní hash promptu.
 *
 * Krok 3 je tam schválně: kdyby řazení bylo nedeterministické, metrika
 * nestability routování by neměřila nic.
 */
export function route(required: readonly CapabilityToken[], prompt: string): RouteDecision {
  const vector = canonicalVector(required);
  const scored = MANIFESTS.map((manifest) => ({
    manifest,
    blocking: blockingFor(manifest, vector),
  }));

  const feasible = scored.filter((entry) => entry.blocking.length === 0);

  if (feasible.length === 0) {
    // Nejbližší kandidát: nejmíň blokujících tokenů, pak nejtěsnější manifest,
    // pak id. Id je totální uspořádání, takže výsledek je jednoznačný i bez hashe.
    const nearest = [...scored].sort(
      (a, b) =>
        a.blocking.length - b.blocking.length ||
        a.manifest.supported.length - b.manifest.supported.length ||
        a.manifest.id.localeCompare(b.manifest.id),
    )[0];

    return {
      kind: 'no_fit',
      nearest: nearest.manifest.id,
      blocking: nearest.blocking,
      required: vector,
      sceneLayout: nearest.manifest.sceneLayout,
      reason: `I cannot do ${humanList(nearest.blocking)}. Here is ${nearest.manifest.offer}.`,
    };
  }

  const ranked = [...feasible].sort(
    (a, b) =>
      a.manifest.supported.length - b.manifest.supported.length ||
      goalOverlap(b.manifest, vector) - goalOverlap(a.manifest, vector) ||
      a.manifest.id.localeCompare(b.manifest.id),
  );

  // Remíza po obou pravidlech se rozsekne hashem promptu, ne pozicí v poli.
  const best = ranked[0];
  const tied = ranked.filter(
    (entry) =>
      entry.manifest.supported.length === best.manifest.supported.length &&
      goalOverlap(entry.manifest, vector) === goalOverlap(best.manifest, vector),
  );
  const winner = tied[stableHash(prompt) % tied.length];

  return {
    kind: 'archetype',
    archetype: winner.manifest.id,
    title: winner.manifest.title,
    feasible: ranked.map((entry) => entry.manifest.id),
    required: vector,
    sceneLayout: winner.manifest.sceneLayout,
    reason:
      tied.length > 1
        ? `${winner.manifest.title}: ${winner.manifest.offer}. ${tied.length} archetypes were feasible; the prompt hash decided.`
        : `${winner.manifest.title}: ${winner.manifest.offer}.`,
  };
}

/** Celá lokální routa: prompt → vektor → rozhodnutí. */
export function routePrompt(prompt: string): RouteDecision {
  return route(extractVector(prompt), prompt);
}

/**
 * Tokeny zakázané ve **všech** manifestech. Prompt, který některý z nich
 * vyžaduje, nemůže skončit jinak než `NO_FIT` — a to je vlastnost knihovny, ne
 * routeru, takže se počítá, nepíše.
 */
export function universallyForbidden(): CapabilityToken[] {
  return CAPABILITY_TOKENS.filter((token) =>
    MANIFESTS.every((manifest) => manifest.forbidden.includes(token)),
  );
}
