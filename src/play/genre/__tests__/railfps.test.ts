/**
 * Modul žánru střelnice z očí (P68-F T4): ruční spec e2e je přesně to, co modul přeloží, jeho úroveň projde
 * `checkRailfpsLevel` a robot ji vyhraje; počty rolí sedí na to, co generátor opravdu postaví; 20 vět
 * (`evals/play/p68/prvni-osoba/sentences.json`) → `draftFill` + `compile` nese nepřítele i místo věty.
 *
 * Pin: modul, který větu přeloží, ale nepřítele z ní zahodí a dá výchozího mimozemšťana, vypadá jako fungující hra.
 * Test drží podíl vět (≥ 16 z 20), jejichž nepřítel je opravdu role `enemy` a místo opravdu `theme.setting`.
 * `RAILFPS_TABLE=<cesta>` zapíše výsledek po větách (JSON) pro README.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, compileArcade } from '@/play/arcade/compile';
import { ARCADE_LIMITS, type ArcadeWorld } from '@/play/arcade/contract';
import { assertGame, traceRun } from '@/play/arcade/gameplay-assert';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { RAILFPS, RAILFPS_BODIES, type RailfpsRoundParams, checkRailfpsLevel, railfpsRail } from '@/play/arcade/pieces/railfps';
import { runBot } from '@/play/arcade/verify';
import { compileWith } from '@/play/compose/compile';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import { type GenreModule, P68_GENRE_VERSION } from '../contract';
import { GENRE_MODULES, readGenreSpec } from '../index';
import { RAILFPS_DEFAULTS, railfpsGenre } from '../railfps';

const module = railfpsGenre as unknown as GenreModule;
/** Obsah ruční hry e2e: „Zap alien invaders in the space station hallway“, hrdina astronaut. */
const CONTENT = { genre: 'railfps', mode: 'default', hero: 'astronaut', setting: 'space station hallway', cast: [{ label: 'alien invader', does: 'shoot_at' }] } as const;
const FIXTURE = 'e2e/fixtures/p68-railfps-spec.json';
const SEEDS = [1, 2, 3] as const;
/** Místo, které žádná věta neříká: věta bez vlastního místa tak v testu místa neuspěje omylem. */
const NO_PLACE = 'unnamed place';

function specOf(content: object): GameSpecV1 {
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(module, read.value);
}

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Rozvrh vln, jak ho svět opravdu nese (pravidlo `railfps_round`). */
const wavesOf = (world: ArcadeWorld): RailfpsRoundParams['waves'] => (world.rules.find((ref) => ref.id === 'railfps_round')!.params as RailfpsRoundParams).waves;

const tuningOf = (spec: GameSpecV1): object => (spec.controlParams as { readonly tuning?: object } | undefined)?.tuning ?? {};

describe('railfps genre module (P68-F T4)', () => {
  it('is ready and is the registered module', () => {
    // P68-I T10 hru zapnul (`integration.md` → požadovaná změna `railfps.ts`: `availability` → `ready`).
    expect(railfpsGenre.availability('default')).toBe('ready');
    expect(GENRE_MODULES.railfps).toBe(railfpsGenre);
  });

  it('the e2e fixture is exactly what the module compiles, and a GameSpec reads it', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), FIXTURE), 'utf8')) as unknown;
    const spec = specOf(CONTENT);
    expect(fixture).toEqual(JSON.parse(JSON.stringify(spec)));
    const read = readGameSpec(fixture);
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(spec.genre).toEqual({ id: 'railfps', mode: 'default', compilerVersion: P68_GENRE_VERSION });
    expect(spec.controlParams).toEqual({ generator: 'railfps_rail' });
    expect(spec.targetDurationSec).toBeGreaterThanOrEqual(60);
    expect(spec.targetDurationSec).toBeLessThanOrEqual(75);
  });

  it.each(SEEDS)('the fixture level passes checkRailfpsLevel and the bot wins it (seed %i)', (seed) => {
    const read = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), FIXTURE), 'utf8')));
    if (!read.ok) throw new Error(read.issues.join('; '));
    const world = worldOf(read.value, seed);
    const parts = railfpsRail.parts(seed, railfpsRail.params.parse(tuningOf(read.value)), undefined);
    expect(parts.issues ?? []).toEqual([]);
    // Rozvrh světa = rozvrh generátoru a hratelný z konstrukce.
    expect(wavesOf(world)).toEqual((parts.rules.find((ref) => ref.id === 'railfps_round')!.params as RailfpsRoundParams).waves);
    expect(checkRailfpsLevel(parts.level, wavesOf(world))).toEqual([]);
    const bot = runBot(world, ARCADE_LIBRARY);
    expect(bot.outcome).toBe('won');
    expect(bot.tick).toBeLessThanOrEqual(ARCADE_LIMITS.maxTicks);
    // Publikační cesta: robot vyhraje, nečinný hráč ne.
    const published = compileArcade(read.value, seed);
    expect(published.ok, JSON.stringify(published.ok ? null : published.issues)).toBe(true);
  });

  it.each([
    ['default', {}],
    ['targets min', { targets: RAILFPS.targets.min }],
    ['targets max', { targets: RAILFPS.targets.max }],
    ['waves min', { waves: RAILFPS.waves.min }],
    ['waves max', { waves: RAILFPS.waves.max }],
  ])('role counts and the goal count are what the generator builds (%s)', (_, params) => {
    const spec = specOf({ ...CONTENT, params });
    const waves = wavesOf(worldOf(spec, 1)).flat();
    const foes = waves.filter(([, template]) => template !== RAILFPS_BODIES.target).length;
    expect(spec.roles.find((role) => role.id === 'enemy')?.count).toBe(foes);
    expect(spec.roles.find((role) => role.id === 'target')?.count).toBe(waves.length - foes);
    expect(spec.objective.count).toBe(waves.length);
    expect(spec.objective.description).toContain(String(waves.length));
  });

  it('a counted sentence sets how many things come, and a sentence without an enemy gets the default cast', () => {
    const counted = specOf({ ...CONTENT, counts: { enemy: 20 } });
    expect(tuningOf(counted)).toEqual({ targets: 20 });
    expect(counted.objective.count).toBe(20);
    const plain = specOf({ genre: 'railfps', mode: 'default', hero: 'astronaut', setting: 'space station hallway' });
    expect(plain.roles.find((role) => role.id === 'enemy')?.label).toBe(RAILFPS_DEFAULTS.enemy);
    expect(plain.roles.find((role) => role.id === 'target')?.label).toBe(RAILFPS_DEFAULTS.target);
  });
});

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly enemy: string;
  readonly setting: string;
}

describe('railfps: a slow hand loses (P68-K T1)', () => {
  const fixtureSpec = (): GameSpecV1 => {
    const read = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), FIXTURE), 'utf8')));
    if (!read.ok) throw new Error(read.issues.join('; '));
    return read.value;
  };
  const TEN = Array.from({ length: 10 }, (_, k) => k + 1);

  it('on the fixture the novice weak player of the gameplay gate loses >= 8 of 10 seeds and the default bot wins >= 9 of 10', () => {
    const rows = TEN.map((seed) => {
      const world = worldOf(fixtureSpec(), seed);
      return { seed, bot: runBot(world, ARCADE_LIBRARY).outcome, weak: traceRun(world, 'weak-bot').outcome };
    });
    expect(rows.filter((row) => row.bot === 'won').length, JSON.stringify(rows)).toBeGreaterThanOrEqual(9);
    expect(rows.filter((row) => row.weak === 'lost').length, JSON.stringify(rows)).toBeGreaterThanOrEqual(8);
  });

  it('the whole gameplay gate passes on the fixture: win, idle and weak losses, aims, hit-on-fire, idle-hurt', () => {
    const results = assertGame('railfps', worldOf(fixtureSpec(), 1));
    expect(results.map((entry) => entry.id)).toEqual(expect.arrayContaining(['bot-wins', 'idle-loses', 'weak-loses', 'aims', 'hit-on-fire', 'idle-hurt']));
    expect(results.filter((entry) => !entry.pass)).toEqual([]);
  });
});

describe('railfps sentences keep their enemy and place (P68-F T4)', () => {
  const { sentences } = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p68/prvni-osoba/sentences.json'), 'utf8')) as { readonly sentences: readonly Sentence[] };

  it('has 20 unique English sentences', () => {
    expect(sentences).toHaveLength(20);
    expect(new Set(sentences.map((item) => item.text.toLowerCase())).size).toBe(20);
    for (const item of sentences) expect(item.text, item.id).toMatch(/^[A-Za-z][A-Za-z ,'-]+$/);
  });

  it('draftFill + compile keep the enemy for at least 16 of 20 and the place for at least 16 of 20', () => {
    const rows = sentences.map((item) => {
      const fill = railfpsGenre.draftFill(item.text, null);
      const spec = specOf({ hero: 'astronaut', setting: NO_PLACE, ...fill });
      const enemy = spec.roles.find((role) => role.id === 'enemy')?.label ?? '';
      const setting = spec.theme.setting;
      return {
        id: item.id,
        text: item.text,
        wantEnemy: item.enemy,
        enemy,
        enemyHit: new RegExp(`\\b${item.enemy}\\b`).test(enemy),
        wantSetting: item.setting,
        setting,
        settingHit: setting.toLowerCase().includes(item.setting),
      };
    });
    const table = process.env.RAILFPS_TABLE;
    if (table !== undefined && table !== '') writeFileSync(table, `${JSON.stringify({ enemyHits: rows.filter((row) => row.enemyHit).length, settingHits: rows.filter((row) => row.settingHit).length, rows }, null, 1)}\n`);
    const enemyMisses = rows.filter((row) => !row.enemyHit).map((row) => `${row.id}: ${row.enemy}`);
    const settingMisses = rows.filter((row) => !row.settingHit).map((row) => `${row.id}: ${row.setting}`);
    expect(enemyMisses.length, enemyMisses.join('; ')).toBeLessThanOrEqual(4);
    expect(settingMisses.length, settingMisses.join('; ')).toBeLessThanOrEqual(4);
  });
});
