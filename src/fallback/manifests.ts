/**
 * Uzavřený slovník schopností a tři archetypové manifesty.
 *
 * Přepis `ARCHETYPES.md` §2 a §6 do dat. **Nic tady se nevymýšlí** — když se
 * tenhle soubor rozejde s dokumentem, vyhrává dokument a opravuje se kód.
 *
 * Soubor vědomě neimportuje nic: ani kit, ani three, ani jádro. Manifest je
 * rozhodovací tabulka, ne scéna, a router nad ním musí jít spustit kdekoli.
 */

/**
 * Slovník je **uzavřený** (`ARCHETYPES.md` §2). Cokoliv mimo něj je validační
 * chyba, ne neznámý token — proto je to `as const` a ne `string[]`.
 *
 * Pořadí je kanonické: v tomhle pořadí se vektory řadí, aby se daly porovnávat
 * napříč běhy.
 */
export const CAPABILITY_TOKENS = [
  // A. Struktura cíle
  'GOAL_COLLECT_N',
  'GOAL_DELIVER',
  'GOAL_ARRANGE',
  'GOAL_SEQUENCE',
  'GOAL_REACH',
  'GOAL_SURVIVE_T',
  'GOAL_THRESHOLD',
  'GOAL_NONE',
  // B. Kdo jedná
  'ACT_PLAYER_DIRECT',
  'ACT_PLAYER_INDIRECT',
  'ACT_AUTONOMOUS',
  // C. Stavové požadavky
  'STATE_DISCRETE',
  'STATE_COUNTER',
  'STATE_TIMER',
  'STATE_QUEUE',
  'STATE_CONTINUOUS',
  'STATE_INVENTORY',
  'STATE_PERSISTENT_MEMORY',
  // D. Modalita interakce
  'IN_CLICK',
  'IN_DRAG',
  'IN_MOVE',
  'IN_AIM',
  'IN_TIMED',
  'IN_TEXT',
  // E. Strukturální požadavky
  'REQ_MULTI_SOURCE_INPUT',
  'REQ_DATA_BINDING',
  'REQ_PATHFIND_GRID',
  'REQ_PATHFIND_FREE',
  'REQ_PHYSICS_SIM',
  'REQ_FREEFORM_BUILD',
  'REQ_DIALOGUE',
  'REQ_TEXT_RENDER',
  'REQ_MULTI_AGENT',
  'REQ_NARRATIVE',
  'REQ_BEHAVIOUR_EDIT',
] as const;

export type CapabilityToken = (typeof CAPABILITY_TOKENS)[number];

const TOKEN_RANK = new Map<string, number>(
  CAPABILITY_TOKENS.map((token, index) => [token, index]),
);

export function isCapabilityToken(value: string): value is CapabilityToken {
  return TOKEN_RANK.has(value);
}

/** Kanonické pořadí vektoru. Bez něj by se dva stejné vektory lišily zápisem. */
export function canonicalVector(tokens: Iterable<string>): CapabilityToken[] {
  const unique = new Set<CapabilityToken>();
  for (const token of tokens) {
    if (!isCapabilityToken(token)) {
      throw new Error(`token ${token} není ve slovníku schopností`);
    }
    unique.add(token);
  }
  return [...unique].sort((a, b) => TOKEN_RANK.get(a)! - TOKEN_RANK.get(b)!);
}

export type Role = {
  readonly required: boolean;
  /** Buď pevný počet, nebo doména ve tvaru z `ARCHETYPES.md` §3 (`"N"`, `"0..4"`). */
  readonly cardinality: number | string;
};

export type ArchetypeId = 'collect_unlock' | 'sort_match' | 'guide_avoid';

export type Manifest = {
  readonly id: ArchetypeId;
  /** Jméno pro člověka. Jde do HUD i do věty u `NO_FIT`. */
  readonly title: string;
  /** Jednou větou, co archetyp nabízí. `NO_FIT` ji cituje jako přiznaný ústupek. */
  readonly offer: string;
  readonly supported: readonly CapabilityToken[];
  readonly forbidden: readonly CapabilityToken[];
  readonly roles: Readonly<Record<string, Role>>;
  readonly stateVars: readonly string[];
  readonly params: Readonly<Record<string, readonly (string | number | null)[]>>;
  readonly tupleCount: number;
  /** Layout z kitu, na kterém archetyp stojí. Drží se tu jako id, ne jako scéna. */
  readonly sceneLayout: string;
};

/** A1 — Collect & Unlock (`ARCHETYPES.md` §6). */
const COLLECT_UNLOCK: Manifest = {
  id: 'collect_unlock',
  title: 'Posbírej a odemkni',
  offer: 'ohraničená aréna, sbírání do prahu, brána a cíl',
  supported: [
    'GOAL_COLLECT_N',
    'GOAL_DELIVER',
    'GOAL_REACH',
    'ACT_PLAYER_DIRECT',
    'STATE_DISCRETE',
    'STATE_COUNTER',
    'STATE_TIMER',
    'REQ_TEXT_RENDER',
    'IN_CLICK',
    'IN_MOVE',
  ],
  forbidden: [
    'STATE_QUEUE',
    'STATE_CONTINUOUS',
    'STATE_PERSISTENT_MEMORY',
    'STATE_INVENTORY',
    'REQ_MULTI_SOURCE_INPUT',
    'REQ_DATA_BINDING',
    'REQ_PHYSICS_SIM',
    'REQ_FREEFORM_BUILD',
    'REQ_DIALOGUE',
    'REQ_MULTI_AGENT',
    'REQ_NARRATIVE',
    'REQ_PATHFIND_FREE',
    'REQ_BEHAVIOUR_EDIT',
  ],
  roles: {
    avatar: { required: true, cardinality: 1 },
    collectible: { required: true, cardinality: 'N' },
    gate: { required: true, cardinality: 1 },
    goal: { required: true, cardinality: 1 },
    hazard: { required: false, cardinality: '0..4' },
  },
  stateVars: ['collected:int', 'gate_open:bool', 'time_left:int|null', 'alive:bool'],
  params: {
    n_collect: [3, 5, 7, 9],
    arena: ['small', 'medium'],
    timer: [null, 60, 90, 120],
    hazard_count: [0, 2, 4],
    hazard_behavior: ['static', 'patrol'],
  },
  tupleCount: 192,
  sceneLayout: 'thicket-clearing',
};

/** A2 — Sort & Match (`ARCHETYPES.md` §6). */
const SORT_MATCH: Manifest = {
  id: 'sort_match',
  title: 'Roztřiď a spáruj',
  offer: 'předměty, označené sokety a párovací pravidlo',
  supported: [
    'GOAL_ARRANGE',
    'GOAL_SEQUENCE',
    'ACT_PLAYER_DIRECT',
    'STATE_DISCRETE',
    'STATE_COUNTER',
    'STATE_TIMER',
    'STATE_INVENTORY',
    'REQ_TEXT_RENDER',
    'IN_CLICK',
    'IN_DRAG',
  ],
  forbidden: [
    'STATE_QUEUE',
    'STATE_CONTINUOUS',
    'STATE_PERSISTENT_MEMORY',
    'REQ_MULTI_SOURCE_INPUT',
    'REQ_DATA_BINDING',
    'REQ_PHYSICS_SIM',
    'REQ_FREEFORM_BUILD',
    'REQ_DIALOGUE',
    'REQ_MULTI_AGENT',
    'REQ_NARRATIVE',
    'REQ_PATHFIND_FREE',
    'REQ_PATHFIND_GRID',
    'REQ_BEHAVIOUR_EDIT',
  ],
  roles: {
    item: { required: true, cardinality: 'N' },
    socket: { required: true, cardinality: 'N' },
    tray: { required: true, cardinality: 1 },
    matcher: { required: true, cardinality: 1 },
  },
  stateVars: ['placed:int', 'mistakes:int', 'time_left:int|null', 'slot_state[N]:enum'],
  params: {
    n_items: [3, 4, 5, 6],
    match_rule: ['color', 'shape', 'size', 'category'],
    order: ['any', 'strict'],
    // `null` je „bez limitu" — u `mistakes_allowed` je to ∞ z §6, u `timer` ∅.
    mistakes_allowed: [null, 3, 1],
    timer: [null, 60, 90],
  },
  tupleCount: 288,
  sceneLayout: 'foundry-hall',
};

/** A3 — Guide & Avoid (`ARCHETYPES.md` §6). */
const GUIDE_AVOID: Manifest = {
  id: 'guide_avoid',
  title: 'Proveď a vyhni se',
  offer: 'autonomní chodec po mřížce, omezený rozpočet nástrojů',
  supported: [
    'GOAL_REACH',
    'GOAL_SURVIVE_T',
    'ACT_PLAYER_INDIRECT',
    'ACT_AUTONOMOUS',
    'STATE_DISCRETE',
    'STATE_COUNTER',
    'STATE_TIMER',
    'REQ_PATHFIND_GRID',
    'REQ_TEXT_RENDER',
    'IN_CLICK',
    'IN_DRAG',
  ],
  forbidden: [
    'STATE_QUEUE',
    'STATE_CONTINUOUS',
    'STATE_PERSISTENT_MEMORY',
    'STATE_INVENTORY',
    'REQ_MULTI_SOURCE_INPUT',
    'REQ_DATA_BINDING',
    'REQ_PHYSICS_SIM',
    'REQ_FREEFORM_BUILD',
    'REQ_DIALOGUE',
    'REQ_NARRATIVE',
    'REQ_PATHFIND_FREE',
    'REQ_BEHAVIOUR_EDIT',
    'IN_AIM',
  ],
  roles: {
    walker: { required: true, cardinality: 1 },
    spawn: { required: true, cardinality: 1 },
    goal: { required: true, cardinality: 1 },
    hazard: { required: true, cardinality: 'K' },
    tool: { required: true, cardinality: 'budget' },
  },
  stateVars: ['walker_cell:(x,y)', 'tick:int', 'tools_left:int', 'alive:bool'],
  params: {
    grid: [7, 9, 11],
    hazard_count: [2, 3, 4, 5],
    tool_budget: [1, 2, 3],
    hazard_behavior: ['static', 'cyclic'],
    walker_speed: [1, 2],
  },
  tupleCount: 144,
  sceneLayout: 'frost-plateau',
};

export const MANIFESTS: readonly Manifest[] = [COLLECT_UNLOCK, SORT_MATCH, GUIDE_AVOID];

export function manifestById(id: string): Manifest | undefined {
  return MANIFESTS.find((manifest) => manifest.id === id);
}

/**
 * Token → lidská věta (`ARCHETYPES.md` §10, otevřená položka 4).
 *
 * Ruční tabulka, ne generování modelem. `NO_FIT` z ní skládá důvod, takže
 * **každý token slovníku tu musí mít větu** — chybějící řádek by znamenal
 * `NO_FIT`, který zamlčí, co ho zablokovalo. Hlídá to test.
 *
 * Věty jsou psané tak, aby dávaly smysl za „Neumím ...".
 */
export const TOKEN_SENTENCES: Readonly<Record<CapabilityToken, string>> = {
  GOAL_COLLECT_N: 'sbírání N kusů něčeho',
  GOAL_DELIVER: 'donesení věci na místo',
  GOAL_ARRANGE: 'umístění věcí na správná místa',
  GOAL_SEQUENCE: 'aktivaci v určeném pořadí',
  GOAL_REACH: 'dostat entitu do cílové lokace',
  GOAL_SURVIVE_T: 'vydržet danou dobu',
  GOAL_THRESHOLD: 'přehnat číselnou veličinu přes práh',
  GOAL_NONE: 'svět bez výhry',
  ACT_PLAYER_DIRECT: 'přímé ovládání hráčem',
  ACT_PLAYER_INDIRECT: 'nepřímé ovlivňování autonomní entity',
  ACT_AUTONOMOUS: 'entity, které jednají samy',
  STATE_DISCRETE: 'konečný počet pojmenovaných stavů',
  STATE_COUNTER: 'omezené celé číslo',
  STATE_TIMER: 'odpočet ani uplynulý čas',
  STATE_QUEUE: 'frontu čekajících požadavků',
  STATE_CONTINUOUS: 'spojitou dynamiku a hybnost',
  STATE_INVENTORY: 'držené předměty se zachovanou identitou',
  STATE_PERSISTENT_MEMORY: 'paměť napříč epizodami',
  IN_CLICK: 'ukázat a kliknout',
  IN_DRAG: 'táhnout a pustit',
  IN_MOVE: 'směrový pohyb avatara',
  IN_AIM: 'míření a střelbu',
  IN_TIMED: 'stisk v časovém okně',
  IN_TEXT: 'psaný vstup za běhu',
  REQ_MULTI_SOURCE_INPUT: 'několik nezávislých ovladačů jednoho automatu',
  REQ_DATA_BINDING: 'reálná čísla mapovaná na vizuál s čitelnými osami',
  REQ_PATHFIND_GRID: 'navigaci po statické mřížce',
  REQ_PATHFIND_FREE: 'volnou navigaci kolem pohyblivých překážek',
  REQ_PHYSICS_SIM: 'fyziku, stohování ani nárazy',
  REQ_FREEFORM_BUILD: 'stavění nové geometrie hráčem',
  REQ_DIALOGUE: 'konverzační NPC s obsahem',
  REQ_TEXT_RENDER: 'čitelný text a popisky ve světě',
  REQ_MULTI_AGENT: 'několik entit s odlišným chováním',
  REQ_NARRATIVE: 'dějové zlomy ani větvení',
  REQ_BEHAVIOUR_EDIT: 'změnu kauzálního pravidla za běhu',
};
