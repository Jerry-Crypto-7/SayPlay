/**
 * Žánr Aréna (P32E T4): kočka sbírá ryby a honí ji lední medvěd, dva rytíři se
 * utkají na hradě. Obě věty musí dojít přes `readGameSpec` k novým generátorům
 * režimů a robot je musí dohrát – ne k dnešnímu agaru nebo starému duelu, které
 * by „hrály“ taky, jen jinou hru, než věta slibuje.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, compileArcade, generatorOf } from '@/play/arcade/compile';
import { BODY, FLAG, HEADER, ROLE, bodyBase, bodyHp } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { ESCAPE } from '@/play/arcade/pieces/arena';
import { FIGHT } from '@/play/arcade/pieces/fight';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import { type GenreSpec, MODEL_CLASSES } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';

const CAT: GenreSpec = { genre: 'arena', mode: 'escape', hero: 'cat', cast: [{ label: 'polar bear', does: 'chase_me' }, { label: 'fish', does: 'collect' }], setting: 'frozen lake' };
const KNIGHTS: GenreSpec = { genre: 'arena', mode: 'fight', hero: 'knight', setting: 'castle' };

function read(spec: GenreSpec): GameSpecV1 {
  const result = readGameSpec(compileGenre(spec));
  if (!result.ok) throw new Error(`${result.reason}: ${result.issues.join('; ')}`);
  return result.value;
}

/** Těla světa podle role jádra. */
function bodiesOf(spec: GameSpecV1, seed = 1): { readonly roles: number[]; readonly hp: number[]; readonly alive: boolean[] } {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const state = instantiate(made.world);
  // Hra se `score_bonus` (P36A T5) má za tělesy úrovně ještě počítadlo komba – do souboje nepatří.
  const count = (state[HEADER.bodyCount] as number) - (made.world.rules.some((ref) => ref.id === 'score_bonus') ? 1 : 0);
  const roles: number[] = [];
  const hp: number[] = [];
  const alive: boolean[] = [];
  for (let i = 0; i < count; i += 1) {
    roles.push(state[bodyBase(i) + 10] as number);
    hp.push(bodyHp(state, i));
    alive.push(((state[bodyBase(i) + BODY.flags] as number) & FLAG.alive) !== 0);
  }
  return { roles, hp, alive };
}

/** Jen těla živá na startu (bez mrtvých předloh spawnů). */
function liveBodiesOf(spec: GameSpecV1): { readonly roles: number[]; readonly hp: number[] } {
  const { roles, hp, alive } = bodiesOf(spec);
  return { roles: roles.filter((_, i) => alive[i]), hp: hp.filter((_, i) => alive[i]) };
}

describe('arena genre – the cat and the polar bear', () => {
  it('compiles to arena_escape with the polar bear chasing and a win after N fish', () => {
    const spec = read(CAT);
    expect(generatorOf(spec)).toBe('arena_escape');
    expect(spec.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'chaser', label: 'polar bear' }),
        expect.objectContaining({ kind: 'collectible', label: 'fish', count: ESCAPE.items.collectDefault }),
      ]),
    );
    expect(spec.objective).toMatchObject({ kind: 'collect', count: ESCAPE.items.collectDefault });
    const { roles } = bodiesOf(spec);
    expect(roles.filter((role) => role === ROLE.chaser).length).toBeGreaterThanOrEqual(ESCAPE.chasers.default);
    expect(roles.filter((role) => role === ROLE.collectible).length).toBeGreaterThanOrEqual(ESCAPE.items.collectDefault);
  });

  it('the bot plays it to a win after collecting the fish', () => {
    const compiled = compileArcade(read(CAT), 1);
    expect(compiled.ok ? 'ok' : compiled.issues.join('; ')).toBe('ok');
  });

  it('without a collectible the escape is won by surviving the timer', () => {
    const spec = read({ ...CAT, cast: [{ label: 'polar bear', does: 'chase_me' }], params: { seconds: 30 } });
    expect(generatorOf(spec)).toBe('arena_escape');
    expect(spec.objective).toMatchObject({ kind: 'survive', seconds: 30 });
    const compiled = compileArcade(spec, 1);
    expect(compiled.ok ? compiled.value.winsAtTick : compiled.issues.join('; ')).toBe(30 * 60);
  });

  it('collect starts with nobody chasing and wins after N items', () => {
    const spec = read({ genre: 'arena', mode: 'collect', hero: 'little fish', cast: [{ label: 'plankton', does: 'collect' }], setting: 'coral reef', params: { items: 6 } });
    expect(generatorOf(spec)).toBe('arena_collect');
    // Od P36A T4 leží v úrovni mrtvá předloha pronásledovatele dalších vln; na startu nehoní nikdo.
    const { roles, alive } = bodiesOf(spec);
    expect(roles.filter((role, i) => role === ROLE.chaser && alive[i])).toEqual([]);
    expect(compileArcade(spec, 1).ok).toBe(true);
  });
});

describe('arena genre – two knights duel', () => {
  it('compiles to the fight mode with two knights: the hero and one rival knight, both with HP', () => {
    const spec = read(KNIGHTS);
    expect(generatorOf(spec)).toBe('fight');
    expect(spec.roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rival', label: 'knight', count: 1 })]));
    // Za tělesy na startu leží od P45C T12 mrtvé předlohy průběhu (nové chování, boss poslední vlny, počítadlo).
    const { roles, hp } = liveBodiesOf(spec);
    expect(roles).toEqual([ROLE.player, ROLE.enemy]);
    expect(hp).toEqual([FIGHT.playerHp.default, FIGHT.enemyHp.default]);
  });

  it('the bot knocks the rival out', () => {
    const compiled = compileArcade(read(KNIGHTS), 1);
    expect(compiled.ok ? 'ok' : compiled.issues.join('; ')).toBe('ok');
  });

  it('spec params reach the fight generator through tuning', () => {
    const spec = read({ ...KNIGHTS, cast: [{ label: 'black knight', does: 'fight' }], params: { enemies: 3, enemyHp: 2, playerHp: 7 } });
    const { roles, hp } = liveBodiesOf(spec);
    expect(roles.filter((role) => role === ROLE.enemy).length).toBe(3);
    expect(hp).toEqual([7, 2, 2, 2]);
    expect(compileArcade(spec, 1).ok).toBe(true);
  });
});

// P39 T7: lovec je věc, která hráče honí; bez ní ta, které se hráč vyhýbá – nikdy výchozí „hunter“, když věta něco jmenuje.
describe('arena genre reads the cast', () => {
  const roleOf = (spec: GameSpecV1, id: string) => spec.roles.find((role) => role.id === id)?.label;

  it('escape takes the thing that chases as the hunter, not the first thing named', () => {
    const spec = read({ ...CAT, cast: [{ label: 'shark', does: 'avoid' }, { label: 'fish', does: 'collect' }, { label: 'polar bear', does: 'chase_me' }] });
    expect(roleOf(spec, 'hunter')).toBe('polar bear');
    expect(roleOf(spec, 'item')).toBe('fish');
  });

  it('escape takes a thing to dodge as the hunter when nothing chases', () => {
    expect(roleOf(read({ ...CAT, cast: [{ label: 'fish', does: 'collect' }, { label: 'dog', does: 'avoid' }] }), 'hunter')).toBe('dog');
  });

  it('a hunter that patrols reaches the generator', () => {
    const spec = read({ ...CAT, cast: [{ label: 'guard', does: 'chase_me', patrol: true }, { label: 'fish', does: 'collect' }] });
    expect((spec.controlParams as { readonly tuning: { readonly patrol?: number } }).tuning.patrol).toBe(ESCAPE.patrolSight);
  });

  it('fight takes the thing it fights, collect the thing it collects', () => {
    expect(roleOf(read({ ...KNIGHTS, cast: [{ label: 'coin', does: 'collect' }, { label: 'troll', does: 'fight' }] }), 'rival')).toBe('troll');
    expect(roleOf(read({ genre: 'arena', mode: 'collect', hero: 'crab', cast: [{ label: 'gull', does: 'avoid' }, { label: 'shell', does: 'collect' }], setting: 'beach' }), 'item')).toBe('shell');
  });
});

describe('arena genre – module shape', () => {
  it('has the cues, the three ready modes and every hero class but boat and aircraft', () => {
    expect(GENRE_MODULES.arena.cues).toEqual(expect.arrayContaining(['chase', 'catch', 'escape', 'run from', 'collect', 'gather', 'fight', 'duel', 'battle', 'box']));
    for (const mode of ['escape', 'collect', 'fight'] as const) expect(GENRE_MODULES.arena.availability(mode)).toBe('ready');
    expect([...GENRE_MODULES.arena.heroClasses].sort()).toEqual(MODEL_CLASSES.filter((c) => c !== 'boat' && c !== 'aircraft').sort());
  });

  it('paramBounds refuse a value outside the generator bounds', () => {
    for (const [key, value] of [['chasers', 5], ['enemies', 4], ['enemyHp', 0], ['items', 31], ['seconds', 90]] as const) {
      const result = readGenreSpec({ ...KNIGHTS, params: { [key]: value } });
      expect(result.ok, `${key} ${value}`).toBe(false);
    }
  });

  it.each([
    ['A cat collects glowing fish on a frozen lake while a polar bear chases it', 'escape'],
    ['Two knights duel in a castle', 'fight'],
    ['A little fish gathers plankton on a coral reef', 'collect'],
  ] as const)('draftFill: "%s" → %s', (sentence, mode) => {
    expect(GENRE_MODULES.arena.draftFill(sentence, null)).toMatchObject({ genre: 'arena', mode });
  });
});
