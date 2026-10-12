/**
 * Banner průběhu (P45C T16). Co by se četlo dobře a lhalo: „Boss!“ ve hře, kde
 * boss nepřijde (nebo dřív, než přijde), banner ve hře bez finále a táž chvíle
 * ohlášená dvakrát. Test proto hraje skutečné hry každého druhu finále (buňky
 * P41, robot intermediate) tik po tiku prostou smyčkou a v každém tiku porovná,
 * co hlásí `pacingBeatOf`, s mechanismem, který svět opravdu má (živé tělo
 * bosse, čítač vlny, fáze rychlosti, rozhodčí náhlé smrti …); banner pak každou
 * chvíli ukáže nejvýš jednou, na `PACING_BANNER_TICKS` tiků.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeState, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type InputEvent, type PieceRef, UNIT, bodyBase, nativeRule, underlyingRule } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type BehaviourRef, behaviourBodies } from '@/play/arcade/pieces/behaviours';
import { play } from '@/play/arcade/pieces/behaviours/__tests__/harness';
import { duelControl, enragedAfter } from '@/play/arcade/pieces/duel';
import { FINALES, type PacingBeat, type PacingRuleParams, pacingBeatOf, reachedOf } from '@/play/arcade/pieces/pacing';
import { RHYTHM } from '@/play/arcade/pieces/rhythm';
import { THROW_ROUND_COUNTER } from '@/play/arcade/pieces/throw';
import { waveOf } from '@/play/arcade/pieces/waves';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { type Phase, phaseSpeed } from '@/play/compose/progression';

import { PACING_BANNER_LABELS, PACING_BANNER_TICKS, PacingBanner, createPacingBannerWatch } from '../PacingBanner';

type Finale = (typeof FINALES)[number];

/** Robot na celé hře pod cizí zátěží stroje. */
const SLOW = 300_000;

const cellWorld = (id: string, seed: number): ArcadeWorld => {
  const cell = liveCells().find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`no live cell ${id}`);
  const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};

const pacingOf = (world: ArcadeWorld): PacingRuleParams | undefined => nativeRule(world.rules, 'pacing')?.params as PacingRuleParams | undefined;
const bot = (world: ArcadeWorld): readonly InputEvent[] => runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs;
const playerZ = (state: ArcadeState): number => state[bodyBase(state[HEADER.player] as number) + BODY.z] as number;
const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Předloha bosse: z pravidla zásahu (`boss_beat`, `boss_beat_hit`), jinak poslední chování (strážce úkolu). */
function bossTemplate(world: ArcadeWorld): number {
  const beat = world.rules.map(underlyingRule).find((rule) => rule.id === 'boss_beat' || rule.id === 'boss_beat_hit');
  if (beat !== undefined) return beat.params.boss as number;
  return (pacingOf(world)?.behaviours?.at(-1) as BehaviourRef).template;
}

/** Živé tělo s modelem a šířkou předlohy bosse – nezávisle na podpisu, kterým tělo chování pozná rámec. */
function bossAlive(world: ArcadeWorld): (state: ArcadeState) => boolean {
  const template = bodyBase(bossTemplate(world));
  return (state) => {
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
      const base = bodyBase(body);
      if (alive(state, body) && state[base + BODY.kind] === state[template + BODY.kind] && state[base + BODY.w] === state[template + BODY.w]) return true;
    }
    return false;
  };
}

const controlIn = (ref: PieceRef, id: string): PieceRef | undefined => (ref.id === id ? ref : ref.params.base === undefined ? undefined : controlIn(ref.params.base as PieceRef, id));

/**
 * Kdy finále opravdu běží, čteno tím, co ho ve světě dělá – ne jeho jménem. Rytmus má zvláštní kontrolu
 * (`phraseStart`): jeho finále je místo v písničce, ne přepínač ve stavu.
 */
function finaleMechanism(world: ArcadeWorld, finale: Finale): ((state: ArcadeState) => boolean) | null {
  const waves = nativeRule(world.rules, 'arena_waves')?.params.waves as readonly unknown[] | undefined;
  if (finale === 'boss') return bossAlive(world);
  if (finale === 'wave' || (finale === 'round' && waves !== undefined)) return (state) => waveOf(state) === (waves as readonly unknown[]).length;
  if (finale === 'round') {
    const duel = duelControl.params.parse(controlIn(world.control, 'duel')!.params);
    return (state) => enragedAfter(Math.floor(playerZ(state) / UNIT), duel);
  }
  if (finale === 'sprint') {
    const phased = controlIn(world.control, 'phase_control')!.params as { phases: Phase[]; length: number };
    // Nejrychlejší fáze trati (125 %).
    const top = Math.max(...phased.phases.map((phase) => phase.speedPercent));
    return (state) => phaseSpeed(1000, playerZ(state), phased.length, phased.phases) === top * 10;
  }
  if (finale === 'sudden') {
    const judge = nativeRule(world.rules, 'judge')!.params as { goal: number; sudden: number };
    return (state) => Math.floor(playerZ(state) / UNIT) >= judge.goal - judge.sudden;
  }
  if (finale === 'bonus') {
    const rounds = (nativeRule(world.rules, 'throw_rounds')!.params.rounds as readonly unknown[]).length;
    return (state) => (state[HEADER.counters + COUNTER[THROW_ROUND_COUNTER]] as number) === rounds;
  }
  return null;
}

/** Rytmus: kolik not písnička položí před finále křivky (850 ‰ písničky, jako `curveLanes`). */
function notesBeforeFinale(world: ArcadeWorld): { readonly before: number; readonly notes: number } {
  const ticks: number[] = [];
  const initial = instantiate(world);
  for (let body = 1; body < (initial[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (initial[base + BODY.role] === initial[bodyBase(1) + BODY.role] && alive(initial, body)) ticks.push((initial[base + BODY.z] as number) / RHYTHM.noteSpeed);
  }
  const span = Math.max(...ticks) - RHYTHM.leadIn;
  return { before: ticks.filter((tick) => ((tick - RHYTHM.leadIn) * 1000) / span < 850).length, notes: ticks.length };
}

interface Trace {
  readonly beats: (PacingBeat | null)[];
  readonly banner: (PacingBeat | null)[];
  readonly states: { readonly mechanism: boolean; readonly reached: number; readonly z: number; readonly foes: number }[];
  readonly won: boolean;
}

/** Hra tik po tiku: chvíle, banner a co svět má (bez kopií stavu – `toEqual` každý tik by soubor zpomalil). */
function trace(world: ArcadeWorld, inputs: readonly InputEvent[]): Trace {
  const rule = pacingOf(world);
  const finale = rule?.finale;
  const mechanism = finale === undefined ? null : finaleMechanism(world, finale);
  const refs = rule?.behaviours ?? [];
  const foes = finale === 'boss' ? refs.slice(0, -1) : refs;
  const watch = createPacingBannerWatch(world);
  const beats: (PacingBeat | null)[] = [];
  const banner: (PacingBeat | null)[] = [];
  const states: Trace['states'][number][] = [];
  const end = play(world, inputs, (state) => {
    beats.push(pacingBeatOf(world, state));
    banner.push(watch.see(state));
    states.push({
      mechanism: mechanism?.(state) ?? false,
      reached: rule === undefined ? 0 : reachedOf(state, rule.keeper),
      z: playerZ(state),
      foes: foes.length === 0 ? 0 : behaviourBodies(state, state[HEADER.player] as number, foes).length,
    });
  });
  return { beats, banner, states, won: end[HEADER.runState] === 1 };
}

/** Souvislé úseky banneru `[chvíle, první tik, délka]`. */
function blocks(banner: readonly (PacingBeat | null)[]): [PacingBeat, number, number][] {
  const out: [PacingBeat, number, number][] = [];
  banner.forEach((beat, tick) => {
    if (beat === null) return;
    const last = out.at(-1);
    if (last !== undefined && last[0] === beat && last[1] + last[2] === tick) last[2] += 1;
    else out.push([beat, tick, 1]);
  });
  return out;
}

/** První vyhraný běh robota na semínkách 1–4 (finále přijde jen ve hře, která k němu dojde). */
function wonRun(id: string): { readonly world: ArcadeWorld; readonly run: Trace } {
  for (const seed of [1, 2, 3, 4]) {
    const world = cellWorld(id, seed);
    const run = trace(world, bot(world));
    if (run.won) return { world, run };
  }
  throw new Error(`${id}: the intermediate bot won no seed 1–4`);
}

const CASES: readonly (readonly [string, Finale])[] = [
  ['arena.collect', 'boss'],
  ['arena.fight', 'boss'],
  ['quest.spatial', 'boss'],
  ['arena.escape', 'wave'],
  // Běžec (P46B T4) končí bossem v pruzích, řízení (T5) pronásledovatelem; sprint zůstal poletování.
  ['runner.default', 'boss'],
  ['drive.race', 'boss'],
  ['flap.default', 'sprint'],
  ['duel.default', 'round'],
  ['quest.station', 'round'],
  ['throw.default', 'bonus'],
  ['timing.stack', 'sudden'],
  ['rhythm.default', 'phrase'],
];

describe('pacingBeatOf – what the game has, tick by tick', () => {
  it.each(CASES)('%s: the %s finale is announced exactly while its mechanism runs, once, after the build-up', (id, finale) => {
    const { world, run } = wonRun(id);
    expect(pacingOf(world)?.finale).toBe(finale);
    // Jen chvíle, které tahle hra má (úkol: postup po kolech skočí na místo prvního chování i bosse v jednom tiku).
    expect(new Set(run.beats.filter((beat) => beat !== null))).toEqual(new Set(run.states.some((state) => state.foes > 0 && !state.mechanism) ? ['buildUp', finale] : [finale]));
    if (finale === 'phrase') {
      // Rytmus: finále začne s první notou finále křivky (± jedna fráze čtyř not), ne až s 85 % vyřízených not.
      const first = run.beats.indexOf('phrase');
      const { before, notes } = notesBeforeFinale(world);
      expect(Math.abs(Math.floor(run.states[first]!.z / UNIT) - before)).toBeLessThanOrEqual(4);
      expect(before).toBeLessThan(Math.floor((notes * 85) / 100) - 4);
    } else {
      // Tik po tiku: finále hlásí právě tehdy, když jeho mechanismus běží (boss žije, poslední vlna, nejrychlejší fáze …).
      const wrong = run.beats.flatMap((beat, tick) => ((beat === finale) !== run.states[tick]!.mechanism ? [tick] : []));
      expect(wrong.slice(0, 5), `ticks where the ${finale} beat and the world disagree`).toEqual([]);
    }
    // Stupňování: přesně když je na ploše nové chování (ne boss) a finále neběží.
    const foes = run.beats.flatMap((beat, tick) => ((beat === 'buildUp') !== (run.states[tick]!.foes > 0 && beat !== finale) ? [tick] : []));
    expect(foes.slice(0, 5)).toEqual([]);

    // Banner: finále jednou, stupňování nejvýš jednou a před ním, každé na celých 1,4 s (nebo do finále či konce běhu).
    const shown = blocks(run.banner);
    expect(shown.filter(([beat]) => beat === finale)).toHaveLength(1);
    expect(shown.map(([beat]) => beat)).toEqual(shown.length === 2 ? ['buildUp', finale] : [finale]);
    // Běžec (R2): hrozby v pruzích přijdou před bossem – „Here they come!“ je vidět.
    if (id === 'runner.default') expect(shown.map(([beat]) => beat)).toEqual(['buildUp', 'boss']);
    for (const [index, [beat, from, ticks]] of shown.entries()) {
      expect(from).toBe(run.beats.indexOf(beat));
      const next = shown[index + 1]?.[1] ?? run.banner.length;
      expect(ticks).toBe(Math.min(PACING_BANNER_TICKS, next - from));
    }
  }, SLOW);

  it('a game without a finale shows no banner – even with new behaviours on the field', () => {
    for (const id of ['platformer.default', 'shooter.default', 'voyage.race']) {
      const world = cellWorld(id, 1);
      expect(pacingOf(world)?.finale, id).toBeUndefined();
      const run = trace(world, bot(world));
      expect(run.beats.every((beat) => beat === null), id).toBe(true);
      expect(run.banner.every((beat) => beat === null), id).toBe(true);
    }
    // Přežití bez finále v pravidle: ostřelovač přijde, banner ne.
    const paced = cellWorld('arena.escape', 1);
    const world: ArcadeWorld = {
      ...paced,
      rules: paced.rules.map((rule) => {
        if (underlyingRule(rule).id !== 'pacing') return rule;
        const { finale: _finale, ...params } = rule.params;
        return { ...rule, params };
      }),
    };
    const run = trace(world, bot(world));
    expect(run.states.some((state) => state.foes > 0)).toBe(true);
    expect(run.banner.every((beat) => beat === null)).toBe(true);
  }, SLOW);

  it('“Boss!” comes from the boss on the field, not from the finale name or the progress it was due at', () => {
    // Sběr s bossem, kterému rozvrh nedal spawn: postup přejde místo bosse, finále se jmenuje `boss`, boss nepřijde.
    const paced = cellWorld('arena.collect', 1);
    const template = bossTemplate(paced);
    const rule = pacingOf(paced)!;
    const due = rule.schedule.find((entry) => entry.template === template)!.atPermille;
    const world: ArcadeWorld = {
      ...paced,
      rules: paced.rules.map((ref) => (underlyingRule(ref).id === 'pacing' ? { ...ref, params: { ...ref.params, schedule: rule.schedule.filter((entry) => entry.template !== template) } } : ref)),
    };
    const run = trace(world, bot(world));
    expect(run.states.some((state) => state.reached >= due)).toBe(true);
    expect(run.beats).not.toContain('boss');
    expect(run.banner).not.toContain('boss');
    // Hry bez bosse „Boss!“ nikdy neřeknou: popisek patří jen finále `boss`.
    expect(Object.entries(PACING_BANNER_LABELS).filter(([, label]) => label === 'Boss!').map(([beat]) => beat)).toEqual(['boss']);
  }, SLOW);
});

describe('the banner on screen', () => {
  it('every beat has a short English label in sentence case', () => {
    expect(Object.keys(PACING_BANNER_LABELS).sort()).toEqual(['buildUp', ...FINALES].sort());
    expect(PACING_BANNER_LABELS.buildUp).toBe('Here they come!');
    expect([PACING_BANNER_LABELS.boss, PACING_BANNER_LABELS.wave, PACING_BANNER_LABELS.sprint, PACING_BANNER_LABELS.round]).toEqual(['Boss!', 'Final wave!', 'Final sprint!', 'Last round!']);
    for (const label of Object.values(PACING_BANNER_LABELS)) {
      expect(label).toMatch(/^[A-Z][a-z]*( [a-z]+)*!$/);
      expect(label.length).toBeLessThanOrEqual(15);
    }
    expect(PACING_BANNER_TICKS).toBe(84);
  });

  it('renders the kit world tag with the beat while the game runs, nothing before the beat or when off', () => {
    const world = cellWorld('runner.default', 1);
    const inputs = bot(world);
    let finale: ArcadeState | null = null;
    let early: ArcadeState | null = null;
    play(world, inputs, (state, tick) => {
      if (tick === 10) early = state.slice();
      if (finale === null && pacingBeatOf(world, state) === 'boss') finale = state.slice();
    });
    const session = (state: ArcadeState) => ({ world, state: () => state, subscribe: () => () => undefined });
    const html = renderToStaticMarkup(createElement(PacingBanner, { session: session(finale!), enabled: true }));
    expect(html).toContain('class="sp-world-tag play-pacing-banner"');
    expect(html).toContain('data-beat="boss"');
    expect(html).toContain('Boss!');
    expect(renderToStaticMarkup(createElement(PacingBanner, { session: session(finale!), enabled: false }))).toBe('');
    expect(renderToStaticMarkup(createElement(PacingBanner, { session: session(early!), enabled: true }))).toBe('');
  }, SLOW);

  it('a restart (tick back) announces the beats again; reduced motion stills the pop, never the text', () => {
    const world = cellWorld('runner.default', 1);
    const watch = createPacingBannerWatch(world);
    const states: ArcadeState[] = [];
    play(world, bot(world), (state) => {
      if (pacingBeatOf(world, state) === 'boss' && states.length < 2) states.push(state.slice());
    });
    const start = instantiate(world);
    expect(watch.see(states[0]!)).toBe('boss');
    expect(watch.see(start)).toBeNull();
    expect(watch.see(states[1]!)).toBe('boss');
    const css = readFileSync(join(process.cwd(), 'src/app/play/play.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.play-pacing-banner \{\s*animation: none;\s*\}\s*\}/);
    expect(css).not.toMatch(/\.play-pacing-banner[^{]*\{[^}]*(display: none|visibility: hidden)/);
  }, SLOW);
});
