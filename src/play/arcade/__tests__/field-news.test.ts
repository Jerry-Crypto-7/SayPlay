/**
 * Oznámení úseků pole a finále `genre.v4` (P47A T10). Nápis, který přijde o vteřinu dřív než boss, vypadá správně
 * a lže – pin proto hraje vyhrané běhy robota intermediate (6 žánrů, 2 semínka), tik po tiku vede banner
 * (`createPacingBannerWatch`) a vedle něj čte svět vlastním čtením, ne rozvrhem: první živé tělo předlohy
 * nepřítele, kterou plocha ještě neměla, živý boss, soupeř duelu s rozměry šampiona, živý terč-boss hodu, kolo,
 * od kterého `interact` opravdu zkrátí úkol (`interactAt`), první živá mince deště přežití. Každý nápis musí
 * začít přesně v tiku své změny ve světě a každá taková změna úseku 2/3 a finále musí mít svůj nápis. Boss pole,
 * šampion a terč-boss mají v tom tiku pipy HP (kresba `PacingFx`). Uložené `genre.v3` hry hlásí jako dřív.
 */

import { Quaternion } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { pacingBannerLabel, createPacingBannerWatch } from '@/components/play/arcade/PacingBanner';
import { SPARK_KIND } from '@/components/play/arcade/bodies';
import { pacingBossOf, pacingRefsOf } from '@/components/play/arcade/effects/bus';
import { createPacingDrawing } from '@/components/play/arcade/effects/PacingFx';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf, preloadPhysics } from '../compile';
import { type ArcadeState, type ArcadeWorld, BODY, FLAG, HEADER, ROLE, bodyBase, bodyHp, nativeRule } from '../contract';
import { instantiate } from '../kernel';
import { loadRapier } from '../physics/world';
import { play } from '../pieces/behaviours/__tests__/harness';
import { DUEL_FOE } from '../pieces/duel';
import { type PacingBeat, type PacingRuleParams, bossKindOf, finaleBossesOf, pacingBeatOrderOf, segmentNewsOf } from '../pieces/pacing';
import { HEARTBEAT_SPARK } from '../pieces/pacing-parts';
import { type CompiledInteract, interactAt } from '../rules/interact';
import { runBot } from '../verify';

/** Buňky šesti žánrů P47A (útěk dvakrát: přežití a útěk s věcmi) a finále, které musí ohlásit. */
const CELLS: readonly { readonly id: string; readonly finale: PacingBeat; readonly segments: readonly PacingBeat[] }[] = [
  { id: 'arena.collect', finale: 'boss', segments: ['segment2', 'segment3'] },
  { id: 'arena.escape+collect', finale: 'boss', segments: ['segment2', 'segment3'] },
  // Přežití má jedno chování (T8), quest úsek 3 = kolo bosse: nového nepřítele nese jen úsek 2.
  { id: 'arena.escape', finale: 'shower', segments: ['segment2'] },
  { id: 'quest.spatial', finale: 'boss', segments: ['segment2'] },
  { id: 'quest.station', finale: 'rush', segments: [] },
  { id: 'duel.default', finale: 'champion', segments: [] },
  { id: 'throw.default', finale: 'bossTarget', segments: [] },
];

const FINALE_TEXT: Readonly<Record<string, string>> = { champion: 'Champion!', bossTarget: 'Boss target!', rush: 'Rush order!', shower: 'Grab the bonus!', boss: 'Boss: Frog' };

const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));
const storedV3 = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v3' } });
const worldOf = (spec: GameSpecV1, seed: number): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const pacingOf = (world: ArcadeWorld): PacingRuleParams => nativeRule(world.rules, 'pacing')!.params as PacingRuleParams;
const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const SIGNATURE = [BODY.role, BODY.kind, BODY.w, BODY.h, BODY.d] as const;

/** Živá tělo od slotu spawnu se stejnou rolí, modelem a rozměry jako předloha (čteno ze stavu, ne rámcem chování). */
function liveCopies(state: ArcadeState, template: number): number {
  let count = 0;
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (alive(state, body) && SIGNATURE.every((slot) => state[bodyBase(body) + slot] === state[bodyBase(template) + slot])) count += 1;
  }
  return count;
}

/** Tik, kdy ve světě nastane změna, kterou má finále buňky ohlásit (podmínka v tiku, poprvé). */
function finaleChange(world: ArcadeWorld, finale: PacingBeat): (state: ArcadeState) => boolean {
  const rule = pacingOf(world);
  if (finale === 'boss') {
    const template = rule.behaviours!.at(-1)!.template;
    return (state) => liveCopies(state, template) > 0;
  }
  if (finale === 'shower') {
    const template = rule.schedule.find((entry) => !(rule.behaviours ?? []).some((ref) => ref.template === entry.template))!.template;
    return (state) => liveCopies(state, template) > 0;
  }
  if (finale === 'champion') {
    const start = instantiate(world);
    return (state) => (state[bodyBase(DUEL_FOE) + BODY.w] as number) > (start[bodyBase(DUEL_FOE) + BODY.w] as number);
  }
  if (finale === 'bossTarget') {
    const boss = world.kinds.indexOf('boss');
    return (state) => {
      for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) if (alive(state, body) && state[bodyBase(body) + BODY.role] === ROLE.enemy && state[bodyBase(body) + BODY.kind] === boss) return true;
      return false;
    };
  }
  // Spěch: `interact` od teď drží kratší úkol, než svět staví.
  const compiled = (nativeRule(world.rules, 'interact')!.params.when as { interact: CompiledInteract }).interact;
  return (state) => interactAt(compiled, state).hold < compiled.hold;
}

interface Run {
  readonly won: boolean;
  /** Souvislé úseky banneru `[chvíle, první tik]`. */
  readonly shown: readonly (readonly [PacingBeat, number])[];
  /** První tik každé předlohy nepřítele (ne bosse) na ploše. */
  readonly arrivals: readonly number[];
  readonly finaleAt: number;
  /** Pipy HP, které kresba ukazuje v tiku finále: `[tělo, HP, nejvýš]`. */
  readonly pips: readonly (readonly [number, number, number])[];
  readonly bossHp: number;
}

const FACING = new Quaternion();

function runOf(world: ArcadeWorld, finale: PacingBeat): Run {
  const rule = pacingOf(world);
  const watch = createPacingBannerWatch(world);
  const change = finaleChange(world, finale);
  const bossTemplate = finale === 'boss' ? rule.behaviours!.at(-1)!.template : -1;
  const foes = (rule.behaviours ?? []).filter((ref) => ref.template !== bossTemplate).map((ref) => ref.template);
  const seen = new Set<number>();
  const arrivals: number[] = [];
  const refs = pacingRefsOf(world.rules);
  const bosses = finaleBossesOf(world);
  const drawing = refs.length === 0 && bosses === null ? null : createPacingDrawing(refs, pacingBossOf(world.rules), null, bosses);
  const shown: [PacingBeat, number][] = [];
  let last: PacingBeat | null = null;
  let finaleAt = -1;
  let pips: (readonly [number, number, number])[] = [];
  let bossHp = -1;
  const end = play(world, runBot(world, undefined, { profile: 'intermediate' }).inputs, (state, tick) => {
    const beat = watch.see(state);
    if (beat !== null && beat !== last) shown.push([beat, tick]);
    last = beat;
    for (const template of foes) {
      if (seen.has(template) || liveCopies(state, template) === 0) continue;
      seen.add(template);
      arrivals.push(tick);
    }
    const drawn = drawing?.update({ state, prev: state, alpha: 0, now: 0, facing: FACING, reduced: false });
    if (finaleAt < 0 && change(state)) {
      finaleAt = tick;
      pips = (drawn?.bosses ?? []).map((entry) => [entry.body, entry.hp, entry.max] as const);
      const body = finale === 'champion' ? DUEL_FOE : pips[0]?.[0];
      bossHp = body === undefined ? -1 : bodyHp(state, body);
    }
  });
  drawing?.dispose();
  return { won: end[HEADER.runState] === 1, shown, arrivals, finaleAt, pips, bossHp };
}

/** První dvě semínka 1–8, na kterých robot intermediate vyhraje (finále přijde jen ve hře, která k němu dojde). */
function wonRuns(id: string, finale: PacingBeat): { readonly seed: number; readonly world: ArcadeWorld; readonly run: Run }[] {
  const spec = cellSpec(id);
  const out: { seed: number; world: ArcadeWorld; run: Run }[] = [];
  for (let seed = 1; seed <= 8 && out.length < 2; seed += 1) {
    const world = worldOf(spec, seed);
    const run = runOf(world, finale);
    if (run.won) out.push({ seed, world, run });
  }
  return out;
}

beforeAll(async () => {
  await loadRapier();
  for (const cell of CELLS) await preloadPhysics(cellSpec(cell.id), loadRapier);
});

describe('field segments and genre.v4 finales are announced in the tick the world changes', () => {
  for (const cell of CELLS) {
    it(`${cell.id}: ${[...cell.segments, cell.finale].join(', ')} – each banner starts with its change in the world, the finale boss has HP pips`, () => {
      const runs = wonRuns(cell.id, cell.finale);
      expect(runs, `${cell.id}: two won seeds out of 1–8`).toHaveLength(2);
      for (const { seed, world, run } of runs) {
        const where = `${cell.id} seed ${seed}`;
        const news = segmentNewsOf(world);
        expect(news.map((item) => item.beat), `${where}: segment news`).toEqual(cell.segments);
        expect(news.every((item) => item.news === 'newFoe'), where).toBe(true);
        // Každá chvíle jednou, v pořadí, ve kterém je svět má; finále i úseky opravdu přišly.
        expect(new Set(run.shown.map(([beat]) => beat)).size, `${where}: once each`).toBe(run.shown.length);
        expect(run.shown.map(([beat]) => beat).sort(), `${where}: shown`).toEqual([...cell.segments, cell.finale].sort());
        const order = pacingBeatOrderOf(world);
        expect(run.shown.map(([beat]) => order.indexOf(beat)), `${where}: order`).toEqual([...run.shown.map(([beat]) => order.indexOf(beat))].sort((a, b) => a - b));
        for (const [beat, from] of run.shown) {
          const label = pacingBannerLabel(world, beat, 'frog');
          const at = `${where}: “${label}” (${beat}) at tick ${from}`;
          if (beat === 'segment2' || beat === 'segment3') {
            // Nový nepřítel: první tělo předlohy, kterou plocha ještě neměla, přišlo právě v tomhle tiku.
            expect(label, at).toBe('New foe: Frog');
            expect(run.arrivals, at).toContain(from);
          } else {
            expect(beat, at).toBe(cell.finale);
            expect(label, at).toBe(FINALE_TEXT[beat]);
            expect(from, `${at}: the world changed at tick ${run.finaleAt}`).toBe(run.finaleAt);
          }
        }
        // Úsek 2 a 3 pole: nápis má každý nový nepřítel, který přišel po úvodu a ne v tiku bosse.
        const announced = run.shown.filter(([beat]) => beat === 'segment2' || beat === 'segment3').map(([, from]) => from);
        expect(announced, `${where}: arrivals ${run.arrivals.join(' ')}`).toEqual(run.arrivals.filter((tick) => tick !== run.finaleAt).slice(0, cell.segments.length));
        // Pipy HP bosse finále (ne spěchu a deště): v tiku příchodu plné, jeden na život.
        if (cell.finale !== 'rush' && cell.finale !== 'shower') {
          expect(run.pips.length, `${where}: HP pips`).toBe(1);
          const [, hp, max] = run.pips[0]!;
          expect([hp, max], `${where}: HP pips`).toEqual([run.bossHp, run.bossHp]);
          expect(run.bossHp).toBeGreaterThanOrEqual(3);
        }
      }
    }, 300_000);
  }
});

describe('the spark of the heartbeat', () => {
  it('the arena draws the heartbeat spark by its own look: the kind it watches is the spark the pacing spawns', () => {
    // Jiný druh by scéna nepoznala a nakreslila by jiskru modelem věci z věty – věc, která se nepočítá.
    expect(SPARK_KIND).toBe(HEARTBEAT_SPARK.kind);
    const world = worldOf(cellSpec('arena.collect'), 1);
    expect(world.kinds).toContain(SPARK_KIND);
  });
});

describe('the boss behind the banner', () => {
  it('bossKindOf knows the champion and the boss target; the station rush and the survival shower have no boss', () => {
    expect(bossKindOf(worldOf(cellSpec('duel.default'), 1))).toBe('boss');
    expect(bossKindOf(worldOf(cellSpec('throw.default'), 2))).toBe('boss');
    expect(bossKindOf(worldOf(cellSpec('arena.collect'), 1))).toBe('boss');
    expect(bossKindOf(worldOf(cellSpec('quest.station'), 1))).toBeNull();
    expect(bossKindOf(worldOf(cellSpec('arena.escape'), 1))).toBeNull();
  });
});

describe('stored genre.v3 games announce as before', () => {
  const STORED: readonly (readonly [string, readonly PacingBeat[]])[] = [
    ['arena.collect', ['buildUp', 'boss']],
    ['arena.escape', ['buildUp', 'wave']],
    ['quest.spatial', ['buildUp', 'boss']],
    ['quest.station', ['buildUp', 'round']],
    ['duel.default', ['buildUp', 'round']],
    ['throw.default', ['buildUp', 'bonus']],
  ];
  for (const [id, order] of STORED) {
    it(`${id} stored as genre.v3: no segment news, ${order.join(' → ')}`, async () => {
      const spec = storedV3(cellSpec(id));
      await preloadPhysics(spec, loadRapier);
      for (const seed of [1, 2]) {
        const world = worldOf(spec, seed);
        expect(segmentNewsOf(world), `${id} seed ${seed}`).toEqual([]);
        expect(pacingBeatOrderOf(world), `${id} seed ${seed}`).toEqual(order);
        expect(finaleBossesOf(world)).toBeNull();
      }
    });
  }
});
