/**
 * Úrovně třídění (P66 T8): kola z front věcí, řada nádob a odkladiště. Jen čísla a pravidla hry bez jádra – staví
 * je generátor (`sort.ts`), hraje podle nich pravidlo `sort_tap`, robot (`sort-bot.ts`) i řešič testu.
 *
 * **Hra jednoho kola.** Nahoře `queues` front věcí, dole řada nádob: kolo má pořadí nádob `bins` (druh každé nádoby)
 * a vidět je vždy prvních `show` nevyplněných. Ťuk do fronty pošle její čelo do viditelné nádoby téhož druhu; když
 * žádná viditelná nádoba neodpovídá, jde věc do odkladiště. Nádoba s `capacity` věcmi je hotová a odjede, na konec
 * řady přijede další z pořadí a věci jejího druhu z odkladiště do ní hned přeskočí. Plné odkladiště (`slots` věcí)
 * je prohra, všechny nádoby kola hotové = kolo vyčištěné.
 *
 * Stav kola je celý ve věcech (`SortBoard`): fronty, odkladiště a kolik věcí každého druhu už je v nádobách. Které
 * nádoby jsou hotové a kolik má otevřená, z toho plyne (`visibleBins`): věc jde vždy do první nehotové nádoby svého
 * druhu (ta je vidět, kdykoli je vidět kterákoli pozdější), takže nádoby téhož druhu se plní popořadě.
 *
 * **Řešitelná konstrukcí.** Generátor staví kolo od vyřešeného stavu pozpátku: nejdřív zahraje vlastní řešení
 * (`witnessOrder` – pořadí ťuků, při kterém odkladiště nikdy nedojde do plna), pak řešení odehraje zpátky a každou
 * věc vrátí na čelo jedné fronty. Fronty tak drží věci přesně v pořadí, ve kterém je řešení bere, takže to řešení
 * vždy projde. Řešič (`solveBoard`) to na hotové úrovni ověří nezávisle prohledáním tahů (test na 200 semínkách).
 */

import { type CompileRng, createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS } from '../contract';
import { ROUNDS } from '../hooks/contract';
import { roundSeeds } from '../hooks/rounds';
import { LANES } from './lanes';

export const SORT = {
  /** Věcí v jedné nádobě. */
  capacity: 3,
  /** Míst v odkladišti; zaplněné všechny = prohra. */
  slots: 4,
  /** Věcí za celou hru (`COUNT_PARAMS.sort.default.collectible`); skutečný počet je násobek `capacity`, kola mají svá minima. */
  items: { min: 30, max: 60, default: 45 },
  rounds: { min: 2, max: 5, default: 3 },
  /** Hodiny kola nejvýš (s): kdo kolo nevyčistí včas, prohraje; kola si horizont ověření dělí (`roundTicks`). */
  roundSeconds: 60,
  points: 10,
  /** Okno série správných ťuků (tiky): delší než u akčních žánrů, třídění je hádanka. */
  comboWindow: 360,
  /** Nejvíc druhů (barev) v kole. */
  kinds: 5,
  /** Nejvíc nádob v kole: 24 věcí za minutu, ať na jednu zbydou aspoň 2,5 s. */
  roundBins: 8,
} as const;

/** Stupeň kola: druhy, viditelné nádoby, fronty, jak často řešení generátoru odkládá (‰) a nejméně nádob. */
export interface SortStage {
  readonly kinds: number;
  readonly show: number;
  readonly queues: number;
  readonly buffered: number;
  readonly least: number;
}

/**
 * Úvod (tři druhy, tři nádoby), prostřední kola (čtyři druhy) a finále (pět druhů, pět front); vidět jsou vždy tři
 * nádoby. Tlak dělá druhů víc než nádob: na 200 semínkách odkladiště se 4 místy vyhraje finále hráč, který ťuká
 * náhodně, ve 30–35 %, hráč, který posílá vždy, co pasuje, v 85–90 %, řešič vždy (měření v `evals/play/p66/README.md`).
 */
export const SORT_STAGES: readonly [SortStage, SortStage, SortStage] = [
  { kinds: 3, show: 3, queues: 3, buffered: 100, least: 3 },
  { kinds: 4, show: 3, queues: 4, buffered: 350, least: 4 },
  { kinds: 5, show: 3, queues: 5, buffered: 600, least: 5 },
];

/** Stupeň kola `round` z `rounds`: první je úvod, poslední finále. */
export const stageOf = (round: number, rounds: number): SortStage => SORT_STAGES[round === rounds - 1 ? 2 : round === 0 ? 0 : 1];

/**
 * Rozložení v jednotkách jádra (x do stran, z od nádob dozadu). Pozice věcí píše ovládání každý tik (`layoutRound`),
 * takže létající skóre i scéna kreslí věc tam, kde opravdu je; nádoby těla nemají, kreslí je jen scéna.
 */
export const SORT_LAYOUT = {
  /** Rozestup front. */
  column: 2000,
  /** Rozestup míst odkladiště a nádob. */
  slot: 1800,
  bin: 2600,
  binZ: 0,
  bufferZ: 1900,
  /** Řada čel front a rozestup řad za ní; vidět je `rows` řad, hlubší věci stojí v poslední. */
  rowZ: 3900,
  row: 1300,
  rows: 5,
  /** Hrdina za frontami (dál než poslední řada, aby se věcí nikdy nedotkl). */
  heroZ: 3900 + 5 * 1300 + 1300,
  /** Věci pozdějších kol čekají daleko za scénou; na začátku svého kola je ovládání rozestaví. */
  waitZ: 60_000,
  item: 1000,
  hero: { w: 1200, h: 1600, d: 1000 },
} as const;

/** Stav věci v odkladišti (bity stavu cíle, `stateChange`). */
export const SORT_BUFFERED = 1;

/** Střed sloupce `index` z `count` (fronty, místa odkladiště, nádoby) s rozestupem `gap`. */
const centered = (index: number, count: number, gap: number): number => ((2 * index - (count - 1)) * gap) / 2;
export const queueX = (queue: number, queues: number): number => centered(queue, queues, SORT_LAYOUT.column);
export const slotX = (slot: number, slots: number): number => centered(slot, slots, SORT_LAYOUT.slot);
export const binX = (bin: number, shown: number): number => centered(bin, shown, SORT_LAYOUT.bin);
export const rowZ = (row: number): number => SORT_LAYOUT.rowZ + Math.min(row, SORT_LAYOUT.rows - 1) * SORT_LAYOUT.row;
/** Fronta pod `x` (nejbližší střed). */
export const queueOfX = (x: number, queues: number): number => Math.min(queues - 1, Math.max(0, Math.round(x / SORT_LAYOUT.column + (queues - 1) / 2)));
/** Pruh vstupu (`lanes.ts`) první fronty: fronty leží v pruzích `first … first + queues − 1`, start hráče (pruh 2) mezi nimi. */
export const firstLane = (queues: number): number => Math.floor((LANES.count - queues) / 2);

// ---------------------------------------------------------------------------
// Kolo

export interface SortItem {
  readonly body: number;
  readonly kind: number;
}

/** Kolo ve hře: fronty (čelo první), odkladiště (v pořadí těl), věci v nádobách podle druhu a pevné meze kola. */
export interface SortBoard {
  readonly queues: SortItem[][];
  readonly buffer: SortItem[];
  readonly binned: number[];
  readonly bins: readonly number[];
  readonly show: number;
  readonly capacity: number;
  readonly slots: number;
}

export interface VisibleBin {
  /** Pořadí nádoby v kole (stálé id pro scénu). */
  readonly index: number;
  readonly kind: number;
  readonly fill: number;
}

/** Viditelné nádoby: prvních `show` nehotových v pořadí kola, s tím, kolik v nich je. */
export function visibleBins(bins: readonly number[], binned: readonly number[], show: number, capacity: number): VisibleBin[] {
  const before = new Array<number>(SORT.kinds).fill(0);
  const out: VisibleBin[] = [];
  for (let index = 0; index < bins.length && out.length < show; index += 1) {
    const kind = bins[index] as number;
    const filled = (binned[kind] ?? 0) - (before[kind] as number) * capacity;
    before[kind] = (before[kind] as number) + 1;
    if (filled < capacity) out.push({ index, kind, fill: Math.max(0, filled) });
  }
  return out;
}

export const boardBins = (board: SortBoard): VisibleBin[] => visibleBins(board.bins, board.binned, board.show, board.capacity);

/** Kam ťuk do fronty věc pošle: `tapped` = čelo, které hráč poslal; bez něj věc přeskočila z odkladiště. */
export interface SortMove extends SortItem {
  readonly to: 'bin' | 'buffer';
  readonly tapped: boolean;
}

export interface SortTap {
  readonly moves: readonly SortMove[];
  readonly outcome: 'win' | 'lose' | null;
}

const NO_TAP: SortTap = { moves: [], outcome: null };

/** Má viditelná nádoba druh `kind`? (Viditelná nádoba plná není – plná je hotová a odjela.) */
const opensFor = (board: SortBoard, kind: number): boolean => boardBins(board).some((bin) => bin.kind === kind);

/**
 * Ťuk do fronty `queue` (mění `board`): čelo do nádoby svého druhu, nebo do odkladiště; po každé nádobě, která se
 * tím doplní, přeskočí z odkladiště věci druhů, jejichž nádoba právě přijela. Prázdná fronta = nic.
 */
export function tapQueue(board: SortBoard, queue: number): SortTap {
  const line = board.queues[queue];
  const head = line?.[0];
  if (line === undefined || head === undefined) return NO_TAP;
  line.shift();
  if (!opensFor(board, head.kind)) {
    board.buffer.push(head);
    return { moves: [{ ...head, to: 'buffer', tapped: true }], outcome: board.buffer.length >= board.slots ? 'lose' : null };
  }
  board.binned[head.kind] = (board.binned[head.kind] as number) + 1;
  const moves: SortMove[] = [{ ...head, to: 'bin', tapped: true }];
  for (;;) {
    const open = new Set(boardBins(board).map((bin) => bin.kind));
    const next = board.buffer.findIndex((item) => open.has(item.kind));
    if (next < 0) break;
    const [item] = board.buffer.splice(next, 1) as [SortItem];
    board.binned[item.kind] = (board.binned[item.kind] as number) + 1;
    moves.push({ ...item, to: 'bin', tapped: false });
  }
  return { moves, outcome: cleared(board) ? 'win' : null };
}

/** Všechny nádoby kola hotové. */
export const cleared = (board: SortBoard): boolean => board.binned.reduce((sum, count) => sum + count, 0) === board.capacity * board.bins.length;

export const copyBoard = (board: SortBoard): SortBoard => ({ ...board, queues: board.queues.map((line) => [...line]), buffer: [...board.buffer], binned: [...board.binned] });

// ---------------------------------------------------------------------------
// Řešič

/** Klíč stavu: délky front (které věci zbývají) a druhy v odkladišti – z nich plyne i obsah nádob. */
function keyOf(board: SortBoard): string {
  const held = new Array<number>(SORT.kinds).fill(0);
  for (const item of board.buffer) held[item.kind] = (held[item.kind] as number) + 1;
  return `${board.queues.map((line) => line.length).join('.')}|${held.join('')}`;
}

/**
 * Tahy v pořadí, ve kterém je řešič zkouší: čela, která jdou rovnou do nádoby (nejdřív ta, co nádobu doplní), pak
 * odložení druhu, jehož nádoba přijede nejdřív.
 */
export function movesOf(board: SortBoard): number[] {
  const bins = boardBins(board);
  const fill = new Map(bins.map((bin) => [bin.kind, bin.fill] as const));
  const shown = bins.length === 0 ? 0 : (bins.at(-1) as VisibleBin).index + 1;
  const soon = (kind: number): number => {
    const at = board.bins.indexOf(kind, shown);
    return at < 0 ? board.bins.length : at;
  };
  const direct: { queue: number; rank: number }[] = [];
  const later: { queue: number; rank: number }[] = [];
  board.queues.forEach((line, queue) => {
    const head = line[0];
    if (head === undefined) return;
    if (fill.has(head.kind)) direct.push({ queue, rank: -(fill.get(head.kind) as number) });
    else later.push({ queue, rank: soon(head.kind) });
  });
  const order = (a: { queue: number; rank: number }, b: { queue: number; rank: number }): number => a.rank - b.rank || a.queue - b.queue;
  return [...direct.sort(order), ...later.sort(order)].map((move) => move.queue);
}

/**
 * Pořadí front, které kolo vyčistí bez plného odkladiště, nebo `null`. Prohledá tahy do hloubky a pamatuje si
 * stavy, ze kterých cesta nevede. `budget` = nejvýš tolik stavů (robot), pak `null`.
 */
export function solveBoard(board: SortBoard, budget = Number.POSITIVE_INFINITY): number[] | null {
  if (cleared(board)) return [];
  const dead = new Set<string>();
  let left = budget;
  const search = (state: SortBoard): number[] | null => {
    const key = keyOf(state);
    if (dead.has(key)) return null;
    for (const queue of movesOf(state)) {
      if (left <= 0) return null;
      left -= 1;
      const next = copyBoard(state);
      const tap = tapQueue(next, queue);
      if (tap.outcome === 'lose') continue;
      if (tap.outcome === 'win') return [queue];
      const rest = search(next);
      if (rest !== null) return [queue, ...rest];
    }
    if (left > 0) dead.add(key);
    return null;
  };
  return search(board);
}

// ---------------------------------------------------------------------------
// Stavba

/** Kolo z generátoru: pořadí nádob, kolik jich je vidět, fronty druhů (čelo první) a druhů celkem. */
export interface SortRound {
  readonly bins: readonly number[];
  readonly show: number;
  readonly queues: readonly (readonly number[])[];
  readonly kinds: number;
}

/**
 * Nádob v kolech: `items / capacity` po vahách 2, 3, 4… (pozdější kola větší), každé kolo aspoň minimum stupně
 * a nejvýš `SORT.roundBins` – hra tak může mít o něco víc nebo méně věcí, než `items` chce.
 */
export function binsPerRound(items: number, rounds: number): number[] {
  const total = Math.round(items / SORT.capacity);
  const weights = Array.from({ length: rounds }, (_, round) => round + 2);
  const sum = weights.reduce((all, weight) => all + weight, 0);
  const out = weights.map((weight) => Math.floor((total * weight) / sum));
  let rest = total - out.reduce((all, count) => all + count, 0);
  for (let round = rounds - 1; rest > 0; round = round === 0 ? rounds - 1 : round - 1, rest -= 1) out[round] = (out[round] as number) + 1;
  return out.map((count, round) => Math.min(SORT.roundBins, Math.max(count, stageOf(round, rounds).least)));
}

/**
 * Hodiny kol (tiky) z počtu věcí v kolech: horizont ověření bez přestávek (`ROUNDS.breakTicks`, třídění vylepšení
 * nenabízí) v poměru věcí, nejvýš `roundSeconds`. Nejpomalejší vyhraný běh – každé kolo vyčištěné v posledním tiku
 * svých hodin, každá přestávka celá – tak skončí v horizontu a výzvu z výhry server vezme (`score/dare.ts`). Dělení
 * podle věcí, ne rovným dílem: pozdější kola jsou větší a 5 kol po 16,8 s by finále s 18 věcmi nestihl ani robot.
 */
export function roundTicks(items: readonly number[]): number[] {
  const total = items.reduce((sum, count) => sum + count, 0);
  const play = ARCADE_LIMITS.maxTicks - (items.length - 1) * ROUNDS.breakTicks;
  return items.map((count) => Math.min(SORT.roundSeconds * ARCADE_HZ, Math.floor((count * play) / total)));
}

/** Pořadí nádob: každý druh jednou (zamíchané, takže první nádoby jsou různé), zbytek náhodné druhy. */
function binOrder(rng: CompileRng, kinds: number, count: number): number[] {
  const bins = rng.shuffle(Array.from({ length: kinds }, (_, kind) => kind));
  while (bins.length < count) bins.push(rng.int(0, kinds - 1));
  return bins;
}

/**
 * Řešení, ze kterého se kolo staví: pořadí druhů, jak je ťuky berou. Většinou věc do otevřené nádoby; s pravděpodobností
 * `buffered` ‰ věc, jejíž nádoba ještě nepřijela, do odkladiště – jen dokud po ní zbude aspoň jedno volné místo.
 * Tah do otevřené nádoby existuje vždy: otevřená nádoba čeká na věci svého druhu, v odkladišti žádné nejsou (přeskočily
 * by), takže zbývají ve frontách.
 */
export function witnessOrder(rng: CompileRng, bins: readonly number[], show: number, slots: number, buffered: number): number[] {
  const left = new Array<number>(SORT.kinds).fill(0);
  for (const kind of bins) left[kind] = (left[kind] as number) + SORT.capacity;
  const board: SortBoard = { queues: [], buffer: [], binned: new Array<number>(SORT.kinds).fill(0), bins, show, capacity: SORT.capacity, slots };
  const order: number[] = [];
  const total = bins.length * SORT.capacity;
  while (order.length < total) {
    const open = new Set(boardBins(board).map((bin) => bin.kind));
    const waiting = (kind: number): boolean => (left[kind] as number) > 0;
    const direct = [...open].filter(waiting).sort((a, b) => a - b);
    const later = Array.from({ length: SORT.kinds }, (_, kind) => kind).filter((kind) => waiting(kind) && !open.has(kind));
    if (direct.length === 0) throw new Error('sort: the witness has no item for an open bin');
    const park = later.length > 0 && board.buffer.length + 1 < slots && rng.int(0, 999) < buffered;
    const kind = park ? rng.pick(later) : rng.pick(direct);
    left[kind] = (left[kind] as number) - 1;
    order.push(kind);
    board.queues.splice(0, 1, [{ body: order.length, kind }]);
    tapQueue(board, 0);
  }
  return order;
}

/**
 * Kolo ze semínka kola: pořadí nádob, řešení a fronty z řešení pozpátku – prvních `queues` věcí řešení dostane každá
 * fronta jednu (žádná nezůstane prázdná), další jdou do náhodné fronty pod stropem hloubky.
 */
export function sortRound(seed: number, stage: SortStage, count: number, slots: number = SORT.slots): SortRound {
  const rng = createCompileRng(seed, 'layout');
  const kinds = Math.min(stage.kinds, count);
  const bins = binOrder(rng, kinds, count);
  const order = witnessOrder(rng, bins, stage.show, slots, stage.buffered);
  const deepest = Math.ceil(order.length / stage.queues) + 2;
  const first = rng.shuffle(Array.from({ length: stage.queues }, (_, queue) => queue));
  const queues: number[][] = first.map(() => []);
  order.forEach((kind, index) => {
    const open = queues.map((line, queue) => (line.length < deepest ? queue : -1)).filter((queue) => queue >= 0);
    const queue = index < stage.queues ? (first[index] as number) : rng.pick(open);
    (queues[queue] as number[]).push(kind);
  });
  return { bins, show: stage.show, queues, kinds };
}

/** Kola hry `seed`: semínka kol ze streamu háčků `rounds` (`roundSeeds`), každé kolo ze svého. */
export function sortRounds(seed: number, items: number, rounds: number): SortRound[] {
  const counts = binsPerRound(items, rounds);
  return roundSeeds(seed, rounds).map((roundSeed, round) => sortRound(roundSeed, stageOf(round, rounds), counts[round] as number));
}

/** Kolo jako hra od začátku (těla = pořadí věcí); pro řešič a testy. */
export function boardOfRound(round: SortRound, slots: number = SORT.slots): SortBoard {
  let body = 0;
  return {
    queues: round.queues.map((line) => line.map((kind) => ({ body: (body += 1), kind }))),
    buffer: [],
    binned: new Array<number>(SORT.kinds).fill(0),
    bins: round.bins,
    show: round.show,
    capacity: SORT.capacity,
    slots,
  };
}
