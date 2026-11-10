/**
 * Kulisy uvnitř hrací plochy (P62 T4). Pinuje se, co z obrazu nikdo nepozná: kus, který stojí
 * na cestě robota nebo na místě, kde se objeví věc hry, vypadá ve snímku jako kulisa – hrdina
 * jím jen projde. Proto test hraje každou dotčenou hru robotem a nezávisle na stopě workeru
 * (`fieldJob`) hlídá každý tik: hrdinu, spawn každého kresleného těla a u střelnice i dráhy
 * nepřátel a terčů, s poloměrem půlky těla z `bodies.ts`.
 *
 * Kusy jsou jen vzhled: hash startu i běhu robota je týž jako na `main` (495bbc77), robot vyhraje,
 * nečinný hráč ne a přehrání sedí.
 *
 * P62 T4-R1: kusy naskočily 4–6 s po prvním snímku, protože worker začal až s montáží scény a hlavní
 * vlákno ho do konce prvního snímku nepustilo. Ze snímku v 5 s ani z testu rozmístění se to nepozná.
 * Pinuje se proto, že stránka o kusy požádá při hydrataci (`ArcadePlay` → `prefetchFieldDressing`)
 * právě u her se zdobenou plochou, a že kusy hotové před montáží stojí už v první montáži
 * `FieldDressing` – v témž rozmístění jako T4.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { type ReactElement, isValidElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { baseControlOf } from '@/play/arcade/addons';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { hashArcade, instantiate, loadProgram, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { floraIds, type Look, LOOK_IDS, LOOKS, isSceneryModel, landmarks, sceneLook } from '@/play/arcade/look';
import { SHOOTER } from '@/play/arcade/pieces/shooter';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot, verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft/draft';

import { bodiesOf, bodiesStale, drawsNothing } from '../../bodies';
import { FIELD_LEAST, FIELD_MOST, FIELD_TALLEST_M, type FieldPiece, START_CLEAR_M, fieldDressing, fieldPool } from '../field-dressing';
import { fieldPiecesNow, fieldPiecesOf, prefetchFieldDressing } from '../field-dressing-client';
import { type FieldWorkerRequest, type FieldWorkerResponse, fieldJob, handleFieldJob } from '../field-dressing-worker';
import { landmarkPicks } from '../landmark-places';
import { DECOR_TALLEST } from '../rig/terrain/arenaDecor';
import { FieldDressing } from '../Scenery';

// První montáž `FieldDressing` bez Reactu (vzor `shoot-throw.test.tsx`): stav z líné inicializace, efekty nic.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useRef: (current: unknown) => ({ current }),
    useMemo: (make: () => unknown) => make(),
  };
});

interface Row {
  readonly genre: string;
  readonly mode: string;
  readonly sentence: string;
  /** Hash startu a konce běhu robota na `main` c1dfd552 (P63 změnil jen první větu), semínko 1. */
  readonly main: { readonly init: string; readonly bot: string };
}

/** Každý arénový žánr a režim (útěk s věcmi i přežití, sběr, souboj, úkol v prostoru i u pultu) a střelnice. */
const ROWS: readonly Row[] = [
  { genre: 'arena', mode: 'escape', sentence: 'A knight must collect three keys in a haunted castle while dodging ghosts.', main: { init: '8d1ca4a7', bot: '4604184a' } },
  { genre: 'arena', mode: 'escape', sentence: 'survive the zombies in a mall', main: { init: '627c506d', bot: 'b69b4c20' } },
  { genre: 'arena', mode: 'collect', sentence: 'collect seashells on a sunny beach', main: { init: 'd41116a7', bot: 'c4546df6' } },
  { genre: 'arena', mode: 'fight', sentence: 'a knight fights goblins in a castle courtyard', main: { init: '4589e97e', bot: 'c09bee0d' } },
  { genre: 'quest', mode: 'spatial', sentence: 'a knight frees five prisoners in a dungeon guarded by skeletons', main: { init: 'c96ad93b', bot: 'f2d7dc96' } },
  { genre: 'quest', mode: 'station', sentence: 'a chef flips pancakes in a restaurant kitchen', main: { init: 'b55c7a8f', bot: '096075aa' } },
  { genre: 'shooter', mode: 'default', sentence: 'zombie shooter in a mall', main: { init: '315ef5e3', bot: '5610af6d' } },
];
const SEEDS = [1, 2, 3] as const;

interface Game {
  readonly world: ArcadeWorld;
  readonly look: Look;
  readonly pieces: readonly FieldPiece[];
}

const games = new Map<string, Game>();

function gameOf(row: Pick<Row, 'genre' | 'mode' | 'sentence'>, seed: number): Game {
  const key = `${row.sentence}#${String(seed)}`;
  const known = games.get(key);
  if (known !== undefined) return known;
  const { spec } = draftGameSpecWithMeta(row.sentence, 1);
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const look = sceneLook(spec.theme);
  const job = fieldJob(made.world);
  if (job === null) throw new Error(`${row.genre}/${row.mode}: no field job`);
  const game = { world: made.world, look, pieces: fieldDressing({ look, seed: made.world.seed, ...job }) };
  games.set(key, game);
  return game;
}

const shooter = (world: ArcadeWorld): boolean => baseControlOf(world.control).id === 'shooter';

/** Kus stojí celý v hrací ploše: čtverec arény, kužel míření střelnice do dostřelu. */
function inField(world: ArcadeWorld, piece: FieldPiece): boolean {
  if (shooter(world)) return piece.z > 0 && Math.abs(piece.x) + piece.reach <= piece.z * SHOOTER.tanMax && Math.hypot(piece.x, piece.z) + piece.reach <= SHOOTER.range / UNIT;
  const half = Number(baseControlOf(world.control).params.half) / UNIT;
  return Math.max(Math.abs(piece.x), Math.abs(piece.z)) + piece.reach <= half;
}

interface Touch {
  readonly tick: number;
  readonly what: string;
  readonly gap: number;
}

/**
 * Robot hraje znovu a každý tik se měří odstup kusů od toho, co se hraje: hrdina na cestě,
 * spawn (první živý tik) každého kresleného těla kromě střel a u střelnice všechno po celé
 * dráze – nepřítel, terč i rána z hlavně.
 */
function touches(world: ArcadeWorld, pieces: readonly FieldPiece[]): Touch[] {
  const bot = runBot(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const session = { world, state: () => state };
  let views = bodiesOf(session);
  const alive = new Set<number>();
  const found: Touch[] = [];
  const tracked = shooter(world);
  // Odstup půdorysu kusu od kvádru těla (AABB jádra, půlky z `bodies.ts`).
  const check = (tick: number, what: string, x: number, z: number, hx: number, hz: number): void => {
    for (const piece of pieces) {
      const gap = Math.hypot(Math.max(0, Math.abs(piece.x - x) - hx), Math.max(0, Math.abs(piece.z - z) - hz)) - piece.reach;
      if (gap < 0) found.push({ tick, what: `${what} ↔ ${piece.kind}`, gap });
    }
  };
  let next = 0;
  for (let tick = 0; ; tick += 1) {
    if (bodiesStale(views, session)) views = bodiesOf(session);
    for (const view of views) {
      const base = bodyBase(view.index);
      const live = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      if (!live) {
        alive.delete(view.index);
        continue;
      }
      if (drawsNothing(view) || (view.role === ROLE.projectile && !tracked)) continue;
      const x = -(state[base + BODY.x] as number) / UNIT;
      const z = (state[base + BODY.z] as number) / UNIT;
      const spawned = !alive.has(view.index);
      alive.add(view.index);
      if (view.role === ROLE.player) check(tick, 'hero', x, z, view.w / 2, view.d / 2);
      else if (spawned) check(tick, `spawn ${view.kind}`, x, z, view.w / 2, view.d / 2);
      else if (tracked) check(tick, `track ${view.kind}`, x, z, view.w / 2, view.d / 2);
    }
    if (state[HEADER.runState] !== 0 || tick > bot.tick) break;
    while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
    const event = bot.inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return found;
}

beforeAll(async () => {
  await loadRapier();
});

describe('P62 T4: the play area itself is dressed', () => {
  it.each(ROWS.map((row) => [`${row.genre}/${row.mode}`, row] as const))('%s: the sentence drafts that game', (_, row) => {
    const { genre } = draftGameSpecWithMeta(row.sentence, 1);
    expect(genre).toMatchObject({ genre: row.genre, mode: row.mode });
  });

  it.each(ROWS.map((row) => [`${row.genre}/${row.mode}`, row] as const))('%s: kit pieces inside the field (4–10 on the range), placed by the seed', (_, row) => {
    // P71E T3: kde hrdina chodí volně, smí jen kusy pod koleno – dnes žádný, 4–10 jich má jen střelnice.
    const least = shooter(gameOf(row, 1).world) ? FIELD_LEAST : 0;
    for (const seed of SEEDS) {
      const { world, look, pieces } = gameOf(row, seed);
      expect(pieces.length, `seed ${String(seed)}`).toBeGreaterThanOrEqual(least);
      expect(pieces.length, `seed ${String(seed)}`).toBeLessThanOrEqual(FIELD_MOST);
      const pool = new Set(fieldPool(look, world.seed).map((pooled) => pooled.kind));
      const hero = bodyBase(world.initial[HEADER.player] as number);
      const start = { x: -(world.initial[hero + BODY.x] as number) / UNIT, z: (world.initial[hero + BODY.z] as number) / UNIT };
      for (const piece of pieces) {
        expect(pool.has(piece.kind), `${piece.kind} is from the look's kit`).toBe(true);
        expect(inField(world, piece), `${piece.kind} at ${piece.x.toFixed(1)}, ${piece.z.toFixed(1)} stands in the field`).toBe(true);
        expect(piece.height).toBeLessThanOrEqual(FIELD_TALLEST_M);
        // První snímek ukazuje hrdinu, ne kulisu přilepenou k jeho kroužku.
        expect(Math.hypot(piece.x - start.x, piece.z - start.z) - piece.reach, `${piece.kind} clear of the hero's start`).toBeGreaterThanOrEqual(START_CLEAR_M);
      }
      // Tatáž hra = táž výzdoba: stopa i rozmístění spočítané znovu.
      const again = fieldJob(world)!;
      expect(fieldDressing({ look, seed: world.seed, ...again })).toEqual(pieces);
    }
    // Jiné semínko = jiné rozmístění (i úkol u pultu, jehož svět semínko nemění); volná aréna od P71E T3 kusy nemá.
    if (least === 0) return;
    const places = SEEDS.map((seed) => JSON.stringify(gameOf(row, seed).pieces.map((piece) => [piece.kind, piece.x.toFixed(2), piece.z.toFixed(2)])));
    expect(new Set(places).size).toBe(SEEDS.length);
  });

  it.each(ROWS.map((row) => [`${row.genre}/${row.mode}`, row] as const))('%s: no piece on the robot path, a spawn or a foe track', (_, row) => {
    for (const seed of SEEDS) {
      const { world, pieces } = gameOf(row, seed);
      const found = touches(world, pieces);
      expect(found.slice(0, 5), `seed ${String(seed)}: ${String(found.length)} touches`).toEqual([]);
    }
  });

  it.each(ROWS.map((row) => [`${row.genre}/${row.mode}`, row] as const))('%s: the game is main’s – same hashes, the robot wins, idle loses, replay matches', (_, row) => {
    for (const seed of SEEDS) {
      const { world } = gameOf(row, seed);
      const verdict = verifyArcade(world);
      if (seed === 1) {
        // P66: nová věta je `genre.v6` (háčky mění hru); otisk `main` drží táž věta uložená jako `genre.v5`.
        const { spec } = draftGameSpecWithMeta(row.sentence, 1);
        // P83A T2: věta s počtem dostala v ladění `near`; uložená hra z `main` ho nemá.
        const tuning = spec.controlParams?.tuning as Readonly<Record<string, unknown>> | undefined;
        const saved = tuning?.near === undefined ? spec : { ...spec, controlParams: { ...spec.controlParams, tuning: Object.fromEntries(Object.entries(tuning).filter(([key]) => key !== 'near')) } };
        const stored = arcadeWorldOf({ ...saved, genre: { ...spec.genre!, compilerVersion: 'genre.v5' } }, seed);
        if (!stored.ok) throw new Error(stored.issues.join('; '));
        expect(hashArcade(instantiate(stored.world)), 'start hash as on main').toBe(row.main.init);
        expect(verifyArcade(stored.world).bot.hash, 'robot run hash as on main').toBe(row.main.bot);
      }
      expect(verdict.bot.outcome, `seed ${String(seed)}`).toBe('won');
      expect(verdict.idle.outcome, `seed ${String(seed)}`).not.toBe('won');
      expect(verdict.replayEqual, `seed ${String(seed)}`).toBe(true);
    }
  });

  it('every look has kit pieces for the field, never the landmark the seed builds', () => {
    for (const id of LOOK_IDS) {
      const look = LOOKS[id];
      for (const seed of SEEDS) {
        const pool = fieldPool(look, seed);
        expect(pool.length, `${id} #${String(seed)}`).toBeGreaterThan(1);
        for (const pooled of pool) {
          // Model sady mimo vegetaci, nebo druh vegetace sady, který kreslí `PlantProp` v jejích barvách.
          if (pooled.plant) expect(look.flora !== undefined && floraIds(look.flora).has(pooled.kind), `${id}: ${pooled.kind}`).toBe(true);
          else expect(landmarks(look).includes(pooled.kind) && isSceneryModel(pooled.kind), `${id}: ${pooled.kind}`).toBe(true);
          expect(pooled.kind, `${id} #${String(seed)}`).not.toBe(landmarkPicks(look, seed).landmark);
        }
      }
    }
  });

  it('only arenas and the shooting range get a field', () => {
    expect(fieldJob(runnerWorld())).toBeNull();
  });
});

/** Věta z QA 5. 11. (P71E T3): sběr v aréně ve sklepení; semínko 71505 je snímek modelů P71E. */
const DUNGEON_QUEST = 'a wizard explores a dungeon to find the lost crown';

describe('P71E T3: no tall props where the hero roams free', () => {
  // Kus nemá tělo a hráč dojde po celé ploše: 1,5m kamennou zdí 5 m před startem čaroděj prošel (start volný byl už předtím).
  it.each([71505, 1])('the dungeon quest, seed %i: nothing on the floor above the hero’s knee', (seed) => {
    const { world, pieces } = gameOf({ genre: 'arena', mode: 'collect', sentence: DUNGEON_QUEST }, seed);
    expect(baseControlOf(world.control).id).toBe('move_free');
    const tall = pieces.filter((piece) => inField(world, piece) && piece.height > DECOR_TALLEST);
    expect(tall.map((piece) => `${piece.kind} ${piece.height.toFixed(2)} m at ${piece.x.toFixed(1)}, ${piece.z.toFixed(1)}`)).toEqual([]);
  });
});

function runnerWorld(): ArcadeWorld {
  const { spec } = draftGameSpecWithMeta('a hamster escaping a supermarket while a giant Roomba hunts me', 1);
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/**
 * Worker jako v prohlížeči: úlohu dostane ve jménu (`name`, JSON) nebo kopií zprávy (`structuredClone`),
 * spočte ji `handleFieldJob` a odpoví později.
 */
class FakeWorker {
  /** Úlohy v pořadí, jak je worker dostal; `named` = ty, které přišly ve jménu nového workeru. */
  static readonly posted: FieldWorkerRequest[] = [];
  static readonly named: FieldWorkerRequest[] = [];
  onmessage: ((event: { readonly data: FieldWorkerResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: URL, options?: { readonly name?: string }) {
    if (options?.name === undefined || options.name === '') return;
    const request = JSON.parse(options.name) as FieldWorkerRequest;
    FakeWorker.named.push(request);
    this.answer(request);
  }
  postMessage(request: FieldWorkerRequest): void {
    this.answer(structuredClone(request));
  }
  private answer(request: FieldWorkerRequest): void {
    FakeWorker.posted.push(request);
    void handleFieldJob(request).then((response) => this.onmessage?.({ data: response }));
  }
}

/** Kusy, které vrátí první montáž `FieldDressing` (skupina, dítě na kus). */
function mountedPieces(look: Look, world: ArcadeWorld): readonly ReactElement<{ position: readonly number[] }>[] {
  const group = FieldDressing({ look, world });
  if (!isValidElement<{ children: unknown }>(group)) throw new Error('FieldDressing renders a group');
  return (group.props.children as unknown[]).filter((child): child is ReactElement<{ position: readonly number[] }> => isValidElement(child));
}

describe('P62 T4-R1: the dressing is there on the first frames', () => {
  beforeAll(() => {
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it.each(ROWS.map((row) => [`${row.genre}/${row.mode}`, row] as const))('%s: asked for once before the scene mounts, it stands in the first mount, placed as in T4', async (_, row) => {
    const { world, look, pieces } = gameOf(row, 1);
    const before = FakeWorker.posted.length;
    expect(fieldPiecesNow(world, look), 'nothing before the page asks').toBeUndefined();
    // Bez hotového výpočtu první montáž nic nestaví (T4): kusy by naskočily až po workeru.
    prefetchFieldDressing(world, look);
    expect(FakeWorker.posted.length - before, 'the page itself started the job').toBe(1);
    expect(mountedPieces(look, world)).toEqual([]);
    prefetchFieldDressing(world, look);
    const found = await fieldPiecesOf(world, look);
    expect(FakeWorker.posted.length - before, 'one job per game, however often the page renders').toBe(1);
    // Táž místa jako T4: worker na kopii světa = `fieldJob` + `fieldDressing` nad originálem.
    expect(found).toEqual(pieces);
    expect(fieldPiecesNow(world, look)).toBe(found);
    // Scéna se montuje až po výpočtu: kusy jsou v jejím prvním renderu, žádný další dotaz na worker.
    const mounted = mountedPieces(look, world);
    expect(mounted.map((child) => child.props.position)).toEqual(pieces.map((piece) => [piece.x, 0, piece.z]));
    expect(FakeWorker.posted.length - before).toBe(1);
  });

  it('the first job rides in the new worker’s name, not in a message the busy main thread would forward', () => {
    expect(FakeWorker.named).toHaveLength(1);
    expect(FakeWorker.posted[0]).toBe(FakeWorker.named[0]);
    expect(FakeWorker.named[0]!.world).toEqual(gameOf(ROWS[0]!, 1).world);
  });

  it('a game without a dressed field never wakes the worker', () => {
    const world = runnerWorld();
    const before = FakeWorker.posted.length;
    prefetchFieldDressing(world, LOOKS.mall);
    expect(FakeWorker.posted.length).toBe(before);
  });

  it('the page asks while it renders, before it mounts the stage', () => {
    // Hydratace má mezery na start workeru, scéna od montáže do konce prvního snímku ne (27. 10.: 2–3 s).
    const source = readFileSync(path.join(__dirname, '../../ArcadePlay.tsx'), 'utf8');
    const asked = source.indexOf('prefetchFieldDressing(arcade, scene);');
    expect(asked).toBeGreaterThan(source.indexOf('const scene = useMemo(() => sceneLook(spec.theme)'));
    expect(asked).toBeLessThan(source.indexOf('<ArcadeStage'));
  });
});
