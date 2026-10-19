/**
 * Zmrazení P41 T3: co dnes dělá každý žánr, svět i robot, aby přestavba žánrů
 * na „recepty“ nemohla potichu změnit žádnou hru.
 *
 * Sdílený postup generátoru (`freeze.measure.ts` – zapíše tři JSON vedle sebe)
 * a testu (`../__tests__/golden.test.ts` – přepočítá všechno z dnešního kódu
 * a porovná). Postup sám není runtime: volá jen veřejné vstupy hry
 * (`compileGenre`, `readGameSpec`, `arcadeWorldOf`, `compileArcade`, `runBot`,
 * `scoredReplay`, souborové úložiště), takže změna kteréhokoli z nich se
 * v porovnání ukáže.
 *
 * Matice: 11 žánrů × každý režim × varianty (bez obsazení; jedna věc s každou
 * rolí `CAST_ROLES`; doplněk `ADDONS` dopsaný na přeložený spec; hloubka
 * `lives` / `targetScore` / `timeLimit`; všechny parametry modulu na mezi
 * min a max) × semínka 1–3.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { canonical, canonicalHash } from '@/ir/worlddoc';
import { arcadeWorldOf, compileArcade } from '@/play/arcade/compile';
import { ADDONS, type AddonId, type ArcadeWorld, type InputEvent } from '@/play/arcade/contract';
import { worldHasPhysics } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { readDirectorAnswer } from '@/play/director/read';
import { CAST_ROLES, GENRES, GENRE_MODES, type GenreId, type GenreSpec } from '@/play/genre/contract';
import { compileGenre, readGenreSpec } from '@/play/genre/index';
import frozenParameterBounds from './parameter-bounds.json';
import { scoredReplay } from '@/play/score/replay';
import { type GameSpecV1, readGameSpec } from '@/play/spec';
import { DEFAULT_WRITE_LIMITS, fileVersionStore } from '@/play/version/store';
import type { PublishedGame } from '@/play/version/version';
import { parseAnswerText } from '@/server/upstream';

export const SEEDS = [1, 2, 3] as const;

export const GOLDEN_DIR = join(process.cwd(), 'evals', 'play', 'p41', 'golden');
export const GOLDEN_FILES = {
  genres: join(GOLDEN_DIR, 'genres.json'),
  replays: join(GOLDEN_DIR, 'replays.json'),
  stored: join(GOLDEN_DIR, 'stored.json'),
} as const;

// ---------------------------------------------------------------------------
// Varianty

/** Pevná slova varianty: hrdina, prostředí a věc obsazení. */
const HERO = 'fox';
const SETTING = 'forest';
const THING = 'wolf';

/** Hloubka hry (`DEPTH_PARAM_BOUNDS`): hodnota uvnitř mezí, která hru opravdu změní. */
const DEPTH_VALUES = { lives: 5, targetScore: 50, timeLimit: 40 } as const;

export interface Variant {
  /** `žánr.režim/druh:detail`, např. `arena.escape/cast:chase_me`. */
  readonly id: string;
  readonly genre: GenreId;
  readonly mode: string;
  /** Vstup `readGenreSpec`. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Doplněk dopsaný na přeložený spec (`GenreSpec` doplňky nenese – jen obsazení `chase_me`/`shoot_at`). */
  readonly addon?: AddonId;
}

export function variants(): Variant[] {
  const out: Variant[] = [];
  for (const genre of GENRES) {
    // Zmrazené jsou žánry z doby zmrazení; nové žánry (P54C) hlídají vlastní brány, ne tahle sada.
    if (!Object.hasOwn(frozenParameterBounds, genre)) continue;
    for (const mode of GENRE_MODES[genre] as readonly string[]) {
      const at = `${genre}.${mode}`;
      const base = { genre, mode, hero: HERO, setting: SETTING };
      const add = (kind: string, input: Readonly<Record<string, unknown>>, addon?: AddonId): void => {
        out.push({ id: `${at}/${kind}`, genre, mode, input, ...(addon === undefined ? {} : { addon }) });
      };
      add('base', base);
      for (const does of CAST_ROLES) add(`cast:${does}`, { ...base, cast: [{ label: THING, does }] });
      for (const addon of ADDONS) add(`addon:${addon}`, base, addon);
      for (const [key, value] of Object.entries(DEPTH_VALUES)) add(`depth:${key}`, { ...base, params: { [key]: value } });
      // Inputs are frozen too. New optional parameters must not silently enter
      // the old min/max fixtures; worlds and expected replay hashes stay intact.
      const bounds = frozenParameterBounds[genre as keyof typeof frozenParameterBounds];
      if (Object.keys(bounds).length > 0) {
        add('params:min', { ...base, params: Object.fromEntries(Object.entries(bounds).map(([key, range]) => [key, range.min])) });
        add('params:max', { ...base, params: Object.fromEntries(Object.entries(bounds).map(([key, range]) => [key, range.max])) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Záznam varianty

type Rejection = { readonly ok: false; readonly reason?: string; readonly issues: readonly string[] };

export type WorldRecord = { readonly ok: true; readonly hash: string } | Rejection;
export type CompiledRecord = { readonly ok: true; readonly worldHash: string; readonly winsAtTick: number } | Rejection;

export interface VariantRecord {
  readonly id: string;
  readonly genreSpec: { readonly ok: true } | Rejection;
  /** Výstup `compileGenre` (u doplňku s dopsaným `addons`); chybí, když `readGenreSpec` odmítl. */
  readonly spec?: GameSpecV1;
  /** `compileGenre` vyhodil výjimku. */
  readonly thrown?: string;
  readonly read?: { readonly ok: true; readonly specHash: string } | Rejection;
  /** `arcadeWorldOf(read.value, seed)` – hash světa (`canonicalHash`) nebo důvod odmítnutí. */
  readonly worlds?: Readonly<Record<string, WorldRecord>>;
  /** `compileArcade(read.value, seed)` – brána publikace (ořez cílového skóre, robot, nečinný hráč). */
  readonly compiled?: Readonly<Record<string, CompiledRecord>>;
}

/** Svět varianty pro semínko, z téhož spec jako `worlds` (přehrání běží nad ním). */
export interface VariantRun {
  readonly record: VariantRecord;
  readonly worlds: ReadonlyMap<number, ArcadeWorld>;
}

const rejection = (issues: readonly string[], reason?: string): Rejection => ({ ok: false, ...(reason === undefined ? {} : { reason }), issues: [...issues] });

/**
 * Výjimka dnešního kódu je taky výsledek, který se zmrazuje (`reason: 'THROWN'`):
 * doplněk na hře s generátorem režimu (souboj Arény) dnes padá v jádře
 * („unknown control fight“) – přestavba to smí opravit jen vědomě.
 */
export function guarded<T>(run: () => T): T | Rejection {
  try {
    return run();
  } catch (thrown) {
    return rejection([thrown instanceof Error ? thrown.message : String(thrown)], 'THROWN');
  }
}

function withAddon(spec: GameSpecV1, addon: AddonId): GameSpecV1 {
  return { ...spec, addons: [...new Set([...(spec.addons ?? []), addon])] };
}

/** Celý záznam varianty z dnešního kódu; brána publikace (robot, nejdražší část) jen pro `compiledSeeds`. */
export function runVariant(variant: Variant, options: { readonly compiledSeeds: readonly number[] }): VariantRun {
  const worlds = new Map<number, ArcadeWorld>();
  const genre = readGenreSpec(variant.input);
  if (!genre.ok) return { record: { id: variant.id, genreSpec: rejection(genre.issues) }, worlds };
  let spec: GameSpecV1;
  try {
    spec = compileGenre(genre.value as GenreSpec);
  } catch (thrown) {
    return { record: { id: variant.id, genreSpec: { ok: true }, thrown: String(thrown) }, worlds };
  }
  if (variant.addon !== undefined) spec = withAddon(spec, variant.addon);
  const read = readGameSpec(spec);
  if (!read.ok) return { record: { id: variant.id, genreSpec: { ok: true }, spec, read: rejection(read.issues, read.reason) }, worlds };
  const worldRecords: Record<string, WorldRecord> = {};
  const compiled: Record<string, CompiledRecord> = {};
  for (const seed of SEEDS) {
    worldRecords[String(seed)] = guarded((): WorldRecord => {
      const made = arcadeWorldOf(read.value, seed);
      if (made.ok) worlds.set(seed, made.world);
      return made.ok ? { ok: true, hash: canonicalHash(made.world) } : rejection(made.issues);
    });
    if (!options.compiledSeeds.includes(seed)) continue;
    compiled[String(seed)] = guarded((): CompiledRecord => {
      const gate = compileArcade(read.value, seed);
      return gate.ok ? { ok: true, worldHash: gate.value.worldHash, winsAtTick: gate.value.winsAtTick ?? -1 } : rejection(gate.issues, gate.reason);
    });
  }
  return {
    record: {
      id: variant.id,
      genreSpec: { ok: true },
      spec,
      read: { ok: true, specHash: read.specHash },
      worlds: worldRecords,
      ...(options.compiledSeeds.length > 0 ? { compiled } : {}),
    },
    worlds,
  };
}

// ---------------------------------------------------------------------------
// Přehrání

/**
 * Záznam vstupu robota: běhy souvislých tiků se stejným vstupem jako čtveřice
 * `[mezera od konce minulého běhu, délka, tlačítka, změna osy]` (zigzag
 * varint), celé `deflateRaw` a base64. Analogová osa (plavba, aréna) se mění
 * skoro každý tik, takže čísla v JSON by vážila ~3 MB; takhle ~0,35 MB.
 * Tiky bez vstupu robot nezapisuje (`runBot`), záznam je tedy přesný.
 */
export function encodeInputs(inputs: readonly InputEvent[]): string {
  const runs: [number, number, number, number][] = [];
  for (const event of inputs) {
    const last = runs.at(-1);
    if (last !== undefined && last[0] + last[1] === event.tick && last[2] === event.buttons && last[3] === event.axis) last[1] += 1;
    else runs.push([event.tick, 1, event.buttons, event.axis]);
  }
  const bytes: number[] = [];
  const push = (value: number): void => {
    let rest = value;
    while (rest >= 0x80) {
      bytes.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
  };
  let end = 0;
  let axis = 0;
  for (const [tick, length, buttons, value] of runs) {
    push(tick - end);
    push(length);
    push(buttons);
    const delta = value - axis;
    push(delta >= 0 ? delta * 2 : -delta * 2 - 1);
    end = tick + length;
    axis = value;
  }
  return deflateRawSync(Buffer.from(bytes), { level: 9 }).toString('base64');
}

export function decodeInputs(packed: string): InputEvent[] {
  const bytes = inflateRawSync(Buffer.from(packed, 'base64'));
  let at = 0;
  const next = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = bytes[at++] as number;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
  };
  const inputs: InputEvent[] = [];
  let end = 0;
  let axis = 0;
  while (at < bytes.length) {
    const tick = end + next();
    const length = next();
    const buttons = next();
    const zigzag = next();
    axis += zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
    for (let offset = 0; offset < length; offset += 1) inputs.push({ tick: tick + offset, buttons, axis });
    end = tick + length;
  }
  return inputs;
}

export interface ReplayOutcome {
  readonly outcome: string;
  readonly tick: number;
  readonly score: number;
  readonly lives: number;
  readonly hash: string;
}

export interface ReplayRecord extends ReplayOutcome {
  /** Vstup robota (`encodeInputs`). */
  readonly inputs: string;
}

export function replayOutcome(world: ArcadeWorld, inputs: readonly InputEvent[]): ReplayOutcome {
  const run = scoredReplay(world, inputs, []);
  return { outcome: run.outcome, tick: run.tick, score: run.score, lives: run.lives, hash: run.hash };
}

/** Robot odehraje svět; jeho záznam se přehraje cestou výzvy (`scoredReplay`) a musí skončit stejně jako robot. */
export function botReplay(world: ArcadeWorld, label: string): ReplayRecord {
  const bot = runBot(world);
  const runs = encodeInputs(bot.inputs);
  if (canonical(decodeInputs(runs)) !== canonical(bot.inputs)) throw new Error(`${label}: run-length input record does not round-trip`);
  const replayed = replayOutcome(world, bot.inputs);
  if (replayed.outcome !== bot.outcome || replayed.tick !== bot.tick || replayed.hash !== bot.hash) {
    throw new Error(`${label}: scoredReplay ${replayed.outcome}@${replayed.tick} ${replayed.hash} ≠ bot ${bot.outcome}@${bot.tick} ${bot.hash}`);
  }
  return { inputs: runs, ...replayed };
}

export const replayKey = (variantId: string, seed: number | string): string => `${variantId}#${String(seed)}`;

// ---------------------------------------------------------------------------
// Uložené hry (`data/play/store`, souborové úložiště P40)

export const STORE_DIR = join(process.cwd(), 'data', 'play', 'store');
const VERSION_KEY = /^file:play:v:([a-f0-9]{32})$/;

/** Soubor úložiště, jak leží na disku (`file-store.ts`, `Saved`). */
export interface SavedRecord {
  readonly key: string;
  readonly value?: string;
  readonly list?: readonly string[];
  readonly expiresAt?: number;
}

export interface StoredGame {
  /** Jméno souboru v úložišti (`<sha1 klíče>.json`). */
  readonly file: string;
  readonly versionId: string;
  readonly record: SavedRecord;
  /** Obálka hry, jak ji vrátí `fileVersionStore(...).get`. */
  readonly game: PublishedGame;
  readonly derived: StoredDerived;
}

export interface StoredDerived {
  readonly read: { readonly ok: true; readonly specHash: string } | Rejection;
  /** `canonicalHash(game.arcade)` – hra se hraje z uloženého světa. */
  readonly arcadeHash: string;
  readonly arcadeHashMatchesVersion: boolean;
  /** Přeložení uloženého specu znovu (`compileArcade(spec, version.seed)`). */
  readonly recompiled: CompiledRecord;
  readonly physics: boolean;
  readonly replay: ReplayRecord;
}

/** Hry z uložených záznamů (`:play:v:`) přečtené souborovým úložištěm v dočasné kopii – originál se nemění. */
export async function decodeStored(records: readonly { readonly file: string; readonly record: SavedRecord }[]): Promise<Map<string, PublishedGame | null>> {
  const dir = mkdtempSync(join(tmpdir(), 'p41-golden-store-'));
  try {
    for (const { file, record } of records) writeFileSync(join(dir, file), JSON.stringify(record));
    // `now` = 0: nic nevyprší, takže načtení nic nesmaže.
    const store = fileVersionStore(dir, DEFAULT_WRITE_LIMITS, () => 0);
    const games = new Map<string, PublishedGame | null>();
    for (const { record } of records) {
      const versionId = VERSION_KEY.exec(record.key)?.[1];
      if (versionId !== undefined) games.set(versionId, await store.get(versionId));
    }
    return games;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Záznamy her z `data/play/store` (zkopírované do dočasného adresáře, ať úložiště nic nepromaže). */
export function readStoreRecords(): { readonly file: string; readonly record: SavedRecord }[] {
  const dir = mkdtempSync(join(tmpdir(), 'p41-golden-copy-'));
  try {
    return readdirSync(STORE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .flatMap((name) => {
        copyFileSync(join(STORE_DIR, name), join(dir, name));
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SavedRecord;
        return VERSION_KEY.test(record.key) ? [{ file: name, record }] : [];
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Odvozené hodnoty uložené hry z dnešního kódu; `inputs` = zmrazený záznam (test), jinak hraje robot (generátor). */
export async function deriveStored(game: PublishedGame, label: string, inputs?: readonly InputEvent[]): Promise<StoredDerived> {
  if (game.arcade === undefined) throw new Error(`${label}: stored game has no arcade world`);
  const physics = worldHasPhysics(game.arcade);
  if (physics) await loadRapier();
  const read = readGameSpec(game.spec);
  const gate = read.ok ? compileArcade(read.value, game.version.seed) : null;
  const recompiled: CompiledRecord =
    gate === null ? rejection(['spec rejected']) : gate.ok ? { ok: true, worldHash: gate.value.worldHash, winsAtTick: gate.value.winsAtTick ?? -1 } : rejection(gate.issues, gate.reason);
  const arcadeHash = canonicalHash(game.arcade);
  return {
    read: read.ok ? { ok: true, specHash: read.specHash } : rejection(read.issues, read.reason),
    arcadeHash,
    arcadeHashMatchesVersion: arcadeHash === game.version.worldHash,
    recompiled,
    physics,
    replay: inputs === undefined ? botReplay(game.arcade, label) : { inputs: encodeInputs(inputs), ...replayOutcome(game.arcade, inputs) },
  };
}

/**
 * Co do veřejného repa nepatří: absolutní cesta k uživatelskému adresáři,
 * e-mail, jména lidí z týmu. Záznam, který něco z toho nese, generátor zahodí.
 * Jména se čtou z gitignorovaného `blind-check.config.json` (`identityTokens`),
 * stejně jako v `scripts/blind-check.mjs` – veřejný soubor je nesmí nést sám.
 */
export const PRIVATE_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:[\\/]+Users[\\/]/i,
  /\/(?:Users|home)\/[^/\s"]+/,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  ...identityPatterns(),
];

function identityPatterns(): RegExp[] {
  const path = join(process.cwd(), 'blind-check.config.json');
  if (!existsSync(path)) return [];
  const tokens: unknown = JSON.parse(readFileSync(path, 'utf8')).identityTokens;
  if (!Array.isArray(tokens)) return [];
  return tokens
    .filter((token): token is string => typeof token === 'string' && token.length > 0)
    .map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

// ---------------------------------------------------------------------------
// Fixtury, které musí zůstat odmítnuté

export interface MustReject {
  /** Cesta od kořene repa. */
  readonly file: string;
  readonly reader: 'readGameSpec' | 'readDirectorAnswer' | 'parseAnswerText';
  readonly reason: string;
  readonly issues: readonly string[];
}

export function mustRejectFiles(): string[] {
  const play = join('src', 'play', '__fixtures__');
  const answers = join('src', 'play', 'director', '__fixtures__', 'answers');
  return [
    ...readdirSync(join(process.cwd(), play)).filter((name) => name.startsWith('invalid-')).map((name) => join(play, name)),
    ...readdirSync(join(process.cwd(), answers)).filter((name) => name.startsWith('bad-')).map((name) => join(answers, name)),
  ]
    .map((path) => path.replace(/\\/g, '/'))
    .sort();
}

/** Verdikt dnešního kódu nad fixturou; `ok: true` = fixturu už nikdo neodmítá. */
export function rejectVerdict(file: string): { readonly ok: true } | MustReject {
  const text = readFileSync(join(process.cwd(), file), 'utf8');
  if (file.endsWith('.txt')) {
    try {
      parseAnswerText(text);
      return { ok: true };
    } catch {
      return { file, reader: 'parseAnswerText', reason: 'THROWS', issues: [] };
    }
  }
  const body = JSON.parse(text) as unknown;
  if (file.includes('/director/')) {
    const read = readDirectorAnswer(body);
    return read.ok ? { ok: true } : { file, reader: 'readDirectorAnswer', reason: read.reason, issues: [read.detail] };
  }
  const read = readGameSpec(body);
  return read.ok ? { ok: true } : { file, reader: 'readGameSpec', reason: read.reason, issues: [...read.issues] };
}

// ---------------------------------------------------------------------------
// JSON: stabilní pořadí klíčů, jedna položka na řádek

/** Objekt s klíči nejvyšší úrovně; pole a mapy pod nimi po řádcích, každá položka kanonicky. */
export function stableJson(top: Readonly<Record<string, unknown>>): string {
  const lines = Object.keys(top)
    .sort()
    .map((key) => {
      const value = top[key];
      if (Array.isArray(value)) return `${JSON.stringify(key)}: [\n${value.map((item) => `  ${canonical(item)}`).join(',\n')}\n]`;
      if (typeof value === 'object' && value !== null) {
        const entries = Object.keys(value)
          .sort()
          .map((inner) => `  ${JSON.stringify(inner)}: ${canonical((value as Record<string, unknown>)[inner])}`);
        return `${JSON.stringify(key)}: {\n${entries.join(',\n')}\n}`;
      }
      return `${JSON.stringify(key)}: ${canonical(value)}`;
    });
  return `{\n${lines.join(',\n')}\n}\n`;
}
