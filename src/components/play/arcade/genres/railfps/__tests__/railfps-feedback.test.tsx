/**
 * Odezva zásahu střelnice z očí (P68-F T8). Co by vypadalo dobře a bylo špatně: značka zásahu u rány, která minula
 * (nebo u nepřítele, který došel k hráči a sám zmizel), záblesk navíc z přestávky mezi koly, otřes při „méně pohybu“
 * – a hlavně odezva, která by do stavu zapsala: přehrání a Dare by se tiše rozešly.
 *
 * Proto: z ručního seznamu efektů tiku vznikne přesně tolik záblesků, značek, rozpadů, minutí a otřesů, kolik má;
 * s „méně pohybu“ žádný otřes. Na skutečné hře (robot i slabý hráč, tik po tiku přes relaci) počty sedí na stopu jádra
 * (`traceRailfps`: rány, zásahy, ztracené životy) a stav s připojenou odezvou je po každém tiku i po každém
 * vykreslení bajtově týž jako bez ní.
 */

import { describe, expect, it } from 'vitest';

import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeState, type ArcadeWorld, BODY, BODY_STRIDE, COUNTER, FLAG, HEADER, type InputEvent, START_LIVES, bodyBase, bodyHp, setBodyHp } from '@/play/arcade/contract';
import { completeHooks } from '@/play/arcade/hooks';
import { buildWorld, hashArcade, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { RAILFPS, RAILFPS_BODIES, aimOf, railfpsRail, rayPoint, targetY, writeAim } from '@/play/arcade/pieces/railfps';
import { railfpsWeakInputs } from '@/play/arcade/pieces/railfps-bot';
import { traceRailfps } from '@/play/arcade/pieces/railfps-trace';
import { runBot } from '@/play/arcade/verify';

import { createArcadeSession } from '../../../session';
import { FEEDBACK, type Mark, type RailfpsCue, countMarks, createRailfpsFeedback, feedbackFrame, marksOf, railfpsCuesOf } from '../RailfpsFeedback';

function worldOf(seed: number): ArcadeWorld {
  const parts = railfpsRail.parts(seed, railfpsRail.params.parse({}), undefined);
  if ((parts.issues ?? []).length > 0) throw new Error((parts.issues ?? []).join('; '));
  const built = buildWorld({ seed, control: parts.control, rules: completeHooks(parts.rules), bot: parts.bot, level: parts.level, health: parts.health ?? START_LIVES }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const WORLD = worldOf(1);
const { keeper, target, enemy, boss } = RAILFPS_BODIES;

/** Stav světa s živými cíli `[předloha, sektor, vzdálenost]` ve slotech za úrovní; vrací stav a jejich indexy. */
function stage(foes: readonly (readonly [number, number, number])[]): { readonly state: ArcadeState; readonly bodies: readonly number[] } {
  const state = instantiate(WORLD);
  const bodies = foes.map(([template, sector, distance]) => {
    const body = state[HEADER.bodyCount] as number;
    state[HEADER.bodyCount] = body + 1;
    const to = bodyBase(body);
    state.copyWithin(to, bodyBase(template), bodyBase(template) + BODY_STRIDE);
    const at = rayPoint(sector, distance);
    state[to + BODY.x] = at.x;
    state[to + BODY.z] = at.z;
    state[to + BODY.y] = template === target ? targetY(1) : 0;
    state[to + BODY.flags] = (state[to + BODY.flags] as number) | FLAG.alive;
    return body;
  });
  return { state, bodies };
}

/** Tik z ručního seznamu efektů: stav po tiku = kopie `before` se změnou `change` a ranou do sektoru `shot`. */
function tickOf(before: ArcadeState, effects: readonly ArcadeEffect[], change: (after: ArcadeState) => void, shot: number | null): RailfpsCue[] {
  const after = Int32Array.from(before);
  after[HEADER.tick] = (before[HEADER.tick] as number) + 1;
  change(after);
  writeAim(after, keeper, aimOf(after, keeper), shot);
  return railfpsCuesOf(effects, before[HEADER.tick] as number, after, before, keeper);
}

const despawned = (body: number) => (state: ArcadeState) => {
  state[bodyBase(body) + BODY.flags] = (state[bodyBase(body) + BODY.flags] as number) & ~FLAG.alive;
};
const nothing = (): void => undefined;
const kinds = (cues: readonly RailfpsCue[]): string[] => cues.map((cue) => (cue.kind === 'hit' ? `hit:${cue.kill ? 'kill' : 'chip'}:${cue.tone}` : cue.kind));

/** Ruční tiky: sražený terč, rána do prázdného sektoru, nepřítel na dosah vzal život, ubrané HP bosse, sražený nepřítel. */
function handTicks(): RailfpsCue[][] {
  const kill = stage([[target, 0, 10_000]]);
  const empty = stage([[target, 2, 10_000]]);
  const reach = stage([[enemy, -1, RAILFPS.reach]]);
  const chip = stage([[boss, 1, 18_000]]);
  const foe = stage([[enemy, 3, 12_000]]);
  return [
    tickOf(kill.state, [{ kind: 'score', amount: RAILFPS.points.target }, { kind: 'despawn', body: kill.bodies[0]! }], despawned(kill.bodies[0]!), 0),
    tickOf(empty.state, [], nothing, 0),
    tickOf(
      reach.state,
      [{ kind: 'damage', amount: 1 }, { kind: 'despawn', body: reach.bodies[0]! }],
      (after) => {
        despawned(reach.bodies[0]!)(after);
        after[HEADER.counters + COUNTER.health] = (after[HEADER.counters + COUNTER.health] as number) - 1;
      },
      null,
    ),
    tickOf(chip.state, [{ kind: 'hit', body: chip.bodies[0]!, by: 0, amount: 1 }], (after) => setBodyHp(after, chip.bodies[0]!, bodyHp(after, chip.bodies[0]!) - 1), 1),
    tickOf(foe.state, [{ kind: 'score', amount: RAILFPS.points.enemy }, { kind: 'despawn', body: foe.bodies[0]! }], despawned(foe.bodies[0]!), 3),
  ];
}

describe('railfps hit feedback from a hand-made effect list (P68-F T8)', () => {
  it('reads each tick: shot, hit, miss and life lost', () => {
    expect(handTicks().map(kinds)).toEqual([['shot', 'hit:kill:target'], ['shot', 'miss'], ['hurt'], ['shot', 'hit:chip:enemy'], ['shot', 'hit:kill:enemy']]);
  });

  it('makes the right number of flashes, beams, markers, bursts, misses and shakes', () => {
    const marks = handTicks().flatMap((cues, k) => marksOf(cues, k * 20, false));
    expect(countMarks(marks)).toEqual({ flash: 4, beam: 4, marker: 3, miss: 1, burst: 2, shake: 1, edge: 1 });
  });

  it('with reduced motion there is no shake, the edge flash stays', () => {
    const marks = handTicks().flatMap((cues, k) => marksOf(cues, k * 20, true));
    expect(countMarks(marks)).toEqual({ flash: 4, beam: 4, marker: 3, miss: 1, burst: 2, shake: 0, edge: 1 });
    // Stopa otřesu vzniklá bez přání se s přáním nekreslí.
    const shaking = marksOf([{ kind: 'hurt', tick: 0 }], 0, false);
    for (const at of [0, 40, 120]) expect(feedbackFrame(shaking, at, true).shake).toEqual({ x: 0, y: 0 });
  });

  it('a reach despawn in the tick of a shot is no hit: the shot is a miss and the player is hurt', () => {
    const reach = stage([[enemy, 0, RAILFPS.reach]]);
    const cues = tickOf(reach.state, [{ kind: 'damage', amount: 1 }, { kind: 'despawn', body: reach.bodies[0]! }], (after) => {
      despawned(reach.bodies[0]!)(after);
      after[HEADER.counters + COUNTER.health] = (after[HEADER.counters + COUNTER.health] as number) - 1;
    }, 0);
    expect(kinds(cues)).toEqual(['shot', 'miss', 'hurt']);
  });

  it('a shot slot held through the break between waves is no new shot', () => {
    const { state } = stage([]);
    writeAim(state, keeper, aimOf(state, keeper), 2);
    // Přestávka: ovládání neběží, slot drží ránu posledního tiku kola; háčky vydají své zprávy.
    const cues = tickOf(state, [{ kind: 'score', amount: 0 }], nothing, 2);
    expect(cues).toEqual([]);
  });

  it('shows the hit marker on a hit only, distinct from the miss ring, and fades both', () => {
    const [kill, miss, , chip] = handTicks();
    const hit = feedbackFrame(marksOf(kill!, 0, false), 16, false);
    expect(hit.marker).toBe(1);
    expect(hit.kill).toBe(true);
    expect(hit.miss).toBe(0);
    expect(hit.flash).toBeGreaterThan(0);
    expect(hit.beam).toBeGreaterThan(0);
    const missed = feedbackFrame(marksOf(miss!, 0, false), 16, false);
    expect(missed.marker).toBe(0);
    expect(missed.miss).toBeGreaterThan(0);
    expect(missed.miss).toBeLessThan(1);
    expect(feedbackFrame(marksOf(chip!, 0, false), 16, false).kill).toBe(false);
    const late = feedbackFrame([...marksOf(kill!, 0, false), ...marksOf(miss!, 0, false)], FEEDBACK.markerMs, false);
    expect([late.marker, late.miss, late.flash, late.beam]).toEqual([0, 0, 0, 0]);
    expect(late.particles).toEqual([]);
  });

  it('shakes at most 6 px for 200 ms', () => {
    const marks = marksOf([{ kind: 'hurt', tick: 0 }], 0, false);
    const samples = Array.from({ length: 21 }, (_, k) => feedbackFrame(marks, k * 10, false).shake);
    expect(samples.some((shake) => shake.x !== 0 || shake.y !== 0)).toBe(true);
    for (const shake of samples) expect(Math.max(Math.abs(shake.x), Math.abs(shake.y))).toBeLessThanOrEqual(FEEDBACK.shakePx);
    expect(feedbackFrame(marks, FEEDBACK.shakeMs, false).shake).toEqual({ x: 0, y: 0 });
    expect(feedbackFrame(marks, 50, false).edge).toBeGreaterThan(0);
  });

  it('bursts at most 12 particles at once, the newest burst first', () => {
    const kill = handTicks()[0]!;
    expect(feedbackFrame(marksOf(kill, 0, false), 10, false).particles).toHaveLength(FEEDBACK.burst);
    const three: Mark[] = [0, 10, 20].flatMap((at) => marksOf(kill, at, false));
    const frame = feedbackFrame(three, 30, false);
    expect(frame.particles).toHaveLength(FEEDBACK.particles);
    expect(FEEDBACK.particles).toBeLessThanOrEqual(12);
  });
});

/** Týž stav slovo po slově. */
function same(a: ArcadeState, b: ArcadeState): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Záznam zahraný relací tik po tiku (jako `tickByHand` sondy): jedna relace s odezvou a vykreslením po každém tiku,
 * druhá bez nich. Vrací počty stop, tiky s ubraným HP (zásah bez sražení) a jestli se stavy kdy rozešly.
 */
function playBoth(world: ArcadeWorld, inputs: readonly InputEvent[], reduced: boolean) {
  const watched = createArcadeSession(world);
  const bare = createArcadeSession(world);
  let clock = 0;
  const feedback = createRailfpsFeedback(watched, keeper, () => clock, () => reduced);
  const chips = new Set<number>();
  watched.onEvents((effects, tick) => {
    if (effects.some((effect) => effect.kind === 'hit' && effect.amount > 0)) chips.add(tick);
  });
  let drift = 0;
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && watched.snapshot().runState === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    for (const session of [watched, bare]) {
      if (event !== undefined && event.tick === tick) session.press(event.buttons, event.axis);
      session.stepOnce();
    }
    clock += 1000 / 60;
    const before = Int32Array.from(watched.state());
    feedback.frame(clock, reduced);
    if (!same(before, watched.state()) || !same(watched.state(), bare.state())) drift += 1;
  }
  const counts = feedback.counts();
  feedback.dispose();
  return { counts, chips, drift, hash: hashArcade(watched.state()), bareHash: hashArcade(bare.state()) };
}

describe('railfps hit feedback on a played game (P68-F T8)', () => {
  const runs = [
    { who: 'the bot', inputs: (world: ArcadeWorld) => runBot(world, ARCADE_LIBRARY).inputs },
    { who: 'the weak player', inputs: (world: ArcadeWorld) => railfpsWeakInputs(world) },
  ] as const;

  for (const { who, inputs } of runs) {
    for (const reduced of [false, true]) {
      it(`${who}${reduced ? ' with reduced motion' : ''}: one flash per kernel shot, a marker per hit, never a written byte`, () => {
        const world = worldOf(2);
        const played = inputs(world);
        const trace = traceRailfps(world, played, ARCADE_LIBRARY);
        const run = playBoth(world, played, reduced);
        expect(run.drift, 'state with feedback attached and drawn differs from the bare session').toBe(0);
        expect(run.hash).toBe(run.bareHash);
        expect(run.hash).toBe(trace.hash);
        const hitTicks = new Set([...trace.hits.map((hit) => hit.tick), ...run.chips]);
        expect(run.counts.flash).toBe(trace.shots.length);
        expect(run.counts.beam).toBe(trace.shots.length);
        expect(run.counts.burst).toBe(trace.hits.length);
        expect(run.counts.marker).toBe(trace.hits.length + run.chips.size);
        expect(run.counts.miss).toBe(trace.shots.filter((shot) => !hitTicks.has(shot.tick)).length);
        expect(run.counts.edge).toBe(trace.losses.length);
        expect(run.counts.shake).toBe(reduced ? 0 : trace.losses.length);
        expect(trace.shots.length).toBeGreaterThan(0);
      });
    }
  }

  it('the weak player both misses and loses lives, the bot hits', () => {
    const world = worldOf(2);
    const weak = playBoth(world, railfpsWeakInputs(world), false);
    expect(weak.counts.miss).toBeGreaterThan(0);
    expect(weak.counts.shake).toBeGreaterThan(0);
    const bot = playBoth(world, runBot(world, ARCADE_LIBRARY).inputs, false);
    expect(bot.counts.marker).toBeGreaterThan(0);
    expect(bot.counts.burst).toBeGreaterThan(0);
  });
});
