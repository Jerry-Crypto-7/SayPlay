/**
 * Úseky pole (P47A T8): ve `genre.v4` přinese úsek 2 i úsek 3 sběru, útěku s věcmi a přežití nového nepřítele,
 * kterého žádný dřívější krok rozvrhu neměl, a nikdy v tiku bosse; quest v prostoru nového nepřítele v úseku 2
 * (úsek 3 je u něj kolo bosse – postup skočí po kolech). Rozvrh za běhu nikdo nevidí, test čte svět: krok přijde
 * až s věcí, kolem či tikem, které ho přešly (`crossing`). Spawnů nepřibude, scénář je čistá funkce semínka
 * a uložené hry (`genre.v3`) i úseky běžce, řízení a skákačky stavějí bajtově týž svět.
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../compile';
import { type ArcadeWorld, type PieceRef, nativeRule } from '../contract';
import { loadRapier } from '../physics/world';
import type { BehaviourRef } from '../pieces/behaviours';
import type { PacingGoal, PacingRuleParams } from '../pieces/pacing';
import { FIELD } from '../pieces/pacing-parts';
import { type SegmentCast, type SegmentChange, type SegmentStep, segmentScriptOf, segmentSpans } from '../pieces/segments';
import { createCompileRng } from '@/play/compile/rng';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { GameSpecV1 } from '@/play/spec';

const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);

const cellSpec = (id: string): GameSpecV1 => compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === id)!));

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const chain = (ref: PieceRef): PieceRef[] => {
  const base = ref.params.base as PieceRef | undefined;
  return base === undefined ? [ref] : [ref, ...chain(base)];
};
const pacedControl = (world: ArcadeWorld): PieceRef => chain(world.control).find((ref) => ref.id === 'pacing_control')!;

/** Kde postup krok na `p` ‰ nejpozději přejde: cíl roste po celých věcech, kolech či tikách (`progressOf`). */
const crossing = (goal: PacingGoal, p: number): number => Math.min(1000, Math.floor((Math.ceil((p * goal.need) / 1000) * 1000) / goal.need));

interface Steps {
  /** Kroky chování (bez bosse a mincí deště) s místem, kde je postup přejde, podle něj seřazené. */
  readonly foes: readonly { readonly at: number; readonly template: number }[];
  readonly boss: number | undefined;
}

function stepsOf(world: ArcadeWorld): Steps {
  const rule = nativeRule(world.rules, 'pacing')!.params as PacingRuleParams;
  const refs = (pacedControl(world).params.behaviours ?? []) as BehaviourRef[];
  const goal = pacedControl(world).params.goal as PacingGoal;
  const boss = refs.find((ref) => ref.id === 'boss')?.template;
  const foes = new Set(refs.filter((ref) => ref.id !== 'boss').map((ref) => ref.template));
  const bossStep = rule.schedule.find((entry) => entry.template === boss);
  return {
    foes: rule.schedule.filter((entry) => foes.has(entry.template)).map((entry) => ({ at: crossing(goal, entry.atPermille), template: entry.template })).sort((a, b) => a.at - b.at),
    boss: bossStep === undefined ? undefined : crossing(goal, bossStep.atPermille),
  };
}

/** První krok, který postup přejde v úseku `[at, until)` mimo tik bosse, je nepřítel, kterého žádný dřívější krok neměl; jinak důvod. */
function segmentFoe(steps: Steps, [at, until]: readonly [number, number]): string | null {
  const first = steps.foes.find((step) => step.at >= at && step.at !== steps.boss);
  if (first === undefined || first.at >= until) return `no foe step in ${at}–${until} (${steps.foes.map((step) => step.at).join(' ')}, boss ${steps.boss})`;
  if (steps.foes.some((step) => step.at < first.at && step.template === first.template)) return `segment ${at} opens with a foe seen before`;
  return null;
}

const FIELD_CELLS = [
  { id: 'arena.collect', budget: FIELD.collect.budget, segment3: true },
  { id: 'arena.escape+collect', budget: FIELD.escape.budget, segment3: true },
  // Přežití má jedno chování (druhé shodilo pásma, `FIELD.scripted`): nového nepřítele dostane jen úsek 2.
  { id: 'arena.escape', budget: FIELD.survival.budget, segment3: false },
  { id: 'quest.spatial', budget: FIELD.quest.budget, segment3: false },
] as const;

beforeAll(async () => {
  await loadRapier();
  for (const cell of FIELD_CELLS) await preloadPhysics(cellSpec(cell.id), loadRapier);
});

describe('field segment script', () => {
  const cast: SegmentCast = { foes: [{ behaviour: 'guardian', from: 0 }, { behaviour: 'ambusher', from: 0 }], speeds: [] };
  const scriptOf = (seed: number): SegmentStep[] => segmentScriptOf(createCompileRng(seed, 'pacing'), 'field', cast);
  const foeOf = (step: SegmentStep): string | undefined => step.changes.find((change): change is Extract<SegmentChange, { kind: 'newFoe' }> => change.kind === 'newFoe')?.behaviour;

  it('is a pure function of the seed: segments 2 and 3 each get a different new foe, drawn per seed, and nothing else', () => {
    const second = new Set<string | undefined>();
    for (const seed of Array.from({ length: 40 }, (_, index) => index + 1)) {
      const script = scriptOf(seed);
      expect(script).toEqual(scriptOf(seed));
      expect(script.map((step) => [step.at, step.until])).toEqual(segmentSpans());
      const [two, three] = script as [SegmentStep, SegmentStep];
      expect(foeOf(two), `seed ${seed}`).toBeDefined();
      expect(foeOf(three), `seed ${seed}`).toBeDefined();
      expect(foeOf(three)).not.toBe(foeOf(two));
      expect(script.flatMap((step) => step.changes.map((change) => change.kind))).toEqual(['newFoe', 'newFoe']);
      second.add(foeOf(two));
    }
    expect(second).toEqual(new Set(['guardian', 'ambusher']));
  });
});

describe('field worlds follow the script (genre.v4)', () => {
  for (const cell of FIELD_CELLS) {
    it(`${cell.id}: segment 2${cell.segment3 ? ' and 3 open' : ' opens'} with a new foe, never in the boss tick, with the same spawn budget`, () => {
      const spec = cellSpec(cell.id);
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        const steps = stepsOf(world);
        expect(steps.foes, `${cell.id} seed ${seed}: budget`).toHaveLength(cell.budget);
        const [two, three] = segmentSpans() as [readonly [number, number], readonly [number, number]];
        // Nový nepřítel nikdy nepřijde v tiku bosse (boss vyčistí role a má finále sám): krok v tiku bosse úsek neotevře,
        // a kdyby ho nový nepřítel měl, jeho pozdější krok by `segmentFoe` vrátil jako už viděný.
        expect(segmentFoe(steps, two), `${cell.id} seed ${seed}: segment 2`).toBeNull();
        if (cell.segment3) expect(segmentFoe(steps, three), `${cell.id} seed ${seed}: segment 3`).toBeNull();
        // Scénář je čistá funkce semínka: týž svět znovu.
        expect(JSON.stringify(worldOf(spec, seed))).toBe(JSON.stringify(world));
      }
    }, 120_000);
  }
});

const hashOf = (world: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 12);

describe('stored games and track segment scripts build the same world', () => {
  // Otisky světů na `f04010df` (před T8), semínka 1–3: uložené hry pole (`genre.v3`), úseky P46B (běžec, řízení,
  // skákačka) a přežití `genre.v4` – jeho jediné chování už první krok úseku 2 mělo, scénář svět nemění. Přežití
  // `genre.v4` přeotisknuté v T9 (P47A): svět má navíc tep (předloha mince, tělo-počítadlo tepu, 3 sloty).
  // Běžec a skákačka mají od P51 (T5 `bossRoom`, T7 tep trati) jiný svět nové hry: otisk drží uložená `genre.v4`.
  const PINS: readonly (readonly [string, 'genre.v3' | 'genre.v4' | null, readonly string[]])[] = [
    ['arena.collect', 'genre.v3', ['b8f490279695', '3a1e88e0bf3d', 'bb7d907225a6']],
    ['arena.escape', 'genre.v3', ['74a28c348188', '1591f5ae36dd', 'b56044e4a5d0']],
    ['arena.escape+collect', 'genre.v3', ['89cca55ed3df', '171b7bfe29e2', '7ff0286fe7cc']],
    ['quest.spatial', 'genre.v3', ['e7a5cb8cd961', '884d8d96893b', '56c7a67b52af']],
    ['arena.escape', null, ['970a6d998abd', 'bf1788f16bc0', '4ae534980487']],
    ['runner.default', 'genre.v4', ['91adfc092eae', '443589755c48', '5b57273aa65e']],
    ['run.escape', 'genre.v4', ['762ef4f834fd', '768ed29c6ac0', '24e183116936']],
    ['platformer.default', 'genre.v4', ['a742d0104813', 'c2a18d608e93', '73161f418097']],
    ['jump.escape', null, ['a24d7d626c55', '0694e2d9cea6', '0ea3652eba69']],
    ['drive.race', null, ['1ae6e90d16a0', '24c10da222ba', 'ad7e24478ae9']],
    ['drive.reach+shoot+collect', null, ['1d885860c6ce', 'd3a0c65b76cf', '9801d1540b6d']],
  ];
  for (const [id, stored, pins] of PINS) {
    it(`${id}${stored === null ? '' : ` stored as ${stored}`}: the world hash of seeds 1–3 is unchanged`, async () => {
      const spec = stored === null ? cellSpec(id) : { ...cellSpec(id), genre: { ...cellSpec(id).genre!, compilerVersion: stored } };
      await preloadPhysics(spec, loadRapier);
      expect([1, 2, 3].map((seed) => hashOf(worldOf(spec, seed)))).toEqual(pins);
    }, 60_000);
  }
});
