/**
 * Najdi anomálii z očí (P68-F T11, volitelný druhý řez kategorie `prvni-osoba`). Tatáž osa natočení jako střelnice
 * `railfps` (`YAW`, `aimTick`, držák `RIG`): hráč stojí uprostřed místnosti z věty, rozhlíží se po 9 sektorech a ťukem
 * ukáže na sektor. V každém sektoru stojí předměty místa (`room`). Každé kolo se v jednom sektoru v tiku `changeAt`
 * hodin kola změní jeden předmět – jiná barva, jiná velikost, chybí, nebo přibyl. Ťuk na sektor změny po změně =
 * kolo splněno (body, háčky dají přestávku a další kolo, po posledním výhra). Ťuk jinam, nebo dřív, než se cokoli
 * změnilo = ztráta života. Kdo změnu do `window` tiků nenajde, prohrál.
 *
 * Kusy (`RAILFPS_SPOT_PIECES`) nejsou ve sdílené knihovně – registraci (id, režim, `STAGES`, e2e) žádá
 * `evals/play/p68/prvni-osoba/integration.md`. Testy si je přidají do knihovny samy.
 *
 * Determinismus: celá čísla, náhoda jen při stavbě (`createCompileRng` ze semínka), čas v tikách. Jádro z místnosti
 * čte jen sektor a tik změny; předměty a druh změny jsou data pro scénu (`AnomalyScene.tsx`).
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeLevel,
  BODY,
  type BotPiece,
  BUTTON,
  type ControlPiece,
  type ModeGeneratorPiece,
  type ModeParts,
  NO_INPUT,
  type PieceRef,
  type RulePiece,
  START_LIVES,
  bodyBase,
} from '../contract';
import { ROUNDS } from '../hooks/contract';
import { inBreak, roundOf, withHooks } from '../hooks';
import { RAILFPS, RAILFPS_BODIES, RIG, YAW, aimOf, aimTick, clockOf, railfpsBodies, sectorToAxis, sectorToStep, shotOf, tickClock, writeAim } from './railfps';

/** Míry hádanky. */
export const SPOT = {
  /** Předmětů v každém sektoru; „přibyl“ přidá jeden navíc s indexem `perSector`. */
  perSector: 2,
  /** Tik hodin kola, kdy se předmět změní (2–4 s): dřív hráč místnost jen prohlíží. */
  changeFrom: 2 * ARCADE_HZ,
  changeTo: 4 * ARCADE_HZ,
  /** Tiků od změny, do kdy ji hráč musí najít (8 s). */
  window: 8 * ARCADE_HZ,
  points: 100,
  rounds: { min: 2, max: 5, default: 3 },
  /** Pás vzdálenosti předmětů (jednotky) a velikost v procentech. */
  near: 6000,
  far: 12000,
  size: { min: 80, max: 120, grown: 170, shrunk: 50 },
  /** Barev předmětu – scéna je bere z tokenů kitu. */
  colours: 4,
  /** Tvarů předmětu: index do rekvizit místa z věty (`look.props`). */
  shapes: 3,
} as const;

/** Druh změny. */
export const SPOT_CHANGE = { colour: 0, size: 1, missing: 2, extra: 3 } as const;

const template = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const sector = z.int().min(-YAW.maxSector).max(YAW.maxSector);

/** Předmět místnosti: `[sektor, index v sektoru, tvar, řádek výšky, barva, velikost %, vzdálenost]`. */
const item = z.tuple([sector, z.int().min(0).max(SPOT.perSector), z.int().min(0).max(SPOT.shapes - 1), z.int().min(0).max(2), z.int().min(0).max(SPOT.colours - 1), z.int().min(SPOT.size.shrunk).max(SPOT.size.grown), z.int().min(1).max(RAILFPS.range)]);
export type SpotItem = z.infer<typeof item>;

/** Změna kola: `[tik změny, sektor, index předmětu, druh, hodnota]` – hodnota je nová barva, velikost % nebo tvar přidaného. */
const change = z.tuple([z.int().min(1).max(ARCADE_LIMITS.maxTicks), sector, z.int().min(0).max(SPOT.perSector), z.int().min(0).max(3), z.int().min(0).max(SPOT.size.grown)]);
export type SpotChange = z.infer<typeof change>;

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z.object({ keeper: template, hooks: template }).strict();
export type RailfpsSpotControlParams = z.infer<typeof controlParams>;

/** Ovládání: hodiny kola a míření (`aimTick`) jako střelnice; hráč stojí, nic jiného se nehýbe. */
export const railfpsSpotControl: ControlPiece<RailfpsSpotControlParams> = {
  id: 'railfps_spot',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    tickClock(state, params.keeper, params.hooks);
    const p = bodyBase(player);
    state[p + BODY.vx] = 0;
    state[p + BODY.vz] = 0;
    const { next, shot } = aimTick(aimOf(state, params.keeper), input);
    writeAim(state, params.keeper, next, shot);
  },
};

// ---------------------------------------------------------------------------
// Pravidlo

const ruleParams = z
  .object({
    keeper: template,
    hooks: template,
    /** Tiků od změny na nalezení. */
    window: z.int().min(1).max(ARCADE_LIMITS.maxTicks),
    rounds: z.array(change).min(1).max(ROUNDS.max),
    /** Předměty místnosti – jen pro scénu, jádro je nečte. */
    room: z.array(item).min(1).max(YAW.sectors * SPOT.perSector),
  })
  .strict();
export type RailfpsSpotRuleParams = z.infer<typeof ruleParams>;

/**
 * Hádanka (stisk, hned za ovládáním): rána z tohoto tiku do sektoru změny po změně = kolo splněno (`win`, háčky
 * z něj před posledním kolem udělají přestávku); jiná rána = ztráta života; bez nálezu do `window` tiků od změny prohra.
 */
export const railfpsSpot: RulePiece<RailfpsSpotRuleParams> = {
  id: 'railfps_spot',
  params: ruleParams,
  roles: ['player'],
  trigger: 'press',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params): ArcadeEffect[] => {
    const round = params.rounds[roundOf(state, params.hooks)];
    if (round === undefined) return [];
    const [changeAt, changed] = round;
    const clock = clockOf(state, params.keeper);
    const shot = shotOf(state, params.keeper);
    if (shot !== null) return clock >= changeAt && shot === changed ? [{ kind: 'score', amount: SPOT.points }, { kind: 'win' }] : [{ kind: 'damage', amount: 1 }];
    return clock > changeAt + params.window ? [{ kind: 'lose' }] : [];
  },
};

// ---------------------------------------------------------------------------
// Robot

const botParams = z.object({ keeper: template, hooks: template, answers: z.array(z.tuple([z.int().min(1).max(ARCADE_LIMITS.maxTicks), sector])).min(1).max(ROUNDS.max) }).strict();
export type RailfpsSpotBotParams = z.infer<typeof botParams>;

/**
 * Robot zná sektor změny (`answers`) a ťukne tam, až ve svém (zpožděném) pohledu změnu vidí. Rány od pozorovaného
 * stavu dopočítá z vlastních stisků (`aimTick`); dokud rána letí nebo je natažená do sektoru změny, nemačká.
 */
export const railfpsSpotBot: BotPiece<RailfpsSpotBotParams> = {
  id: 'railfps_spot_bot',
  params: botParams,
  roles: ['player'],
  reactionTicks: RAILFPS.botReaction,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, recent }, params): ArcadeInput => {
    if (inBreak(state, params.hooks)) return NO_INPUT;
    const round = roundOf(state, params.hooks);
    const answer = params.answers[round];
    // Hned po přestávce drží hodiny ještě čas minulého kola – vynuluje je až první tik nového kola (`tickClock`).
    const fresh = state[bodyBase(params.keeper) + RIG.round] === round;
    if (answer === undefined || !fresh || clockOf(state, params.keeper) < answer[0]) return NO_INPUT;
    let aim = aimOf(state, params.keeper);
    for (const input of recent) {
      const { next, shot } = aimTick(aim, input);
      if (shot !== null) return NO_INPUT;
      aim = next;
    }
    if (aim.latch === 1 && aim.goal === sectorToStep(answer[1])) return NO_INPUT;
    return { buttons: BUTTON.FIRE, axis: sectorToAxis(answer[1]) };
  },
};

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z.object({ rounds: z.int().min(SPOT.rounds.min).max(SPOT.rounds.max).default(SPOT.rounds.default) }).strict();
export type RailfpsSpotParams = z.infer<typeof generatorParams>;

const SECTORS = Array.from({ length: YAW.sectors }, (_, index) => index - YAW.maxSector);
const STEP = 500;

/** Místnost: v každém sektoru `perSector` předmětů (tvar, řádek, barva, velikost a vzdálenost ze streamu). */
export function spotRoom(seed: number): SpotItem[] {
  const rng = createCompileRng(seed, 'layout');
  return SECTORS.flatMap((s) =>
    Array.from({ length: SPOT.perSector }, (_, n): SpotItem => [s, n, rng.int(0, SPOT.shapes - 1), rng.int(0, 2), rng.int(0, SPOT.colours - 1), rng.int(SPOT.size.min, SPOT.size.max), rng.int(SPOT.near / STEP, SPOT.far / STEP) * STEP]),
  );
}

/** Změny kol: každé kolo jiný sektor (zamíchané sektory), tik změny, předmět a druh ze streamu. */
export function spotChanges(seed: number, rounds: number, room: readonly SpotItem[]): SpotChange[] {
  const rng = createCompileRng(seed, 'spawn');
  const sectors = rng.shuffle(SECTORS);
  return Array.from({ length: rounds }, (_, k): SpotChange => {
    const s = sectors[k] as number;
    const kind = rng.int(0, 3);
    const at = rng.int(SPOT.changeFrom, SPOT.changeTo);
    if (kind === SPOT_CHANGE.extra) return [at, s, SPOT.perSector, kind, rng.int(0, SPOT.shapes - 1)];
    const n = rng.int(0, SPOT.perSector - 1);
    const was = room.find(([is, index]) => is === s && index === n) as SpotItem;
    if (kind === SPOT_CHANGE.colour) return [at, s, n, kind, (was[4] + rng.int(1, SPOT.colours - 1)) % SPOT.colours];
    if (kind === SPOT_CHANGE.size) return [at, s, n, kind, rng.int(0, 1) === 0 ? SPOT.size.grown : SPOT.size.shrunk];
    return [at, s, n, kind, 0];
  });
}

/** Tělesa: hráč a držák míření a hodin kola (stejné indexy jako střelnice). */
const spotBodies = () => railfpsBodies().slice(0, RAILFPS_BODIES.keeper + 1);

/** Režim `railfps.spot` (generátor `railfps_spot_room`): `rounds` kol, kolo končí výhrou pravidla. */
export const railfpsSpotRoom: ModeGeneratorPiece<RailfpsSpotParams> = {
  id: 'railfps_spot_room',
  params: generatorParams,
  roles: ['player'],
  cost: () => ({ bodies: RAILFPS_BODIES.keeper + 2, rules: 4 }),
  generate: () => ({ bodies: spotBodies(), length: 0 }),
  parts: (seed, params, health): ModeParts => {
    const level: ArcadeLevel = { bodies: spotBodies(), length: 0 };
    const room = spotRoom(seed);
    const rounds = spotChanges(seed, params.rounds, room);
    const { keeper } = RAILFPS_BODIES;
    // Počítadlo háčků přidá `withHooks` hned za tělesa úrovně.
    const hooks = level.bodies.length;
    const bot: PieceRef = { id: 'railfps_spot_bot', params: { keeper, hooks, answers: rounds.map(([at, s]) => [at, s]) } };
    const hooked = withHooks({ level, rules: [], bot }, seed, { rounds: params.rounds, clear: 'win' });
    return {
      control: { id: 'railfps_spot', params: { keeper, hooks } },
      bot: hooked.bot,
      level: hooked.level,
      rules: [{ id: 'railfps_spot', params: { keeper, hooks, window: SPOT.window, rounds, room } }, { id: 'out_of_health', params: {} }, ...hooked.rules],
      health: health ?? START_LIVES,
    };
  },
};

/** Kusy k registraci (P68-I): ovládání, pravidlo, generátor a robot. */
export const RAILFPS_SPOT_PIECES = {
  controls: { railfps_spot: railfpsSpotControl as ControlPiece },
  rules: { railfps_spot: railfpsSpot as RulePiece },
  generators: { railfps_spot_room: railfpsSpotRoom as ModeGeneratorPiece },
  bots: { railfps_spot_bot: railfpsSpotBot as BotPiece },
} as const;
