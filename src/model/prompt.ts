/**
 * Sestavení upstream požadavku pro emisi celého světa.
 *
 * Soubor je **čistý** — žádné čtení disku, žádná síť. Slovník dostává zvenčí
 * a je to schválně: gramatika je zmrazená (`evals/frozen/protocol.v1.json`),
 * takže se sem nesmí opsat. Kopie by se rozešla se zmrazeným souborem tiše, a
 * prompt, který jmenuje jiné akce než kontrakt, měří něco jiného, než co se
 * pak validuje.
 *
 * `DESIGN-BOOK.md` §5: model nikdy nepíše control flow. Systémová zpráva proto
 * jmenuje deklarativní slovník a **výslovně zakazuje** cokoli jiného; kdyby
 * model směl vydat kód, celá garance §6 padá, protože verifikátor by
 * neverifikoval graf, ale program.
 *
 * ## Proč je tu vedle slovníku i TVAR (nález prvního živého běhu, 14. 8. 2026)
 *
 * Do téhle chvíle zpráva jmenovala jen slovník — jména událostí, podmínek a
 * akcí — a mlčela o tom, jakou podobu má JSON kolem nich mít. Zmrazené odpovědi
 * ten tvar nesou, protože je psal člověk podle `src/ir/surface.ts`; živý model
 * ho nemá odkud vzít a **není odvoditelný**. První běh proti skutečnému
 * poskytovateli (`evals/live/`, tři create prompty) to potvrdil: všechny tři
 * emise byly vnitřně konzistentní, žádná se netrefila. Pokaždé jinak — `rules`
 * a `entities` jako pole místo objektu klíčovaného stabilním id, `type` nebo
 * `action` místo `kind`, `effects` místo `actions`, `bounds`/`rooms`/
 * `dimensions` místo `layout.width` a `layout.height`. Všechny tři padly na
 * témže: `layout has no positive integer width and height`.
 *
 * Slovník proto zůstává **zvenčí** (zmrazený protokol), ale tvar se sem zapsat
 * musí — v protokolu není. Autorita tvaru je `src/ir/surface.ts` a
 * `src/ir/build.ts`, což je vazba, kterou nikdo nevynutí čtením. Vynucuje ji
 * `__tests__/prompt.test.ts`: vezme příklad **z hotového textu zprávy**, ne
 * z konstanty, a protáhne ho validací, snížením i verifikací svědka. Až se
 * povrch pohne, zčervená prompt, ne až měření.
 */

/** Slovník ze zmrazeného protokolu. Čte ho `./client`, sem se jen předává. */
export interface Grammar {
  readonly surfaceEvents: readonly string[];
  readonly conditions: readonly string[];
  readonly actions: readonly string[];
  /** `sim` je uvnitř hashe, `look` mimo — obojí doslova ze zmrazeného protokolu. */
  readonly simFields: readonly string[];
  readonly lookFields: readonly string[];
}

/** Co se doopravdy poslalo nahoru. Zaznamenává se, aby byl běh auditovatelný. */
export interface UpstreamRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
}

/**
 * Model, proti kterému P1 měří.
 *
 * V Phase 3 se **nevolá** — `./client` běží v režimu záznamu proti
 * `evals/frozen/responses/`. Jméno je tu proto, že se zaznamenává do
 * požadavku, a záznam bez jména modelu by po HALT bráně nešlo srovnat s živým
 * během (T18).
 */
export const EMISSION_MODEL = 'claude-opus-5';

/**
 * Řádek, za kterým ve zprávě stojí příklad a nic jiného.
 *
 * Je exportovaný, aby ho test uměl najít stejným způsobem jako čtenář zprávy —
 * příklad se ověřuje **z textu, který uvidí model**, ne z konstanty vedle něj.
 * Kdyby se ověřovala konstanta, prošel by i prompt, do kterého se nedostala.
 */
export const EXAMPLE_MARKER = 'A complete valid emission. Copy the SHAPE; a different request needs different content.';

/**
 * Nejmenší svět, který projde celou cestou — validací, snížením i svědkem.
 *
 * Obsah je schválně mimo zmrazený korpus (páka a brána, ne ponorka ani
 * skladiště): příklad má ukázat tvar, ne předříct zadání. Že opravdu projde,
 * netvrdí tenhle komentář, ale test nad hotovou zprávou.
 */
const EXAMPLE_WORLD = {
  irVersion: 'v1',
  simRevision: 0,
  lookRevision: 0,
  sim: {
    layout: { width: 12, height: 8 },
    grid: { cell: 1 },
    sockets: { spawn: [1, 4], lever: [5, 4], gate: [10, 4] },
    collisionAabb: { player: [1, 4, 1, 1], lever: [5, 4, 1, 1], gate: [10, 4, 1, 2] },
    entities: {
      player: { role: 'actor', socket: 'spawn', state: 'idle' },
      lever: { role: 'prop', socket: 'lever', state: 'down' },
      gate: { role: 'goal', socket: 'gate', state: 'shut', locked: true },
    },
    state: {
      counters: {},
      flags: { powered: { init: false } },
      timers: {},
      zones: {},
    },
    rules: {
      pull: {
        phase: 0,
        priority: 0,
        event: { kind: 'onAction', actionId: 'use', target: 'lever' },
        condition: null,
        actions: [
          { kind: 'setState', target: 'lever', value: 'up' },
          { kind: 'setFlag', flag: 'powered', value: true },
          { kind: 'setLocked', target: 'gate', locked: false },
        ],
      },
      escape: {
        phase: 1,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'player', zone: 'gate' },
        condition: { kind: 'flagIs', flag: 'powered', value: true },
        actions: [{ kind: 'win' }],
      },
    },
    witness: {
      tier: 'short',
      H_cert: 600,
      ops: [
        { tick: 0, actionId: 'moveTo', target: 'lever' },
        { tick: 30, actionId: 'use', target: 'lever' },
        { tick: 60, actionId: 'moveTo', target: 'gate' },
      ],
    },
  },
  look: {
    modules: { gate: { family: 'panel', params: { thickness: 0.2 } } },
    palette: 'amber',
    lightRig: 'rim',
    atmosphere: 'clear',
    materialRoles: {},
    camera: { kind: 'orbit' },
    audio: {},
  },
} as const;

export function buildEmissionRequest(prompt: string, grammar: Grammar): UpstreamRequest {
  const system = [
    'You emit a declarative world graph. You never write code, control flow, or expressions to be evaluated.',
    '',
    'Answer with a single JSON object and nothing else. Its top-level fields are exactly:',
    'irVersion, simRevision, lookRevision, sim, look.',
    '',
    'If the request cannot be expressed in the vocabulary below, decline instead of inventing one:',
    'answer with the same object, sim set to null, and one extra field simOutcome: "NO_FIT".',
    'look stays REQUIRED in that case — the refusal covers sim only, and the scene is built either way.',
    '',
    `sim carries: ${grammar.simFields.join(', ')}. It is inside the state hash.`,
    `look carries: ${grammar.lookFields.join(', ')}. It is outside the state hash, and its only`,
    'permitted link into sim is an entity stableId.',
    '',
    `Rules fire on these events: ${grammar.surfaceEvents.join(', ')}.`,
    `Guards use these conditions: ${grammar.conditions.join(', ')}.`,
    `Effects use these actions: ${grammar.actions.join(', ')}.`,
    'Nothing outside those three lists exists. Every counter, timer and inventory slot is bounded.',
    '',
    'sim.witness is a finite admissible input trace in canonical sim actions. It must reach win()',
    'inside the horizon of the tier it asks for. You may request a tier; you may not declare the',
    'horizon — the system does that.',
    '',
    'SHAPE. The interpreter reads these exact containers and field names. A world that renames them',
    'is discarded whole, however sensible the alternative looks.',
    '',
    'sim.layout   { width, height } — positive integers, the grid measured in cells. Required.',
    'sim.sockets  { <socketName>: [x, y] } — named cells. Everything positional names a socket.',
    'sim.entities { <stableId>: { role, socket, state, locked } } — an OBJECT keyed by stableId, never a list.',
    '             role "actor" marks the player and there is exactly one; "agent" is an NPC, "goal" the',
    '             objective, "prop" everything else. socket names a sim.sockets entry.',
    'sim.rules    { <ruleId>: { phase, priority, event, condition, actions } } — an OBJECT keyed by ruleId,',
    '             never a list. The key is how a later edit names one rule, so it has to be stable.',
    '             event and condition and every entry of actions carry their name under "kind".',
    '             condition is null when the rule is unguarded. actions is a list and is never empty.',
    'sim.state    { counters: { <id>: { min, max, init } },',
    '               flags:    { <id>: { init: <bool> } },',
    '               timers:   { <id>: { durationTicks, init } },   durationTicks is where a duration lives',
    '               zones:    { <name>: [[x, y, w, h], ...] },     rectangles in cells',
    '               pool:     { <idPrefix>: { size, tag } } }      for spawn and countInZone',
    'sim.witness  { tier: "short" | "standard" | "long", H_cert, ops: [{ tick, actionId, target }] }',
    'sim.grid and sim.collisionAabb are declared and carried, and this version does not read them.',
    'look.<field> is free-form as long as every number in it is finite.',
    '',
    'ARGUMENTS, beside "kind". Anything not listed here is dropped.',
    'events      onStart {} · onClick {entity} · onEnterZone/onExitZone {entity, zone} · onCollide {a, b}',
    '            onPickup {entity} or {role} · onDrop {item, socket} or {entity} · onTimerEnd {timer}',
    '            onCounterReaches {counter, threshold} · onStateEnter {entity, state} · onSignal {name}',
    '            onSeen {agent, target} · onAction {actor, actionId, target} · onCommandComplete {entity, commandId}',
    'conditions  counterIs {counter, op, value} · flagIs {flag, value} · timerRunning {timer}',
    '            stateIs {target, value} · inZone {entity, zone} · hasItem {slot, item}',
    '            countInZone {zone, tag, op, value} · allOf/anyOf {operands: [...]} · not {operand}',
    '            op is one of = != < <= > >= and defaults to =. slot is an integer index, not a name.',
    'actions     setState {target, value} · setLocked {target, locked} · setFlag {flag, value}',
    '            addCounter {counter, by} · startTimer {timer} · stopTimer {timer} · spawn {poolTag, socket}',
    '            despawn {target} · moveTo {target, socket, ticks} · freeze {target, ticks}',
    '            giveItem/takeItem {slot, item} · emit {signal} · playEffect {id, target} · win {} · lose {}',
    '',
    'The clock runs at 20 ticks per second, so a 60-second timer is durationTicks 1200. Horizon caps are',
    'short 600 ticks, standard 1200, long 3600 — ask for the tier that fits the witness you wrote.',
    'The system already turns the canonical moveTo action into movement to a socket; you do not write',
    'a rule for walking.',
    '',
    EXAMPLE_MARKER,
    JSON.stringify(EXAMPLE_WORLD, null, 2),
  ].join('\n');

  // Text promptu jde do zprávy **doslova**. AC T13 se ptá právě na tohle:
  // zaznamenaný požadavek musí prompt obsahovat, jinak se nedá prokázat, že
  // odpověď patří k němu a ne k jinému běhu.
  const user = `Build a playable world for this request:\n\n${prompt}`;

  return { model: EMISSION_MODEL, system, user };
}
