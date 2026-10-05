/**
 * Disk pod souborovým úložištěm her (P40 T3): stav paměťového úložiště
 * (`memoryVersionStore`) po klíčích, jeden soubor `<sha1 klíče>.json` na klíč.
 * Zapisuje se jen klíč, který se změnil – dohrání hry nepřepíše všechny hry.
 *
 * Jen pro běh bez Upstash mimo Vercel: tam je souborový systém jen pro čtení
 * a produkce jde přes Upstash (P30A). Lokální `next start` je taky
 * `NODE_ENV=production`, proto se nevolí podle `NODE_ENV`, ale podle toho,
 * jestli jde do adresáře psát (`fileStoreDirFromEnv` v `store.ts`).
 */

import { createHash } from 'node:crypto';
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Ranked {
  readonly rank: number;
  readonly at: number;
}

/** Totéž, co drží paměťové úložiště: hodnoty s expirací, seznamy a schodiště nejlepších. */
export interface MemoryState {
  readonly entries: Map<string, string>;
  readonly expiresAt: Map<string, number>;
  readonly lists: Map<string, string[]>;
  readonly sets: Map<string, Map<string, Ranked>>;
}

/** Jeden klíč na disku. */
interface Saved {
  readonly key: string;
  readonly value?: string;
  readonly list?: string[];
  readonly set?: [string, Ranked][];
  readonly expiresAt?: number;
}

export function emptyMemoryState(): MemoryState {
  return { entries: new Map(), expiresAt: new Map(), lists: new Map(), sets: new Map() };
}

function fileOf(dir: string, key: string): string {
  return join(dir, `${createHash('sha1').update(key).digest('hex')}.json`);
}

/** Položka schodiště `[člen, { rank, at }]` – jiný tvar by `new Map` shodil při startu. */
function isRankedEntry(item: unknown): boolean {
  if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string') return false;
  const ranked: unknown = item[1];
  if (typeof ranked !== 'object' || ranked === null) return false;
  const { rank, at } = ranked as Record<string, unknown>;
  return typeof rank === 'number' && typeof at === 'number';
}

function isSaved(value: unknown): value is Saved {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === 'string' &&
    (record.value === undefined || typeof record.value === 'string') &&
    (record.list === undefined || (Array.isArray(record.list) && record.list.every((item) => typeof item === 'string'))) &&
    (record.set === undefined || (Array.isArray(record.set) && record.set.every(isRankedEntry))) &&
    (record.expiresAt === undefined || typeof record.expiresAt === 'number')
  );
}

/** Adresář, do kterého jde psát (založí ho), jinak `false` – úložiště pak zůstane v paměti. */
export function writableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stav z adresáře. Nečitelný soubor (useknutý zápis, ruční úprava) se přeskočí
 * s varováním – rozbitá hra nesmí shodit start serveru, jen zmizí. Prošlé klíče
 * a zbytky dočasných souborů po pádu se smažou.
 */
export function loadMemoryState(dir: string, now: () => number): MemoryState {
  const state = emptyMemoryState();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith('.tmp')) {
      rmSync(path, { force: true });
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      record = null;
    }
    if (!isSaved(record)) {
      console.warn(`[play] store file ${name} is unreadable and was skipped`);
      continue;
    }
    if (record.expiresAt !== undefined && record.expiresAt <= now()) {
      rmSync(path, { force: true });
      continue;
    }
    if (record.value !== undefined) state.entries.set(record.key, record.value);
    if (record.list !== undefined) state.lists.set(record.key, record.list);
    if (record.set !== undefined) state.sets.set(record.key, new Map(record.set));
    if (record.expiresAt !== undefined) state.expiresAt.set(record.key, record.expiresAt);
  }
  return state;
}

/**
 * Zapíše jeden klíč atomicky: dočasný soubor a přejmenování, takže pád uprostřed
 * zápisu nechá starou verzi, ne useknutou. Klíč, který zmizel (vypršel), smaže.
 */
export function saveMemoryKey(dir: string, state: MemoryState, key: string): void {
  const value = state.entries.get(key);
  const list = state.lists.get(key);
  const set = state.sets.get(key);
  const path = fileOf(dir, key);
  if (value === undefined && list === undefined && set === undefined) {
    rmSync(path, { force: true });
    return;
  }
  const expiresAt = state.expiresAt.get(key);
  const record: Saved = {
    key,
    ...(value === undefined ? {} : { value }),
    ...(list === undefined ? {} : { list }),
    ...(set === undefined ? {} : { set: [...set] }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, path);
}
