/**
 * Kroky režie pro čekajícího hráče (P73C T2): jen skutečné fáze a volby z odpovědi, kterou režisér opravdu přečetl.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { liveCells } from '../../compose/allowed';
import { answered, failed, fakeBranch } from '../__fixtures__/branch';
import { direct } from '../index';
import { type DirectorStep, MAX_STEPS, __resetSteps, picksOf, recordStep, stepText, stepsOf } from '../progress';
import type { GameSpecV1 } from '../../spec';

const runner = (hero: string, setting: string) => ({ plan: 'Run.', spec: { recipe: liveCells().find((cell) => cell.id === 'runner.default')!.recipe, hero, setting, unmet: [] } });

async function stepsWhile(sentence: string, script: Parameters<typeof fakeBranch>[0], maxRepairRounds = 0): Promise<string[]> {
  const steps: string[] = [];
  await direct(sentence, { branch: fakeBranch(script), now: () => 0, seed: 1, maxRepairRounds, onStep: (step) => steps.push(stepText(step)) });
  return steps;
}

afterEach(() => __resetSteps());

describe('direct() – kroky režie', () => {
  it('čtení, volání modelu, volby z přečtené odpovědi a kontrola robotem, v tomto pořadí', async () => {
    const steps = await stepsWhile('a fox runs through a forest', [answered(runner('fox', 'forest'))]);
    expect(steps.slice(0, 2)).toEqual(['Reading your idea…', 'Building the world…']);
    expect(steps).toContain('Hero: fox');
    expect(steps).toContain('Place: forest');
    expect(steps.some((step) => step.startsWith('Controls: '))).toBe(true);
    expect(steps.at(-1)).toBe('Checking it can be won…');
    // Volby až po volání modelu: nejsou to slova rychlé verze.
    expect(steps.findIndex((step) => step.startsWith('Hero: '))).toBeGreaterThan(steps.indexOf('Building the world…'));
  });

  it('bez odpovědi modelu žádné volby – nic vymyšleného', async () => {
    const steps = await stepsWhile('a fox runs through a forest', [failed('UPSTREAM_UNAVAILABLE')]);
    expect(steps).toEqual(['Reading your idea…', 'Building the world…']);
  });

  it('opravné kolo ohlásí opravu a po záplatě znovu kontrolu', async () => {
    const steps = await stepsWhile('a fox runs and sings', [answered(runner('fox', 'forest')), answered([{ op: 'replace', path: '/title', value: 'Singing Fox' }])], 1);
    const fixing = steps.indexOf('Fixing one thing…');
    expect(fixing).toBeGreaterThan(steps.indexOf('Checking it can be won…'));
    expect(steps.lastIndexOf('Checking it can be won…')).toBeGreaterThan(fixing);
  });
});

describe('picksOf – soupeř', () => {
  const spec = (...roles: [string, string][]) =>
    ({ roles: roles.map(([kind, label]) => ({ kind, label })), theme: { setting: 'mossy hill' }, tutorial: { controlsHint: 'Drag to aim.' } }) as unknown as GameSpecV1;
  const rival = (value: GameSpecV1) => picksOf(value).find((step) => step.kind === 'rival');

  it('branka, do které se míří, soupeř není; šiška, které se uhýbá, ano (oracle T5: „Rival: goal“)', () => {
    expect(rival(spec(['player', 'hedgehog'], ['target', 'goal'], ['hazard', 'pinecone']))).toEqual({ kind: 'rival', value: 'pinecone' });
    expect(rival(spec(['player', 'keeper'], ['target', 'jellyfish']))).toBeUndefined();
  });

  it('kdo honí, má přednost před tím, čemu se uhýbá', () => {
    expect(rival(spec(['player', 'fox'], ['hazard', 'log'], ['chaser', 'bear']))).toEqual({ kind: 'rival', value: 'bear' });
  });
});

describe('recordStep – záznam kroků práce', () => {
  const pick = (kind: 'hero' | 'place', value: string): DirectorStep => ({ kind, value });

  it('jen přibývá: čtení a volby jednou, stejný krok hned po sobě jednou, kontrola po opravě znovu', () => {
    for (const step of [{ kind: 'reading' }, { kind: 'directing' }, pick('hero', 'fox'), { kind: 'checking' }, { kind: 'checking' }, { kind: 'fixing' }, pick('hero', 'fox'), { kind: 'checking' }, { kind: 'reading' }, { kind: 'directing' }, pick('hero', 'wolf')] as DirectorStep[]) recordStep('upgrade:a', step);
    expect(stepsOf('upgrade:a')).toEqual(['Reading your idea…', 'Building the world…', 'Hero: fox', 'Checking it can be won…', 'Fixing one thing…', 'Checking it can be won…', 'Hero: wolf']);
    expect(stepsOf('upgrade:b')).toEqual([]);
  });

  it(`nejvýš ${String(MAX_STEPS)} kroků na práci`, () => {
    for (let round = 0; round < 40; round += 1) {
      recordStep('upgrade:a', { kind: 'fixing' });
      recordStep('upgrade:a', { kind: 'checking' });
    }
    expect(stepsOf('upgrade:a')).toHaveLength(MAX_STEPS);
  });
});
