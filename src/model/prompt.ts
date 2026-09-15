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
 *
 * ## Co našel druhý živý běh (15 create promptů, 14. 8. 2026)
 *
 * Tvar už seděl — schématem prošlo všech patnáct. Zbyly dvě věci, které zpráva
 * pořád neříkala, a obě jsou stejného druhu jako výše: nejsou odvoditelné.
 *
 * 1. **`moveTo` ve svědkovi míří na ENTITU, ne na soket.** Pravidlo chůze se
 *    generuje v `src/ir/build.ts:253` cyklem přes `entityIds`, takže
 *    `sys.moveTo.<soket>` nikdy nevznikne a op se soketem v cíli nespustí nic:
 *    stopa stojí na místě a doběhne do konce horizontu jako `NO_WIN`. Přesně
 *    tohle zabilo pět z devíti měřitelných create záznamů — svědek byl jinak
 *    smysluplný, jen jmenoval `redKeySocket` místo `redKey`. Zpráva přitom o
 *    kanonickém `moveTo` mluvila, ale slovem *„socket"*, což ke stejné chybě
 *    přímo vede. `src/ir/surface.ts:19` tu vlastnost popisuje od začátku.
 * 2. **Klíče `look.modules` musí být stabilní id deklarované entity**
 *    (`src/ir/references.ts:236`). Model si pod „modules" přirozeně představil
 *    kulisy (`environment`, `maze_environment`, `pressureHull`) a čtyři z
 *    patnácti emisí kvůli tomu skončily na `DANGLING_REFERENCE` — na vadě
 *    v `look`, která se `sim` vůbec netýká.
 *
 * **Příklad sám dvojku ani jedničku naučit nemohl:** sokety se v něm jmenovaly
 * stejně jako entity (`lever`, `gate`), takže z `target: "lever"` nešlo poznat,
 * které z těch dvou jmen tam patří. Teď mají sokety vlastní jména (`leverPad`),
 * a `__tests__/prompt.test.ts` na tu nekolizi má aserci — bez ní by se příklad
 * mohl kdykoli vrátit k dvojznačnému tvaru a testy by mlčely.
 *
 * ## Dvě nepravdy, které zpráva o vlastním systému říkala
 *
 * Nalezeno po opravě výše, na témže běhu. Obojí je vada popisu, ne modelu, a
 * obojí se dá doložit ze zdrojáků bez jediného skóre:
 *
 * 3. **`sim.state.slots` chybělo v popisu tvaru.** Je to počet inventárních
 *    slotů a povrch ho nese (`state=[counters, flags, timers, slots]` ve dvou
 *    zmrazených tělech). Zpráva vyjmenovala `counters`, `flags`, `timers`,
 *    `zones` a `pool` — a přitom mluvila o `giveItem` i `hasItem`, tedy o
 *    inventáři, který se nemá kde vzít.
 * 4. **Role entity NENÍ výčet čtyř hodnot.** Je to volný řetězec: `build.ts:184`
 *    hledá `actor` (a když není, bere první entitu), `build.ts:285` počítá
 *    `agent` do `maxAgents`, a tím výčet končí — `goal` ani `prop` nečte nic.
 *    Naproti tomu `onPickup` se smí klíčovat **rolí** (`surface.ts:276`), takže
 *    role je nositel významu. Věta „prop everything else" ten prostor zavírala.
 */

import { canonical } from '../ir/worlddoc';

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
 * **Model, který ty světy doopravdy píše, jménem, jakým se o něj žádá.**
 *
 * Je to `gpt-5.6-sol` od OpenAI, placený **předplatným Codexu** přes lokální
 * `claude-code-proxy`, která mluví formátem Anthropic Messages. Žádný měřený
 * klíč se nekupuje a po tokenech se neúčtuje nic — jediná mez, která kousne,
 * je `WORLDSMITH_CALL_CAP`, tedy počet volání.
 *
 * ⛔ **Do 6. 9. 2026 tady stálo `claude-opus-5` a byla to nepravda, kterou
 * měřidlo zapisovalo na disk.** Naměřeno z logu proxy: **53 z 53 volání**
 * požádalo o `claude-opus-5`, proxy je poslala na `provider: codex`,
 * `model: gpt-5.6-sol` — a odpověď vrátila **označenou jako `claude-opus-5`**.
 * Archiv i `create-report.json` tedy zapisovaly jméno modelu, který se
 * produktu neúčastní, a `RULES.md` §2 chce u každého modelu a API pravdivý
 * zdroj, poskytovatele a licenci. Anthropic mezi backendy proxy není a Max
 * plán není HTTP endpoint; serverová cesta produktu se na něj napojit neumí.
 *
 * **Alias se sem nesmí vrátit.** Hlídá to `__tests__/prompt.test.ts`, který
 * odmítne jakékoli jméno tvaru `claude-*`, dokud platí rozhodnutí `G2` (a).
 *
 * Zmrazený korpus tím dotčený **není**: `evals/frozen/responses/` jsou
 * syntetické odpovědi klíčované podle promptu, ne podle jména modelu, takže
 * `./client` v režimu záznamu čte totéž co dřív.
 *
 * **Od 12. 9. 2026 varianta `-fast` téhož modelu** — stejná odpověď, jiná
 * priorita zpracování u poskytovatele. Naměřeno `live-latency.measure.ts`
 * nad pěti větami korpusu (`evals/worldstream/latency-report.json`):
 * medián věty **98 s → 56 s**, p95 **130 s → 79 s**, planner 15,6 → 9,6 s,
 * compiler 64 → 40 s; napsaná geometrie 5/5 proti 4/5, ten jeden padl na
 * nevyhratelném světě, ne na tvaru. **Přesto tu `-fast` nestojí — rozhodnutí
 * uživatele 13. 9. 2026:** ta varianta účtuje předplatnému asi 2,5× víc
 * tokenů, a to je cena, kterou za 40 s na větu neplatí. Jméno zůstává jen
 * jako volba měřidla (`WORLDSMITH_LATENCY_MODELS`), ne produktu.
 *
 * **Od 13. 9. 2026 `gpt-5.6-luna`** — rozhodnutí uživatele po dvou měřeních
 * téhož dne (`evals/worldstream/latency-report.json`, `PROJECT-STATUS.md`):
 * nad 30 větami luna medián **33 s** proti 101 s solu (sol 2× narazil na
 * strop 120 s), stejný počet vstupních tokenů, poloviční výstup; nad 5 větami
 * v jednom běhu s `gpt-6-astra` (jen přes Codex CLI, proxy ho nezná) luna
 * 5/5 za 36 s, astra low 3/5 za 172 s, medium 3/5 za 145 s, high 2/5 za
 * 221 s. Sol napsal geometrii častěji (27/30 proti 21/30), ale zbylé
 * neúspěchy luny jsou nevyhratelné světy, ne tvar — to řeší prompt, ne model.
 *
 * **Od 13. 9. 2026 večer `gpt-6-astra`** — rozhodnutí uživatele („chci Astru")
 * po galerii kvality (`e2e/quality-gallery.spec.ts`, `PROJECT-STATUS.md`): nad
 * pěti větami píše Astra 2–5× bohatší kompozice (katedrála z kontejnerů o třech
 * patrech proti čtyřem deskám luny, zvlněný terén proti rovině, rozpoznatelné
 * autokino) a s uvolněnými limity (hloubka tvarů 12, kusů 200) prošla 4/5.
 * Cena: medián **143 s** na větu proti 35 s luny, a jde jen přes Codex CLI
 * (`WORLDSMITH_MODEL_ENDPOINT=codex-cli` v `src/server/upstream.ts`), protože
 * proxy ten model nezná. Úsilí `medium` (low bylo pomalejší i horší).
 */
export const EMISSION_MODEL = 'gpt-6-astra';

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
    sockets: { spawnPad: [1, 4], cardPad: [3, 4], leverPad: [5, 4], gatePad: [10, 4] },
    collisionAabb: { player: [1, 4, 1, 1], card: [3, 4, 1, 1], lever: [5, 4, 1, 1], gate: [10, 4, 1, 2] },
    entities: {
      player: { role: 'actor', socket: 'spawnPad', state: 'idle' },
      card: { role: 'pickup', socket: 'cardPad', state: 'loose' },
      lever: { role: 'prop', socket: 'leverPad', state: 'down' },
      gate: { role: 'goal', socket: 'gatePad', state: 'shut', locked: true },
    },
    state: {
      counters: {},
      flags: { powered: { init: false } },
      timers: {},
      zones: {},
      slots: 1,
    },
    rules: {
      grab: {
        phase: 0,
        priority: 0,
        event: { kind: 'onPickup', role: 'pickup' },
        condition: null,
        actions: [
          { kind: 'giveItem', slot: 0, item: 'card' },
          { kind: 'despawn', target: 'card' },
        ],
      },
      pull: {
        phase: 0,
        priority: 1,
        event: { kind: 'onAction', actionId: 'use', target: 'lever' },
        condition: { kind: 'hasItem', slot: 0, item: 'card' },
        actions: [
          { kind: 'setState', target: 'lever', value: 'up' },
          { kind: 'setFlag', flag: 'powered', value: true },
          { kind: 'setLocked', target: 'gate', locked: false },
        ],
      },
      win: {
        phase: 1,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'player', zone: 'gatePad' },
        condition: { kind: 'flagIs', flag: 'powered', value: true },
        actions: [{ kind: 'win' }],
      },
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

const EXAMPLE_CANONICAL = canonical(EXAMPLE_WORLD);

/** Doslovný obsah ukázky není nezávislá odpověď modelu na novou větu. */
export function isExampleEmission(value: unknown): boolean {
  return value !== null && typeof value === 'object' && canonical(value) === EXAMPLE_CANONICAL;
}

export const EXAMPLE_ONLY_IDENTIFIERS = [
  ...Object.keys(EXAMPLE_WORLD.sim.sockets).filter((identifier) => identifier !== 'spawnPad'),
  ...Object.keys(EXAMPLE_WORLD.sim.entities).filter((identifier) => identifier !== 'player'),
  ...Object.keys(EXAMPLE_WORLD.sim.state.flags),
  // `win` je z tohohle seznamu vyňaté schválně: je to jediné pravidlo, které
  // příklad NEdemonstruje jako volbu, ale jako povinnost. Zakázat jeho jméno by
  // odporovalo požadavku o pár řádků výš.
  ...Object.keys(EXAMPLE_WORLD.sim.rules).filter((identifier) => identifier !== 'win'),
];

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
    'permitted link into sim is an entity stableId. Every key of look.modules IS one: it must appear',
    'in sim.entities. There are no scenery-only modules — a key like "environment" or "maze" that names',
    'no entity is a dangling reference and the whole emission is rejected. Put scenery in palette,',
    'atmosphere and lightRig, or declare it as an entity first.',
    '',
    `Rules fire on these events: ${grammar.surfaceEvents.join(', ')}.`,
    `Guards use these conditions: ${grammar.conditions.join(', ')}.`,
    `Effects use these actions: ${grammar.actions.join(', ')}.`,
    'Nothing outside those three lists exists. Every counter, timer and inventory slot is bounded.',
    '',
    'THE WORLD MUST BE WINNABLE. This is the one requirement that is never optional.',
    'sim.rules MUST contain a rule named "win" whose actions are exactly [{ kind: "win" }]. You write its',
    'event and its condition — that is you deciding what winning MEANS in this world. A world with no',
    'win rule is a room nobody can finish, and it is rejected however good the rest of it is.',
    '',
    'You do NOT write sim.witness. Leave it out entirely.',
    'The winning path is a PROOF, not content: the system searches for it itself, replays it, and',
    'certifies it. Your job is to make winning possible and to say when it happens. Every op you would',
    'have written there is one more thing that can be wrong, and none of it describes the request.',
    '',
    'PLACES AND THINGS are different namespaces, and mixing them is the most common way to lose a world.',
    'A socket is a named CELL. An entity is a THING standing on a socket. Each socket is also a 1x1 zone',
    'of the same name; zones in sim.state.zones are for anything larger.',
    'Every onEnterZone or onExitZone event.zone MUST exactly name a key declared in',
    'sim.sockets or sim.state.zones. It never names an entity stableId. If goalArch sits at',
    'goalPad, use { entity: player, zone: goalPad }, not the goal entity stableId goalArch.',
    'onCollide is strictly between two declared ENTITIES, both of them named under sim.entities.',
    'Reaching a PLACE is onEnterZone, never onCollide. { kind: "onCollide", a: "player", b: "dockPad" }',
    'is wrong when dockPad is a socket; { kind: "onEnterZone", entity: "player", zone: "dockPad" } is the',
    'same event written the way the interpreter reads it.',
    '',
    'EVERY NAME YOU USE MUST BE DECLARED FIRST. There is no implicit creation anywhere.',
    'A timer named in onTimerEnd, startTimer or timerRunning must exist in sim.state.timers with its',
    'durationTicks. A counter named in addCounter, counterIs or onCounterReaches must exist in',
    'sim.state.counters with min, max and init. A flag must exist in sim.state.flags. An entity named',
    'anywhere must exist in sim.entities. A name that is only mentioned and never declared rejects the',
    'whole emission, and the system will not guess what you meant by it.',
    '',
    'SHAPE. The interpreter reads these exact containers and field names. A world that renames them',
    'is discarded whole, however sensible the alternative looks.',
    '',
    'sim.layout   { width, height } — positive integers, the grid measured in cells. Required.',
    'sim.sockets  { <socketName>: [x, y] } — named cells. Everything positional names a socket.',
    'sim.entities { <stableId>: { role, socket, state, locked } } — an OBJECT keyed by stableId, never a list.',
    '             socket names a sim.sockets entry. role is a FREE label, not a fixed list, but it is a',
    '             LABEL: camelCase, no spaces (loosePickup, not "loose pickup").',
    '             The system reads exactly two of them, "actor" for the player (exactly one) and "agent"',
    '             for an NPC. Every other role is yours to name after what the thing is in the request,',
    '             and naming it well pays off, because onPickup can fire on a role instead of on one',
    '             named entity.',
    'sim.rules    { <ruleId>: { phase, priority, event, condition, actions } } — an OBJECT keyed by ruleId,',
    '             never a list. The key is how a later edit names one rule, so it has to be stable.',
    '             event and condition and every entry of actions carry their name under "kind".',
    '             condition is null when the rule is unguarded. actions is a list and is never empty.',
    'sim.state    { counters: { <id>: { min, max, init } },',
    '               flags:    { <id>: { init: <bool> } },',
    '               timers:   { <id>: { durationTicks, init } },   durationTicks is where a duration lives',
    '               zones:    { <name>: [[x, y, w, h], ...] },     rectangles in cells',
    '               slots:    <count>,                             inventory slots the actor may hold',
    '               pool:     { <idPrefix>: { size, tag } } }      for spawn and countInZone',
    '             A world whose rules use giveItem or hasItem declares state.slots. Slot indexes run from 0.',
    'sim.witness  omitted — the system writes it. If you do send one it is replaced by the proof it finds.',
    'sim.grid and sim.collisionAabb are declared and carried, and this version does not read them.',
    'look.<field> is free-form as long as every number in it is finite.',
    '',
    'ARGUMENTS, beside "kind". Every argument listed below is REQUIRED for that kind, and anything not',
    'listed is dropped. { kind: "moveTo", target: "cat" } is not a shorter moveTo — it is a broken one,',
    'and the world is rejected before it ever runs. Count the arguments against this list for every',
    'event, condition and action you write.',
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
    'The clock runs at 20 ticks per second, so a 60-second timer is durationTicks 1200. The system proves',
    'the world within 600 ticks, so a puzzle that needs longer than 30 seconds of play cannot be proved.',
    'The system already binds the canonical moveTo action for every entity that sits on a socket, so you',
    'never write a rule for walking. The moveTo ACTION inside a rule is the other thing: it moves some',
    'entity you name, and it does take {target, socket, ticks}.',
    '',
    EXAMPLE_MARKER,
    // **Odsazení tu musí zůstat. Zkompaktnění se zkusilo a naměřeně uškodilo.**
    //
    // Úvaha byla: model kopíruje formát toho, co vidí, a naměřeně bylo 52,5 %
    // znaků jeho odpovědi jen odsazení, takže kompaktní příklad měl zkrátit
    // odpověď a s ní i čas. Zkráceno to bylo (medián 36,7 s → 24,3 s, useknutých
    // odpovědí 8 → 5), ale **zaplatilo se strukturou emise**, a to je horší
    // obchod. Naměřeno 25. 8. 2026, dva běhy nad týmž strojem a korpusem:
    //
    //   příklad odsazený   16 z 25 emisí padlo na JEDINÉM poli (collisionAabb),
    //                      doplnění toho pole je opraví -> 16 platných, 8 dohraje
    //   příklad kompaktní  emise padají na collisionAabb A NAVÍC na sim.grid (15x)
    //                      a look.materialRoles (5x) -> opravit nejde ani jedna
    //
    // Odsazený příklad tedy modelu neslouží jako vzor formátu, ale jako **seznam
    // polí, který si může projít po řádcích**. Na jednom řádku o 1800 znacích tu
    // oporu ztratí a pole vynechává. Úspora času nebyla zadarmo — byla to táž
    // událost jako ta ztráta kvality: model psal rychleji, protože psal míň.
    //
    // Ta rychlost je pořád reálný problém, ale řeší se jinde: naměřeno, že 80 %
    // času požadavku padne na režii mezi tokeny uvnitř WebLLM, a vynucený tvar
    // odpovědi z toho je 0,9 %. Podrobně v `evals/local-model/decision.md` §8.
    JSON.stringify(EXAMPLE_WORLD, null, 2),
  ].join('\n');

  // Text promptu jde do zprávy **doslova** a stojí poslední. Malý model se v
  // živých bězích naučil tvar příkladu tak doslova, že jeho kartu, páku a bránu
  // opsal i pro zenovou zahradu a skákací arkádu. Zákaz proto jmenuje obsah
  // aktuálního příkladu přímo a zadání opakuje až za ním: kopie může být
  // strukturálně platná, ale pořád není odpovědí na větu.
  const user = [
    'REQUEST-SPECIFIC CONTENT is authoritative. The assistant example demonstrates syntax only.',
    'Its card/lever/gate scenario is semantically wrong for any unrelated request.',
    `Do not copy these example-only identifiers unless the request itself calls for them: ${EXAMPLE_ONLY_IDENTIFIERS.join(', ')}.`,
    'A structurally valid world that does not implement the request-specific nouns, actions, constraints, and goal is an invalid answer.',
    'Choose request-specific stableIds, entity roles, rules, look, and a winning witness.',
    '',
    'Build a playable world for exactly this request:',
    prompt,
  ].join('\n');

  return { model: EMISSION_MODEL, system, user };
}
