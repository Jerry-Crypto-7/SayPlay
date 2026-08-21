/**
 * Deterministický rozpoznávač běžných tvarů vět (P11 T7).
 *
 * ## Proč vůbec existuje
 *
 * Měření z T5 (`evals/local-model/decision.md`) říká dvě čísla: `schemaValid 0`
 * ze 40 a **medián 37 sekund** na větu. To druhé je horší než to první — slib
 * „do dvou sekund se staví svět" nesplní žádný model běžící na WebGPU, ať by
 * psal jakkoli dobře. Rozpoznávač odpovídá bez GPU a okamžitě, takže je to
 * hlavní cesta a model je doplněk pro věty mimo rozpoznané tvary.
 *
 * ## Co je „tvar"
 *
 * Ne klíčové slovo, ale **struktura světa**, kterou věta popisuje: posbírej N
 * věcí a odejdi; přepni páku a odejdi; dojdi do cíle dřív, než doběhne čas.
 * Jedna struktura obslouží mnoho různých vět, protože se liší jen jmény a
 * počty — a ty se z věty čtou.
 *
 * ## Proti vakuóznímu rozpoznávači
 *
 * `CLAUDE.md` rozpor 9 popisuje past, do které spadl fallback: mechanismus,
 * který odpoví na všechno, projde každou bránou a nedokáže nic. Tady proti ní
 * stojí dvě věci. `recognize()` vrací `null`, kdykoli větu nepozná — a `null`
 * není chyba, je to předání slova modelu (`./emit`). A testy nad tímhle
 * souborem drží obojí: že rozpoznaná věta dá svět, který **projde produkční
 * certifikací**, a že věta mimo tvary vrátí `null`.
 *
 * Struktura světů je opsaná z toho, co ve zmrazeném korpusu **doopravdy prošlo**
 * (role `collectible`, counter s `onCounterReaches`, výhra přes `onEnterZone`),
 * ne z vlastní představy o schématu.
 */

import type { AgentDisposition, AgentMind } from '@/ir/types';

/** Kolik tiků trvá jeden krok svědka. Stopa musí být rostoucí a vejít se do horizontu. */
const STEP_TICKS = 60;

/** Horizont certifikace pro krátký tier. Stejný, jaký nese zmrazený korpus. */
const H_CERT = 600;

interface Blueprint {
  /** Věci k posbírání. Prázdné pole = nic se nesbírá. */
  readonly items: readonly string[];
  /** Jméno cílové entity i jejího soketu. */
  readonly goal: string;
  /** Páka, kterou je potřeba přepnout, nebo `null`. */
  readonly lever: string | null;
  /** Kolik tiků běží odpočet, nebo `null`. Po doběhnutí se prohrává. */
  readonly timerTicks: number | null;
  readonly palette: string;
  readonly atmosphere: string;
  /**
   * Postava, které věta napsala povahu a trasu. Chybí u tvarů, které o nikom
   * nemluví — prázdná mysl u každého světa by byla deklarace, kterou nic nečte.
   */
  readonly agent?: AgentMind;
}

/**
 * Zastávky trasy postavy. **Netvoří přímku** a je to podmínka, ne vkus: kdyby
 * ležely v řadě, cesta ke krajní zastávce by procházela prostřední, obě povahy
 * s jinou trasou by navštívily tytéž zóny a rozdíl v chování by nebyl vidět.
 * Trojúhelník je nejmenší tvar, ve kterém se `bold`, `wary` i `restless` liší
 * navštívenou množinou, ne jen pořadím.
 */
const AGENT_STOPS: Readonly<Record<string, [number, number]>> = {
  post: [3, 1],
  hall: [6, 6],
  alcove: [9, 1],
};

/** Vodorovná řada soketů: hráč vlevo, cíl vpravo, sbíratelné mezi tím. */
function layoutOf(blueprint: Blueprint): { width: number; height: number } {
  const stops = blueprint.items.length + (blueprint.lever ? 1 : 0);
  return { width: Math.max(12, 4 + stops * 2), height: 8 };
}

function socketsOf(blueprint: Blueprint): Record<string, [number, number]> {
  const { width } = layoutOf(blueprint);
  const sockets: Record<string, [number, number]> = { spawn: [1, 4] };
  let x = 3;
  for (const item of blueprint.items) {
    sockets[item] = [x, 4];
    x += 2;
  }
  if (blueprint.lever) {
    sockets[blueprint.lever] = [x, 4];
    x += 2;
  }
  sockets[blueprint.goal] = [width - 2, 4];
  if (blueprint.agent) {
    for (const stop of blueprint.agent.goals) sockets[stop] = AGENT_STOPS[stop];
  }
  return sockets;
}

function entitiesOf(blueprint: Blueprint): Record<string, Record<string, unknown>> {
  const entities: Record<string, Record<string, unknown>> = {
    player: { role: 'actor', socket: 'spawn', state: 'idle' },
  };
  for (const item of blueprint.items) {
    entities[item] = { role: 'collectible', socket: item, state: 'present' };
  }
  if (blueprint.lever) {
    entities[blueprint.lever] = { role: 'prop', socket: blueprint.lever, state: 'down' };
  }
  entities[blueprint.goal] = { role: 'goal', socket: blueprint.goal, state: 'closed', locked: true };
  if (blueprint.agent) {
    entities[blueprint.agent.id] = { role: 'agent', socket: blueprint.agent.goals[0], state: 'idle' };
  }
  return entities;
}

function rulesOf(blueprint: Blueprint): Record<string, unknown> {
  const rules: Record<string, unknown> = {};
  const count = blueprint.items.length;

  if (count > 0) {
    rules.pick = {
      id: 'pick',
      phase: 0,
      priority: 0,
      event: { kind: 'onPickup', role: 'collectible' },
      condition: null,
      actions: [{ kind: 'addCounter', ref: 'collected', by: 1 }],
    };
  }

  // Odemknutí visí na tom, co věta žádá: na páce, na počtu, nebo na obojím.
  const unlockActions = [
    { kind: 'setLocked', target: blueprint.goal, locked: false },
    { kind: 'setState', target: blueprint.goal, value: 'open' },
  ];
  const enoughCollected =
    count > 0 ? { kind: 'counterIs', ref: 'collected', op: '>=', value: count } : null;

  if (blueprint.lever) {
    rules.unlock = {
      id: 'unlock',
      phase: 1,
      priority: 0,
      event: { kind: 'onAction', actionId: 'use', target: blueprint.lever },
      condition: enoughCollected,
      actions: [{ kind: 'setState', target: blueprint.lever, value: 'up' }, ...unlockActions],
    };
  } else if (count > 0) {
    rules.unlock = {
      id: 'unlock',
      phase: 1,
      priority: 0,
      event: { kind: 'onCounterReaches', ref: 'collected', threshold: count },
      condition: enoughCollected,
      actions: unlockActions,
    };
  } else {
    // Nic se nesbírá a není co přepnout — cíl je otevřený od začátku.
    rules.unlock = {
      id: 'unlock',
      phase: 1,
      priority: 0,
      event: { kind: 'onStart' },
      condition: null,
      actions: unlockActions,
    };
  }

  if (blueprint.timerTicks !== null) {
    rules.begin = {
      id: 'begin',
      phase: 0,
      priority: 1,
      event: { kind: 'onStart' },
      condition: null,
      actions: [{ kind: 'startTimer', ref: 'deadline', durationTicks: blueprint.timerTicks }],
    };
    rules.expire = {
      id: 'expire',
      phase: 2,
      priority: 1,
      event: { kind: 'onTimerEnd', ref: 'deadline' },
      condition: null,
      actions: [{ kind: 'lose' }],
    };
  }

  rules.win = {
    id: 'win',
    phase: 2,
    priority: 0,
    event: { kind: 'onEnterZone', entity: 'player', zone: blueprint.goal },
    condition: { kind: 'stateIs', target: blueprint.goal, value: 'open' },
    actions: [{ kind: 'win' }],
  };
  return rules;
}

function witnessOf(blueprint: Blueprint): Record<string, unknown> {
  const ops: Record<string, unknown>[] = [];
  let tick = 0;
  const step = (actionId: string, target: string): void => {
    ops.push({ tick, actionId, target });
    tick += STEP_TICKS;
  };

  for (const item of blueprint.items) {
    step('moveTo', item);
    step('pickup', item);
  }
  if (blueprint.lever) {
    step('moveTo', blueprint.lever);
    step('use', blueprint.lever);
  }
  step('moveTo', blueprint.goal);

  return { tier: 'short', H_cert: H_CERT, ops };
}

function buildEmission(blueprint: Blueprint): Record<string, unknown> {
  const sockets = socketsOf(blueprint);
  const entities = entitiesOf(blueprint);
  const collisionAabb: Record<string, [number, number, number, number]> = {};
  for (const [name, entity] of Object.entries(entities)) {
    const at = sockets[entity.socket as string];
    collisionAabb[name] = [at[0], at[1], 1, name === blueprint.goal ? 2 : 1];
  }

  return {
    irVersion: 'v1',
    simRevision: 0,
    lookRevision: 0,
    sim: {
      layout: { kind: 'grid', ...layoutOf(blueprint), levels: 1, portals: [] },
      grid: { cell: 1 },
      sockets,
      collisionAabb,
      entities,
      rules: rulesOf(blueprint),
      state: {
        counters:
          blueprint.items.length > 0
            ? { collected: { min: 0, max: blueprint.items.length, init: 0 } }
            : {},
        flags: {},
        timers: blueprint.timerTicks === null ? {} : { deadline: { durationTicks: blueprint.timerTicks } },
        zones: {},
        slots: Math.max(1, blueprint.items.length),
        // Mysl je stav, ne kořenové pole `sim` — zmrazený protokol má kořen
        // `sim` uzavřený a paměťové sloty výslovně řadí do `state`.
        ...(blueprint.agent ? { agents: [blueprint.agent] } : {}),
      },
      witness: witnessOf(blueprint),
    },
    look: {
      modules: { [blueprint.goal]: { family: 'panel', params: { thickness: 0.2 } } },
      palette: blueprint.palette,
      lightRig: 'rim',
      atmosphere: blueprint.atmosphere,
      materialRoles: {},
      camera: { kind: 'orbit' },
      audio: {},
    },
  };
}

/** Číslovka slovem i číslicí. Věty v korpusu píšou obojí („three keys", „60 seconds"). */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/**
 * Číslo z věty. `max` je strop **počtu entit**, ne obecný — sekundy se jím
 * nesmějí ořezat, jinak z „60 sekund" vyjdou tři tiky a odpočet ztratí smysl.
 */
function countIn(sentence: string, fallback: number, max = Number.POSITIVE_INFINITY): number {
  const digits = /\b(\d+)\b/.exec(sentence);
  if (digits) return Math.min(max, Math.max(1, Number(digits[1])));
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`).test(sentence)) return Math.min(max, value);
  }
  return Math.min(max, fallback);
}

/** Kolik entit smí jeden tvar postavit. Šest stačí na každou větu v korpusu. */
const MAX_ENTITIES = 6;

function named(stem: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${stem}${index + 1}`);
}

/**
 * Povaha z přídavného jména ve větě.
 *
 * Čte se **z věty**, ne z tvaru: dvě věty o témž strážci se liší jedním slovem
 * a musí dát jinak se chovající postavu, jinak by povaha byla konstanta tvaru a
 * model by o postavě nerozhodoval o nic víc než o barvě zdi.
 */
const DISPOSITION_WORDS: readonly (readonly [RegExp, AgentDisposition])[] = [
  [/\b(wary|cautious|timid|shy|nervous|careful|scared)\b/i, 'wary'],
  [/\b(restless|pacing|frantic|twitchy|erratic|jumpy)\b/i, 'restless'],
  [/\b(bold|fearless|brave|relentless|aggressive|tireless)\b/i, 'bold'],
];

function dispositionIn(sentence: string): AgentDisposition {
  return DISPOSITION_WORDS.find(([pattern]) => pattern.test(sentence))?.[1] ?? 'bold';
}

export interface ShapeDefinition {
  /** Jméno tvaru. Objevuje se ve stopě, aby bylo vidět, co větu obsloužilo. */
  readonly id: string;
  readonly matches: RegExp;
  readonly plan: (sentence: string) => Blueprint;
}

/**
 * Tvary v pořadí, ve kterém se zkoušejí. **První shoda vyhrává**, takže užší
 * tvary stojí před širšími — „tři klíče od dveří" je specifičtější než „dojdi
 * do cíle" a musí se rozhodnout dřív.
 */
export const SHAPES: readonly ShapeDefinition[] = [
  {
    id: 'keys-to-door',
    matches: /\bkeys?\b[\s\S]*\b(door|exit|gate)\b|\b(door|exit|gate)\b[\s\S]*\bkeys?\b/i,
    plan: (sentence) => ({
      items: named('key', countIn(sentence, 3, MAX_ENTITIES)),
      goal: 'exitDoor',
      lever: null,
      timerTicks: null,
      palette: 'stone',
      atmosphere: 'clear',
    }),
  },
  {
    id: 'lever-opens-the-way',
    matches: /\b(lever|switch|handle)\b/i,
    plan: () => ({
      items: [],
      goal: 'gate',
      lever: 'lever',
      timerTicks: null,
      palette: 'amber',
      atmosphere: 'clear',
    }),
  },
  {
    id: 'button-dispenses',
    matches: /\b(button|vending)\b/i,
    plan: () => ({
      items: [],
      goal: 'hatch',
      lever: 'button',
      timerTicks: null,
      palette: 'neon',
      atmosphere: 'rain',
    }),
  },
  {
    id: 'beat-the-clock',
    matches: /\b(seconds?|minutes?|timer|countdown|before time|floods?|rises?)\b/i,
    plan: (sentence) => ({
      items: [],
      goal: 'hatch',
      lever: null,
      // Věta mluví v sekundách, simulace v ticích — 20 Hz podle `VERIFY.md` §3.3.
      timerTicks: Math.min(H_CERT, countIn(sentence, 30) * 20),
      palette: 'steel',
      atmosphere: 'fog',
    }),
  },
  {
    id: 'fetch-then-open',
    matches: /\b(chest|torch|bring|carry)\b/i,
    plan: (sentence) => ({
      items: named('item', countIn(sentence, 1, MAX_ENTITIES)),
      goal: 'chest',
      lever: null,
      timerTicks: null,
      palette: 'stone',
      atmosphere: 'fog',
    }),
  },
  {
    id: 'pressure-plates',
    matches: /\b(pressure )?plates?\b/i,
    plan: (sentence) => ({
      items: named('plate', countIn(sentence, 3, MAX_ENTITIES)),
      goal: 'heavyDoor',
      lever: null,
      timerTicks: null,
      palette: 'stone',
      atmosphere: 'clear',
    }),
  },
  {
    id: 'collect-to-score',
    matches: /\b(collect|harvest|gather|coins?|score)\b/i,
    plan: (sentence) => ({
      items: named('token', countIn(sentence, 3, MAX_ENTITIES)),
      goal: 'podium',
      lever: null,
      timerTicks: null,
      palette: 'meadow',
      atmosphere: 'clear',
    }),
  },
  {
    id: 'code-lock',
    matches: /\b(code|combination|keypad|password)\b/i,
    plan: () => ({
      items: [],
      goal: 'vault',
      lever: 'keypad',
      timerTicks: null,
      palette: 'steel',
      atmosphere: 'clear',
    }),
  },
  {
    /**
     * Věta mluví o postavě, ne o mechanice. Stojí až za mechanickými tvary
     * schválně: „strážce drží tři klíče od dveří" je pořád hlavolam s klíči,
     * jen s postavou navíc, a odebrat mu klíče kvůli slovu „strážce" by z užší
     * shody udělalo širší.
     */
    id: 'patrolling-character',
    matches: /\b(guards?|sentry|sentries|patrols?|patrolling|wolf|robots?|creature|monster|watchman)\b/i,
    plan: (sentence) => ({
      items: [],
      goal: 'exit',
      // Páka je tu proto, aby hráč nedošel k východu na první krok svědka. Svět,
      // ve kterém se vyhraje kolem desátého tiku, o hlídce nic neukáže — běh
      // skončí dřív, než postava dojde na druhou zastávku, a povaha by tak byla
      // deklarace bez pozorovatelného následku.
      lever: 'switchbox',
      timerTicks: null,
      palette: 'stone',
      atmosphere: 'fog',
      agent: { id: 'watcher', disposition: dispositionIn(sentence), goals: ['post', 'hall', 'alcove'] },
    }),
  },
  {
    id: 'reach-the-goal',
    matches: /\b(reach|finish|goal line|race|escape|get out)\b/i,
    plan: () => ({
      items: [],
      goal: 'finish',
      lever: null,
      timerTicks: null,
      palette: 'meadow',
      atmosphere: 'clear',
    }),
  },
];

/**
 * Věta na emisi, bez modelu. `null` znamená „tenhle tvar neznám" — a to je
 * odpověď, ne selhání: `./emit` v tu chvíli předá slovo modelu.
 */
export function recognize(sentence: string): unknown | null {
  for (const shape of SHAPES) {
    if (shape.matches.test(sentence)) return buildEmission(shape.plan(sentence));
  }
  return null;
}

/** Který tvar větu obslouží. Pro stopu a pro testy; `null` když žádný. */
export function shapeIdFor(sentence: string): string | null {
  return SHAPES.find((shape) => shape.matches.test(sentence))?.id ?? null;
}
