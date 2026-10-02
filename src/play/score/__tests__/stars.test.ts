import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';
import { compileGame } from '@/play/compile';
import { readGameSpec } from '@/play/spec';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';

import runnerFixture from '../../arcade/__fixtures__/runner.json';
import { parOf, scoredReplay } from '../replay';
import { type Par, type RunResult, STARS, starsFor } from '../stars';

const par: Par = { score: 100, ticks: 1000 };
const won = (over: Partial<RunResult> = {}): RunResult => ({ won: true, score: 100, ticks: 1000, lives: 0, livesStart: 0, ...over });

describe('starsFor – hvězdy proti paru (P36B T1)', () => {
  it('prohra je 0 hvězd, i s lepším skóre a časem než par', () => {
    expect(starsFor(won({ won: false, score: 500, ticks: 10 }), par)).toBe(0);
  });

  it('výhra jako par = 3 hvězdy', () => {
    expect(starsFor(won(), par)).toBe(3);
  });

  it('hranice času: 3 hvězdy přesně na prahu, 2 těsně za ním, 1 za prahem dvou', () => {
    const three = Math.floor(par.ticks * STARS.three.time);
    const two = Math.floor(par.ticks * STARS.two.time);
    expect(starsFor(won({ ticks: three }), par)).toBe(3);
    expect(starsFor(won({ ticks: three + 1 }), par)).toBe(2);
    expect(starsFor(won({ ticks: two }), par)).toBe(2);
    expect(starsFor(won({ ticks: two + 1 }), par)).toBe(1);
  });

  it('hranice skóre: 3 hvězdy od skóre paru, 2 od poloviny, pod ní 1', () => {
    const three = Math.ceil(par.score * STARS.three.score);
    const two = Math.ceil(par.score * STARS.two.score);
    expect(starsFor(won({ score: three }), par)).toBe(3);
    expect(starsFor(won({ score: three - 1 }), par)).toBe(2);
    expect(starsFor(won({ score: two }), par)).toBe(2);
    expect(starsFor(won({ score: two - 1 }), par)).toBe(1);
  });

  it('hranice životů: 3 hvězdy jen bez ztráty, 2 s polovinou, méně = 1', () => {
    expect(starsFor(won({ lives: 4, livesStart: 4 }), par)).toBe(3);
    expect(starsFor(won({ lives: 3, livesStart: 4 }), par)).toBe(2);
    expect(starsFor(won({ lives: 2, livesStart: 4 }), par)).toBe(2);
    expect(starsFor(won({ lives: 1, livesStart: 4 }), par)).toBe(1);
  });

  it('skóre nad parem nevyváží pomalý běh – každé kritérium musí projít', () => {
    expect(starsFor(won({ score: 1000, ticks: par.ticks * 3 }), par)).toBe(1);
  });

  it('hra bez skóre (par 0) se soudí jen časem a životy', () => {
    const noScore: Par = { score: 0, ticks: 1000 };
    expect(starsFor(won({ score: 0 }), noScore)).toBe(3);
    expect(starsFor(won({ score: 0, ticks: 1500 }), noScore)).toBe(2);
    expect(starsFor(won({ score: 0, lives: 1, livesStart: 3 }), noScore)).toBe(1);
  });

  it('chybí par: výhra = 1 hvězda, prohra = 0', () => {
    expect(starsFor(won(), null)).toBe(1);
    expect(starsFor(won({ won: false }), null)).toBe(0);
  });
});

describe('par – běh robota ověřovače se skóre (P36B T1)', () => {
  const spec = (() => {
    const read = readGameSpec(runnerFixture);
    if (!read.ok) throw new Error(read.issues.join('; '));
    return read.value;
  })();
  const compiled = compileGame(spec, 1);
  if (!compiled.ok) throw new Error(compiled.issues.join('; '));
  const world = compiled.value.arcade;
  if (world === undefined) throw new Error('runner fixture is not an arcade game');

  it('přehrání se skóre dá týž hash, výsledek a tik jako přehrání jádra', () => {
    const bot = runBot(world);
    const scored = scoredReplay(world, bot.inputs, []);
    const kernel = replay(world, bot.inputs, ARCADE_LIBRARY);
    expect({ hash: scored.hash, outcome: scored.outcome, tick: scored.tick }).toEqual(kernel);
  });

  it('par je tik a skóre vítězného běhu robota', () => {
    const bot = runBot(world);
    const value = parOf(world, bot.inputs);
    expect(value).toEqual({ ticks: bot.tick, score: scoredReplay(world, bot.inputs, []).score });
  });

  it('prohraný běh par nedá', () => {
    expect(parOf(world, [])).toBeNull();
  });

  it('publikace uloží par do zprávy arkádové hry', () => {
    const report = reportFor(compiled.value);
    expect(report.publishEligible).toBe(true);
    expect(report.par).toEqual(parOf(world, runBot(world).inputs));
  });
});
