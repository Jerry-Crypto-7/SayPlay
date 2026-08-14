/**
 * Kontrafaktuální mutace pozitivních případů (T16, AC věta třetí).
 *
 * ## Proč tenhle soubor existuje
 *
 * Pevná sada negativů nedokazuje, že scorer vyhodnocuje **jednotlivé** požadavky.
 * Implementace, která vrátí `FULFILLED` podle ID známého promptu, projde každým
 * pozitivním i negativním fixture — a projde i sadou, která jen kontroluje, že
 * rozbitý svět nedostane `FULFILLED`. Review v3 nad T16 to pojmenovalo jako
 * jediný podvod, který se testem shora nedá odhalit.
 *
 * Odpověď je tady: pro **každý** požadavek **každého** pozitivního kontraktu
 * existuje mutace, která ten jeden požadavek poruší. Když scorer daný požadavek
 * ve skutečnosti neměří, mutace verdikt nepřeklopí a test padne.
 *
 * ## Co každá mutace deklaruje
 *
 * `rid` je terč — ten požadavek **musí** v mutantovi selhat. `collateral` je
 * úplný seznam ostatních požadavků, které selžou taky, a test ho asertuje jako
 * rovnost, ne jako podmnožinu. Vedlejší škoda je tu tedy zamčená, ne odpuštěná:
 * kdyby se mutace jednou rozjela do šířky, sada zčervená.
 *
 * **Prázdná `collateral` je běžný případ, ne výjimka.** Kde prázdná není, je to
 * fyzická vlastnost světa, ne slabina mutace — graf bez akce `win` nemůže mít
 * certifikovaného svědka a prohra, která nenastane, se nedá pozorovat. Důvod
 * nese `why` u každé takové položky.
 *
 * ## Proč se mutuje patch, ne hotový dokument
 *
 * U editační větve jde mutace do **operací**, které pak projdou skutečným
 * routerem a `commitPart` (`applyEdit` v `./corpus`). Mutovat až sloučený
 * výsledek by obešlo tu půlku cesty, kterou T13/T14 postavily, a měřilo by
 * scorer proti dokumentu, jaký produkce nikdy nevydá. Jediná výjimka je
 * `revisionBumped`: revize je vlastnost commitu, ne grafu, a patch na ni nedosáhne
 * — ta jediná se mutuje na obálce hotového dokumentu.
 */

import { applyEdit, clone, loadResponses, type FrozenCase } from './corpus';
import type { Evidence } from '../semantic';

export interface Mutation {
  /** Požadavek, který mutace cílí. V mutantovi MUSÍ být nesplněný. */
  readonly rid: string;
  /** Co mutace udělá. Čte to člověk při revizi, ne stroj. */
  readonly label: string;
  /** Proč to porušuje právě ten požadavek — a proč případně i ty ve `collateral`. */
  readonly why: string;
  /** Úplný seznam DALŠÍCH požadavků, které mutace shodí. Asertuje se rovností. */
  readonly collateral: readonly string[];
  readonly build: (base: FrozenCase) => Evidence;
}

type Sim = Record<string, any>;

/** Klon dokumentu s mutací nad povrchovým `sim`. */
function withSim(base: FrozenCase, mutate: (sim: Sim) => void): Evidence {
  if (base.evidence.kind !== 'create' || base.evidence.outcome !== 'emitted')
    throw new Error(`${base.id} není emitovaný create případ`);
  const doc = clone(base.evidence.doc) as Record<string, any>;
  mutate(doc.sim as Sim);
  return { kind: 'create', outcome: 'emitted', doc, sceneBuilt: true };
}

/** Klon základního světa a patche s mutací nad **operacemi**, pak skutečný commit. */
function withPatch(base: FrozenCase, mutate: (ops: any[]) => any[] | void): Evidence {
  const source = editSourceOf(base);
  const ops = clone(source.operations);
  return applyEdit(clone(source.before), mutate(ops) ?? ops);
}

/** Mutace obálky hotového dokumentu. Jen pro `revisionBumped` — viz hlavička. */
function withCommittedDoc(base: FrozenCase, mutate: (after: Record<string, any>) => void): Evidence {
  if (base.evidence.kind !== 'edit' || base.evidence.outcome !== 'committed')
    throw new Error(`${base.id} není commitnutý edit případ`);
  const after = clone(base.evidence.after) as Record<string, any>;
  mutate(after);
  return { kind: 'edit', outcome: 'committed', before: base.evidence.before, after, sceneBuilt: true };
}

/**
 * Základní svět a operace editačního případu.
 *
 * `FrozenCase` nese až výsledek commitu, takže se sem musí dostat vstupy. Bere
 * je ze zmrazených odpovědí týmž způsobem jako `frozenCases()` — jinými slovy
 * mutace vychází ze stejného artefaktu jako pozitivní běh.
 */
let editSources: Map<string, { before: unknown; operations: unknown[] }> | null = null;

function editSourceOf(base: FrozenCase): { before: unknown; operations: any[] } {
  if (editSources === null) editSources = buildEditSources();
  const found = editSources.get(base.id);
  if (found === undefined) throw new Error(`${base.id} není editační případ`);
  return { before: found.before, operations: found.operations as any[] };
}

function buildEditSources(): Map<string, { before: unknown; operations: unknown[] }> {
  const responses = loadResponses();
  const bodyById = new Map(responses.map((response) => [response.forPrompt, response.body]));
  const out = new Map<string, { before: unknown; operations: unknown[] }>();
  for (const response of responses) {
    if (response.branch !== 'edit') continue;
    const before = bodyById.get(response.baseWorld ?? '');
    if (before === undefined) continue;
    out.set(response.forPrompt, { before, operations: response.body as unknown[] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Znovupoužitelné tvary mutací
// ---------------------------------------------------------------------------

/** Akce, která projde snížením a nesahá na hashovaný stav. Nahrazuje jinou akci. */
const INERT_ACTION = { kind: 'playEffect', id: 'mutant' };

/** Pravidlo, které vyhraje v tiku 0 bez jediného vstupu. */
const INSTA_WIN = {
  id: 'mutantInstaWin',
  phase: 0,
  priority: 9,
  event: { kind: 'onStart' },
  condition: null,
  actions: [{ kind: 'win' }],
};

/**
 * Druhá, na vstupu **nezávislá** cesta k výhře.
 *
 * Tohle je jediný tvar, který ruší `counterfactual` a nechává `witnessCertifies`
 * i `notWinnableAtSetup` naživu: svět po `after` ticích vyhraje sám, takže žádný
 * jednotlivý vstup svědka není příčinný — ale v tiku 0 ještě nevyhrál a plný
 * svědek dojde do výhry dřív, takže se pozorování ve výhře nezmění.
 */
function freeWinAfter(sim: Sim, after: number): void {
  sim.state.timers = { ...(sim.state.timers ?? {}), mutantAuto: { durationTicks: after, init: after } };
  sim.rules.mutantArm = {
    id: 'mutantArm',
    phase: 0,
    priority: 8,
    event: { kind: 'onStart' },
    condition: null,
    actions: [{ kind: 'startTimer', ref: 'mutantAuto' }],
  };
  sim.rules.mutantFree = {
    id: 'mutantFree',
    phase: 3,
    priority: 8,
    event: { kind: 'onTimerEnd', timer: 'mutantAuto' },
    condition: null,
    actions: [{ kind: 'win' }],
  };
}

/**
 * Spawn nad plným světem — `runtimeFault` s důvodem `entity-cap`.
 *
 * **Signálový cyklus `onSignal(A) → emit(A)` by tuhle práci neudělal.** Fronta je
 * dvojitě bufferovaná, takže emise skončí ve frontě, ze které tentýž tik nečerpá
 * — zacyklení uvnitř tiku je strukturálně nemožné a takový svět doběhne bez
 * jediné vady (zmrazená poznámka v `src/sim/__fixtures__/signal-loop.world.json`).
 * Zato `maxEntities` se odvozuje jako počet deklarovaných entit, a ty jsou při
 * startu všechny aktivní: první `spawn` proto narazí na strop hned v tiku 0.
 */
function entityCapFault(sim: Sim): void {
  sim.rules.mutantFlood = {
    id: 'mutantFlood',
    phase: 0,
    priority: 7,
    event: { kind: 'onStart' },
    condition: null,
    actions: [{ kind: 'spawn', poolTag: 'mutantPool', socket: Object.keys(sim.sockets)[0] }],
  };
}

/** Deklarace navíc, kterou nečte jediné pravidlo. Mimo `allowedPaths` každého kontraktu. */
const STRAY_LEAF = { op: 'add', path: '/sim/state/flags/mutantStray', value: false };

// ---------------------------------------------------------------------------
// Tabulka mutací
// ---------------------------------------------------------------------------

const TABLE: Readonly<Record<string, readonly Mutation[]>> = {
  C01: [
    {
      rid: 'C01.g1',
      label: 'třetí klíč přestane být collectible',
      why: 'kontrakt žádá 3 entity v roli collectible; po změně role jsou 2. Pravidlo `pick` visí na téže roli, takže třetí klíč zároveň přestane počítat a výhra nenastane',
      collateral: ['C01.r1', 'C01.r4', 'C01.r5'],
      build: (base) => withSim(base, (sim) => void (sim.entities.key3.role = 'prop')),
    },
    {
      rid: 'C01.g2',
      label: 'čítač keysHeld dostane jinou horní mez',
      why: 'kontrakt žádá přesně max 3; čítač reálně doleze jen na 3, takže zvednutá mez nemění jediné chování',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.state.counters.keysHeld.max = 4)),
    },
    {
      rid: 'C01.g3',
      label: 'odemčení východu nahradí inertní akce',
      why: 'graf přestane obsahovat `setLocked`; stav `open` píše druhá akce téhož pravidla, takže výhra drží dál',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.rules.unlock.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C01.g4',
      label: 'vítězná akce se nahradí inertní',
      why: 'graf přestane obsahovat `win`. Svět bez vítězné akce nemůže mít certifikovaného svědka ani pozorování ve výhře — to je fyzika, ne slabina mutace',
      collateral: ['C01.r1', 'C01.r4', 'C01.r5'],
      build: (base) => withSim(base, (sim) => void (sim.rules.win.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C01.g5',
      label: 'stráž `counterIs` se odebere',
      why: 'graf přestane obsahovat podmínku `counterIs`; pravidlo dál hlídá tentýž práh svojí událostí `onCounterReaches`, takže se chování nezmění',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.rules.unlock.condition = null)),
    },
    {
      rid: 'C01.g6',
      label: 'sběr klíčů se přepne z `onPickup` na `onStart`',
      why: 'graf přestane obsahovat `onPickup`. Pravidlo pak vystřelí jednou v tiku 0, čítač doleze na 1 a výhra nenastane',
      collateral: ['C01.r1', 'C01.r4', 'C01.r5'],
      build: (base) => withSim(base, (sim) => void (sim.rules.pick.event = { kind: 'onStart' })),
    },
    {
      rid: 'C01.r1',
      label: 'svět požádá o delší tier',
      why: 'kontrakt žádá certifikaci v tieru `short`; svět se certifikuje dál, ale ve `standard`, takže padne jen shoda tieru',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.witness.tier = 'standard')),
    },
    {
      rid: 'C01.r2',
      label: 'přidá se pravidlo vyhrávající v tiku 0',
      why: 'výhra při setupu začne platit. Ve vyhraném tiku 0 ještě nikdo nesebral klíč a žádný vstup svědka není příčinný. Vyhraný tik 0 zároveň leží PŘED každým vstupem svědka, takže verifikátor celou stopu odmítne jako nedohratelnou (`STEP_UNREACHABLE`) a certifikace padne s ní',
      collateral: ['C01.r1', 'C01.r4', 'C01.r5'],
      build: (base) => withSim(base, (sim) => void (sim.rules.mutantInstaWin = { ...INSTA_WIN })),
    },
    {
      rid: 'C01.r3',
      label: 'východ začíná odemčený',
      why: 'pozorování v tiku 0 žádá `locked == true`. Odemčený start nic jiného nemění — bránu k výhře drží stav `open`, ne zámek',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.entities.exit.locked = false)),
    },
    {
      rid: 'C01.r4',
      label: 'vstup do východu ubere klíč dřív, než se vyhraje',
      why: 'pozorování ve výhře žádá `keysHeld == 3`; nové pravidlo ve fázi 1 sníží čítač na 2 ještě před vítězným pravidlem ve fázi 2. Odemčení proběhlo dávno předtím, takže cesta k výhře zůstává',
      collateral: [],
      build: (base) =>
        withSim(base, (sim) => {
          sim.rules.mutantDrain = {
            id: 'mutantDrain',
            phase: 1,
            priority: 5,
            event: { kind: 'onEnterZone', entity: 'player', zone: 'exit' },
            condition: null,
            actions: [{ kind: 'addCounter', ref: 'keysHeld', by: -1 }],
          };
        }),
    },
    {
      rid: 'C01.r5',
      label: 'svět po 500 ticích vyhraje sám',
      why: 'plný svědek dojde do výhry v tiku 268, tedy dřív — pozorování ve výhře se nemění. Po odebrání kteréhokoli jednotlivého vstupu ale výhra nastane stejně, takže žádný není příčinný',
      collateral: [],
      build: (base) => withSim(base, (sim) => freeWinAfter(sim, 500)),
    },
    {
      rid: 'C01.r6',
      label: 'spawn nad plným světem',
      why: 'replay skončí v `runtimeFault` s důvodem `entity-cap`. Tik, který faultne, se atomicky vrátí na začátek, takže se svět nikam nedostane a nic dalšího se v něm nezměří',
      collateral: ['C01.r1', 'C01.r4', 'C01.r5'],
      build: (base) => withSim(base, entityCapFault),
    },
  ],

  C02: [
    {
      rid: 'C02.g1',
      label: 'potopa trvá o tik méně',
      why: 'kontrakt žádá přesně 1200 tiků. Prohra se posune o tik dřív, což je pořád uvnitř meze `reachesLose` i s nulovým zbytkem na časovači',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.state.timers.flood.durationTicks = 1199)),
    },
    {
      rid: 'C02.g2',
      label: 'utonutí se přepne z `onTimerEnd` na stav, který nikdy nenastane',
      why: 'graf přestane obsahovat `onTimerEnd`. Prohra tím zmizí úplně, takže ji nejde ani dosáhnout, ani pozorovat',
      collateral: ['C02.r3', 'C02.r4'],
      build: (base) =>
        withSim(base, (sim) => void (sim.rules.drown.event = { kind: 'onStateEnter', entity: 'valve', state: 'sealed' })),
    },
    {
      rid: 'C02.g3',
      label: 'prohrávající akce se nahradí inertní',
      why: 'graf přestane obsahovat `lose`. Bez prohrávající akce prohra nenastane a nedá se pozorovat',
      collateral: ['C02.r3', 'C02.r4'],
      build: (base) => withSim(base, (sim) => void (sim.rules.drown.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C02.g4',
      label: 'vítězná akce se nahradí inertní',
      why: 'graf přestane obsahovat `win`. Svědek se pak nemá kam dojít a kontrafaktuál nad necertifikujícím svědkem je vakuózní',
      collateral: ['C02.r1', 'C02.r5'],
      build: (base) => withSim(base, (sim) => void (sim.rules.win.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C02.g5',
      label: 'poklop přestane být cílem',
      why: 'kontrakt žádá aspoň jednu entitu v roli goal. Vítězné pravidlo míří na **zónu** poklopu, ne na jeho roli, takže výhra drží dál',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.entities.hatch.role = 'prop')),
    },
    {
      rid: 'C02.r1',
      label: 'svět požádá o delší tier',
      why: 'kontrakt žádá `standard`; certifikace projde v `long`, takže padne jen shoda tieru',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.witness.tier = 'long')),
    },
    {
      rid: 'C02.r2',
      label: 'přidá se pravidlo vyhrávající v tiku 0',
      why: 'výhra při setupu začne platit. Vyhraný tik 0 zároveň předběhne potopu, takže prohra přestane nastávat a žádný vstup svědka není příčinný. Vyhraný tik 0 zároveň leží PŘED každým vstupem svědka, takže verifikátor celou stopu odmítne jako nedohratelnou (`STEP_UNREACHABLE`) a certifikace padne s ní',
      collateral: ['C02.r1', 'C02.r3', 'C02.r4', 'C02.r5'],
      build: (base) => withSim(base, (sim) => void (sim.rules.mutantInstaWin = { ...INSTA_WIN })),
    },
    {
      rid: 'C02.r3',
      label: 'utonutí dostane stráž, která nikdy neplatí',
      why: 'prohra přestane nastávat uvnitř deklarované meze. Okamžik prohry tím zmizí a nedá se v něm nic přečíst',
      collateral: ['C02.r4'],
      build: (base) =>
        withSim(base, (sim) => void (sim.rules.drown.condition = { kind: 'stateIs', target: 'valve', value: 'sealed' })),
    },
    {
      rid: 'C02.r4',
      label: 'utonutí po prohře znovu spustí časovač',
      why: 'kontrakt čte v okamžiku prohry `remainingTicks == 0`; restart uvnitř téhož tiku ho vrátí na plnou dobu. Prohra sama nastane pořád ve stejném tiku, takže mez `reachesLose` drží',
      collateral: [],
      build: (base) =>
        withSim(base, (sim) => void (sim.rules.drown.actions = [{ kind: 'lose' }, { kind: 'startTimer', ref: 'flood' }])),
    },
    {
      rid: 'C02.r5',
      label: 'svět po 800 ticích vyhraje sám',
      why: 'po odebrání kteréhokoli vstupu se vyhraje stejně, takže žádný není příčinný. Volná výhra zároveň předběhne potopu v tiku 1201, takže deklarovaná prohra přestane nastávat',
      collateral: ['C02.r3', 'C02.r4'],
      build: (base) => withSim(base, (sim) => freeWinAfter(sim, 800)),
    },
    {
      rid: 'C02.r6',
      label: 'spawn nad plným světem',
      why: 'replay skončí v `runtimeFault` s důvodem `entity-cap` a svět se nikam nedostane — ani do výhry, ani do prohry',
      collateral: ['C02.r1', 'C02.r3', 'C02.r4', 'C02.r5'],
      build: (base) => withSim(base, entityCapFault),
    },
  ],

  C04: [
    {
      rid: 'C04.g1',
      label: 'stráž `hasItem` se odebere',
      why: 'graf přestane obsahovat podmínku `hasItem`. Kontrafaktuál to nepohne: ptá se, jestli je příčinný NĚKTERÝ vstup, a otevření truhly jím zůstává i bez stráže',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.rules.open.condition = null)),
    },
    {
      rid: 'C04.g2',
      label: 'předání pochodně se přepne z `onPickup` na `onStart`',
      why: 'graf přestane obsahovat `onPickup`. Pochodeň se předá v tiku 0, takže hráč ji ve výhře pořád drží a poslední vstup svědka je dál příčinný',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.rules.take.event = { kind: 'onStart' })),
    },
    {
      rid: 'C04.g3',
      label: 'odemčení truhly nahradí inertní akce',
      why: 'graf přestane obsahovat `setLocked`; výhru odpaluje třetí akce téhož pravidla, takže cesta k ní zůstává',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.rules.open.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C04.g4',
      label: 'vítězná akce se nahradí inertní',
      why: 'graf přestane obsahovat `win`. Bez ní se svědek nemá kam dojít, ve výhře se nedá nic přečíst a kontrafaktuál je vakuózní',
      collateral: ['C04.r1', 'C04.r3', 'C04.r4'],
      build: (base) => withSim(base, (sim) => void (sim.rules.open.actions[2] = { ...INERT_ACTION })),
    },
    {
      rid: 'C04.g5',
      label: 'dva ze tří soketů zmizí a jejich entity se přesunou na spawn',
      why: 'kontrakt žádá aspoň 2 různé sokety, zůstane 1. Svědek míří na ENTITY `torch` a `chest`, ne na jejich sokety, a po přesunu stojí obě tam co hráč — takže běh projde beze změny',
      collateral: [],
      build: (base) =>
        withSim(base, (sim) => {
          delete sim.sockets.torch;
          delete sim.sockets.chest;
          sim.entities.torch.socket = 'spawn';
          sim.entities.chest.socket = 'spawn';
        }),
    },
    {
      rid: 'C04.g6',
      label: 'inventář ztratí svůj jediný slot',
      why: 'kontrakt žádá aspoň 1 slot. Deklarovaný počet je tvrzení povrchu — běhová tabulka slotů se odvozuje z toho, co se doopravdy používá (`maxSlots` v `src/ir/build.ts`), takže se běh nezmění',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.state.slots = 0)),
    },
    {
      rid: 'C04.r1',
      label: 'svět požádá o delší tier',
      why: 'kontrakt žádá `short`; certifikace projde ve `standard`, takže padne jen shoda tieru',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.witness.tier = 'standard')),
    },
    {
      rid: 'C04.r2',
      label: 'přidá se pravidlo vyhrávající v tiku 0',
      why: 'výhra při setupu začne platit. V tiku 0 hráč pochodeň ještě nedrží a žádný vstup svědka není příčinný. Vyhraný tik 0 zároveň leží PŘED každým vstupem svědka, takže verifikátor celou stopu odmítne jako nedohratelnou (`STEP_UNREACHABLE`) a certifikace padne s ní',
      collateral: ['C04.r1', 'C04.r3', 'C04.r4'],
      build: (base) => withSim(base, (sim) => void (sim.rules.mutantInstaWin = { ...INSTA_WIN })),
    },
    {
      rid: 'C04.r3',
      label: 'otevření truhly hráči pochodeň zase vezme',
      why: 'pozorování ve výhře žádá drženou pochodeň; nové pravidlo ve fázi 2 ji sebere v témže tiku, ve kterém vítězné pravidlo ve fázi 1 už vyhrálo. Stráž `hasItem` v okamžiku výstřelu platila, takže výhra nastane pořád',
      collateral: [],
      build: (base) =>
        withSim(base, (sim) => {
          sim.rules.mutantStrip = {
            id: 'mutantStrip',
            phase: 2,
            priority: 5,
            event: { kind: 'onAction', actionId: 'use', target: 'chest' },
            condition: null,
            actions: [{ kind: 'takeItem', slot: 0, item: 'torch' }],
          };
        }),
    },
    {
      rid: 'C04.r4',
      label: 'svět po 500 ticích vyhraje sám',
      why: 'plný svědek vyhraje v tiku 390, tedy dřív — pozorování ve výhře se nemění. Po odebrání kteréhokoli vstupu se ale vyhraje taky, takže žádný není příčinný',
      collateral: [],
      build: (base) => withSim(base, (sim) => freeWinAfter(sim, 500)),
    },
    {
      rid: 'C04.r5',
      label: 'spawn nad plným světem',
      why: 'replay skončí v `runtimeFault` s důvodem `entity-cap` a svět se nikam nedostane',
      collateral: ['C04.r1', 'C04.r3', 'C04.r4'],
      build: (base) => withSim(base, entityCapFault),
    },
  ],

  C06: [
    {
      rid: 'C06.g1',
      label: 'čítač dnů dostane jinou horní mez',
      why: 'kontrakt žádá přesně max 16; čítač doleze na 5, takže zvednutá mez nemění jediné chování',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.state.counters.day.max = 17)),
    },
    {
      rid: 'C06.g2',
      label: 'pátý den se přepne z `onCounterReaches` na `onStart`',
      why: 'graf přestane obsahovat `onCounterReaches`. Větev pak vystřelí v tiku 0, takže svět vyhraje při setupu s nulou dnů — a vyhraný tik 0 zároveň leží PŘED každým vstupem svědka, takže verifikátor celou stopu odmítne jako nedohratelnou (`STEP_UNREACHABLE`) a certifikace padne s ní',
      collateral: ['C06.r1', 'C06.r2', 'C06.r3', 'C06.r6'],
      build: (base) => withSim(base, (sim) => void (sim.rules.day5Branch.event = { kind: 'onStart' })),
    },
    {
      rid: 'C06.g3',
      label: 'spánek přestane přičítat den',
      why: 'graf přestane obsahovat `addCounter`. Čítač zůstane na nule, větev nevystřelí a výhra nenastane',
      collateral: ['C06.r1', 'C06.r3', 'C06.r5', 'C06.r6'],
      build: (base) => withSim(base, (sim) => void (sim.rules.sleep.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C06.g4',
      label: 'spánek se přepne z `onAction` na `onStart`',
      why: 'graf přestane obsahovat `onAction`. Den se přičte jednou v tiku 0, na pátý se nikdy nedojde a výhra nenastane',
      collateral: ['C06.r1', 'C06.r3', 'C06.r5', 'C06.r6'],
      build: (base) => withSim(base, (sim) => void (sim.rules.sleep.event = { kind: 'onStart' })),
    },
    {
      rid: 'C06.g5',
      label: 'rozsvícení majáku nahradí inertní akce',
      why: 'graf přestane obsahovat `setState`; výhru odpaluje druhá akce téhož pravidla, takže se běh nezmění',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.rules.day5Branch.actions[0] = { ...INERT_ACTION })),
    },
    {
      rid: 'C06.r1',
      label: 'svět požádá o delší tier',
      why: 'kontrakt žádá `short`; certifikace projde ve `standard`, takže padne jen shoda tieru',
      collateral: [],
      build: (base) => withSim(base, (sim) => void (sim.witness.tier = 'standard')),
    },
    {
      rid: 'C06.r2',
      label: 'přidá se pravidlo vyhrávající v tiku 0',
      why: 'výhra při setupu začne platit. V tiku 0 je dnů nula, větev pátého dne nevystřelila a žádný vstup svědka není příčinný. Vyhraný tik 0 zároveň leží PŘED každým vstupem svědka, takže verifikátor celou stopu odmítne jako nedohratelnou (`STEP_UNREACHABLE`) a certifikace padne s ní',
      collateral: ['C06.r1', 'C06.r3', 'C06.r5', 'C06.r6'],
      build: (base) => withSim(base, (sim) => void (sim.rules.mutantInstaWin = { ...INSTA_WIN })),
    },
    {
      rid: 'C06.r3',
      label: 'pátý den se čítač v pozdější fázi vynuluje',
      why: 'pozorování ve výhře žádá `day >= 5`; nové pravidlo ve fázi 2 ho v témže tiku srazí na nulu. Vítězná větev ve fázi 1 už vystřelila, takže výhra i její počet výstřelů zůstávají',
      collateral: [],
      build: (base) =>
        withSim(base, (sim) => {
          sim.rules.mutantDrain = {
            id: 'mutantDrain',
            phase: 2,
            priority: 5,
            event: { kind: 'onCounterReaches', ref: 'day', threshold: 5 },
            condition: null,
            actions: [{ kind: 'addCounter', ref: 'day', by: -5 }],
          };
        }),
    },
    {
      rid: 'C06.r5',
      label: 'vyhrává jiná větev, ta sledovaná už na svůj práh nedosáhne',
      why: 'pozorování ve výhře žádá právě jeden výstřel větve `day5Branch`; po zvednutí prahu na 99 nevystřelí ani jednou, zatímco novou vítěznou větví se pořád vyhraje na pátý den',
      collateral: [],
      build: (base) =>
        withSim(base, (sim) => {
          sim.rules.day5Branch.event.threshold = 99;
          sim.rules.mutantAltWin = {
            id: 'mutantAltWin',
            phase: 1,
            priority: 5,
            event: { kind: 'onCounterReaches', ref: 'day', threshold: 5 },
            condition: null,
            actions: [{ kind: 'win' }],
          };
        }),
    },
    {
      rid: 'C06.r6',
      label: 'svět po 400 ticích vyhraje sám',
      why: 'plný svědek vyhraje v tiku 260, tedy dřív — obě pozorování ve výhře drží. Po odebrání kteréhokoli vstupu se ale vyhraje taky, takže žádný není příčinný',
      collateral: [],
      build: (base) => withSim(base, (sim) => freeWinAfter(sim, 400)),
    },
    {
      rid: 'C06.r7',
      label: 'spawn nad plným světem',
      why: 'replay skončí v `runtimeFault` s důvodem `entity-cap` a svět se nikam nedostane',
      collateral: ['C06.r1', 'C06.r3', 'C06.r5', 'C06.r6'],
      build: (base) => withSim(base, entityCapFault),
    },
  ],

  E02: [
    {
      rid: 'E02.e1',
      label: 'patch navíc založí nečtený flag',
      why: 'list mimo `allowedPaths`. Deklaraci, na kterou se neptá jediné pravidlo, nemůže nic dalšího zaznamenat',
      collateral: [],
      build: (base) => withPatch(base, (ops) => [...ops, { ...STRAY_LEAF }]),
    },
    {
      rid: 'E02.e2',
      label: 'práh se posune na 9 místo na 8',
      why: 'postpodmínka žádá přesně 8. Devítka leží na téže cestě, taky boří starého svědka a taky není no-op, takže se nic jiného nehne',
      collateral: [],
      build: (base) => withPatch(base, (ops) => void (ops[0].value = 9)),
    },
    {
      rid: 'E02.e3',
      label: 'čítač dnů začíná na třech',
      why: 'kontrakt žádá, aby starý svědek přestal platit; z trojky dojde pět spánků přesně na osmičku, takže svědek dál dochází do výhry. Musí dojít PRÁVĚ na poslední spánek — kdyby vyhrál dřív (třeba přičítáním po dvou), ležel by zbytek stopy za koncem běhu a verifikátor by ji odmítl jako nedohratelnou. Výchozí hodnota čítače leží mimo `allowedPaths`, což zaznamená i kontrola dosahu',
      collateral: ['E02.e1'],
      build: (base) =>
        withPatch(base, (ops) => [...ops, { op: 'replace', path: '/sim/state/counters/day/init', value: 3 }]),
    },
    {
      rid: 'E02.e4',
      label: 'revize `sim` se posune o dvě',
      why: 'kontrakt žádá posun přesně o jedna. Obálka je z hashovaného porovnání vyňatá, takže se posunem nezmění žádný změněný list',
      collateral: [],
      build: (base) => withCommittedDoc(base, (after) => void (after.simRevision += 1)),
    },
    {
      rid: 'E02.e5',
      label: 'patch zapíše práh, který tam už je',
      why: 'hashovaná část se nehne, takže je patch tichý no-op. Postpodmínka o osmičce tím přestane platit a starý svědek zůstane v platnosti, ačkoli ho kontrakt chce zneplatnit',
      collateral: ['E02.e2', 'E02.e3'],
      build: (base) => withPatch(base, (ops) => void (ops[0].value = 5)),
    },
    {
      rid: 'E02.e6',
      label: 'patch navíc přepíše chráněnou horní mez čítače',
      why: 'chráněné pozorování se změní. Mez leží mimo `allowedPaths`, což zaznamená i kontrola dosahu',
      collateral: ['E02.e1'],
      build: (base) =>
        withPatch(base, (ops) => [...ops, { op: 'replace', path: '/sim/state/counters/day/max', value: 20 }]),
    },
  ],

  E07: [
    {
      rid: 'E07.e1',
      label: 'patch navíc založí nečtený flag',
      why: 'list mimo `allowedPaths`, na který se neptá jediné pravidlo',
      collateral: [],
      build: (base) => withPatch(base, (ops) => [...ops, { ...STRAY_LEAF }]),
    },
    {
      rid: 'E07.e2',
      label: 'z odemčení se stane prohra místo despawnu',
      why: 'postpodmínka žádá `despawn`. `lose` má stejně jako `despawn` prázdné povinné argumenty, leží na téže cestě a starého svědka boří stejně jistě',
      collateral: [],
      build: (base) => withPatch(base, (ops) => void (ops[0].value = 'lose')),
    },
    {
      rid: 'E07.e3',
      label: 'despawn zamíří na už sebraný klíč místo na východ',
      why: 'kontrakt žádá, aby starý svědek přestal platit. Despawn klíče, který hráč v té chvíli dávno drží, na nic nesáhne, takže svědek dál dochází do výhry. Dosah to přesto zaznamená: `allowedPaths` na téhle cestě povoluje jen `add`, jenže pole `target` v původní akci UŽ JE (`setLocked` na východ), takže jiná hodnota je `replace`',
      collateral: ['E07.e1'],
      build: (base) => withPatch(base, (ops) => void (ops[2].value = 'key1')),
    },
    {
      rid: 'E07.e4',
      label: 'revize `sim` se posune o dvě',
      why: 'kontrakt žádá posun přesně o jedna',
      collateral: [],
      build: (base) => withCommittedDoc(base, (after) => void (after.simRevision += 1)),
    },
    {
      rid: 'E07.e5',
      label: 'patch zapíše akci, která tam už je',
      why: 'hashovaná část se nehne, takže je patch tichý no-op. Postpodmínka o despawnu tím přestane platit a starý svědek zůstane v platnosti',
      collateral: ['E07.e2', 'E07.e3'],
      build: (base) => withPatch(base, () => [{ op: 'replace', path: '/sim/rules/unlock/actions/0/kind', value: 'setLocked' }]),
    },
    {
      rid: 'E07.e6',
      label: 'patch navíc přepíše chráněnou horní mez čítače',
      why: 'chráněné pozorování se změní; mez leží mimo `allowedPaths`',
      collateral: ['E07.e1'],
      build: (base) =>
        withPatch(base, (ops) => [...ops, { op: 'replace', path: '/sim/state/counters/keysHeld/max', value: 9 }]),
    },
  ],

  E09: [
    {
      rid: 'E09.e1',
      label: 'patch navíc založí nečtený flag',
      why: 'list mimo `allowedPaths`, na který se neptá jediné pravidlo',
      collateral: [],
      build: (base) => withPatch(base, (ops) => [...ops, { ...STRAY_LEAF }]),
    },
    {
      rid: 'E09.e2',
      label: 'akce zůstane původním `setState`, doba se přesto doplní',
      why: 'postpodmínka žádá `freeze`. Původní akce je platná a chová se jako předtím, takže svědek drží — a druhá postpodmínka o době platí dál, protože ta se doplní tak jako tak',
      collateral: [],
      build: (base) => withPatch(base, (ops) => void (ops[0].value = 'setState')),
    },
    {
      rid: 'E09.e3',
      label: 'zmrazení potrvá 150 tiků místo 100',
      why: 'postpodmínka žádá přesně 100. Delší zmrazení leží na téže cestě a nastane až po dohoření, tedy dávno za výhrou svědka',
      collateral: [],
      build: (base) => withPatch(base, (ops) => void (ops[1].value = 150)),
    },
    {
      rid: 'E09.e4',
      label: 'z vítězné akce se stane prohra',
      why: 'kontrakt žádá, aby starý svědek dál platil; po záměně nedojde do výhry. Vítězné pravidlo leží mimo `allowedPaths`, což zaznamená i kontrola dosahu',
      collateral: ['E09.e1'],
      build: (base) =>
        withPatch(base, (ops) => [...ops, { op: 'replace', path: '/sim/rules/win/actions/0/kind', value: 'lose' }]),
    },
    {
      rid: 'E09.e5',
      label: 'revize `sim` se posune o dvě',
      why: 'kontrakt žádá posun přesně o jedna',
      collateral: [],
      build: (base) => withCommittedDoc(base, (after) => void (after.simRevision += 1)),
    },
    {
      rid: 'E09.e6',
      label: 'patch zapíše akci, která tam už je',
      why: 'hashovaná část se nehne, takže je patch tichý no-op. Obě postpodmínky tím padnou — `freeze` nenastane a doba se nedoplní',
      collateral: ['E09.e2', 'E09.e3'],
      build: (base) => withPatch(base, () => [{ op: 'replace', path: '/sim/rules/burnout/actions/0/kind', value: 'setState' }]),
    },
  ],

  E10: [
    {
      rid: 'E10.e1',
      label: 'patch navíc založí nečtený flag',
      why: 'list mimo `allowedPaths`, na který se neptá jediné pravidlo',
      collateral: [],
      build: (base) => withPatch(base, (ops) => [...ops, { ...STRAY_LEAF }]),
    },
    {
      rid: 'E10.e2',
      label: 'nové pravidlo se pověsí na `onStart` místo na akci hráče',
      why: 'postpodmínka žádá `onAction`. Časovač potopy se tím jen znovu spustí v tiku 0, což starého svědka ani chráněnou dobu nezmění — a celé pravidlo leží uvnitř `allowedPaths`',
      collateral: [],
      build: (base) => withPatch(base, (ops) => void (ops[2].value.event = { kind: 'onStart' })),
    },
    {
      rid: 'E10.e3',
      label: 'z vítězné akce se stane prohra',
      why: 'kontrakt žádá, aby starý svědek dál platil; po záměně nedojde do výhry. Vítězné pravidlo leží mimo `allowedPaths`',
      collateral: ['E10.e1'],
      build: (base) =>
        withPatch(base, (ops) => [...ops, { op: 'replace', path: '/sim/rules/win/actions/0/kind', value: 'lose' }]),
    },
    {
      rid: 'E10.e4',
      label: 'revize `sim` se posune o dvě',
      why: 'kontrakt žádá posun přesně o jedna',
      collateral: [],
      build: (base) => withCommittedDoc(base, (after) => void (after.simRevision += 1)),
    },
    {
      rid: 'E10.e5',
      label: 'patch zapíše šířku, kterou layout už má',
      why: 'hashovaná část se nehne, takže je patch tichý no-op. Pravidlo `pump` tím nevznikne a postpodmínka na jeho událost se nemá čeho zeptat',
      collateral: ['E10.e2'],
      build: (base) => withPatch(base, () => [{ op: 'replace', path: '/sim/layout/width', value: 16 }]),
    },
    {
      rid: 'E10.e6',
      label: 'patch navíc přepíše chráněnou dobu potopy',
      why: 'chráněné pozorování se změní; doba leží mimo `allowedPaths`',
      collateral: ['E10.e1'],
      build: (base) =>
        withPatch(base, (ops) => [...ops, { op: 'replace', path: '/sim/state/timers/flood/durationTicks', value: 1500 }]),
    },
  ],
};

/**
 * Požadavek, který **žádná** mutace grafu porušit nemůže, a proč.
 *
 * `C06.r4` čte `fireCount('day5Branch') == 0` v tiku 0. Okamžik tiku 0 je podle
 * `replay()` snímek **před** prvním tikem, takže tam ještě nevystřelilo nic —
 * a `fireCount` neznámého pravidla je taky 0. Podmínka je tedy pravdivá pro
 * každý myslitelný svět, včetně prázdného.
 *
 * Není to vada scoreru: v páru s `C06.r5` (`== 1` ve výhře) ta dvojice říká
 * „právě jednou" a tuhle půlku drží konstrukce. Zapisuje se sem proto, aby
 * nevznikl dojem, že se na ni při mutacích zapomnělo — sada ji místo mutace
 * dokazuje přímo (`semantic.test.ts`, „vakuózní požadavky").
 */
export const UNFALSIFIABLE: Readonly<Record<string, string>> = {
  'C06.r4': 'fireCount v tiku 0 je vždy 0 — tik 0 je snímek před prvním tikem',
};

export function mutationsFor(id: string): readonly Mutation[] {
  return TABLE[id] ?? [];
}

export const MUTATED_CASES: readonly string[] = Object.keys(TABLE);
