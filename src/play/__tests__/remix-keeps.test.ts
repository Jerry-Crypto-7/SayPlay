/**
 * Stráž remixu vlastní větou (P27C T4): dítě smí změnit ovládání, cíl nebo
 * hrdinu jen tehdy, když o to věta výslovně žádá. `describeRemix` dá hráči
 * lidský seznam změněných částí.
 */

import { createPatch } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import chaseEscape from '@/play/__fixtures__/chase_escape.json';
import platform from '@/play/arcade/__fixtures__/platform.json';
import runner from '@/play/arcade/__fixtures__/runner.json';
import { describeRemix, remixKeeps } from '@/play/director/remix';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

function specOf(fixture: unknown): GameSpecV1 {
  const read = readGameSpec(fixture);
  if (!read.ok) throw new Error(read.reason);
  return read.value;
}

const chase = specOf(chaseEscape);
const run = specOf(runner);

function edited(spec: GameSpecV1, edit: (copy: GameSpecV1) => void): GameSpecV1 {
  const copy = JSON.parse(JSON.stringify(spec)) as GameSpecV1;
  edit(copy);
  return copy;
}

describe('remixKeeps', () => {
  it('změna prostředí a rychlosti nepřítele projde bez žádosti o ovládání', () => {
    expect(remixKeeps(chase, edited(chase, (c) => void (c.theme.setting = 'snowy supermarket')), 'add snow')).toBe(true);
    expect(remixKeeps(chase, edited(chase, (c) => void ((c.mechanics[0].params as { speed: string }).speed = 'fast')), 'make enemies faster')).toBe(true);
  });

  it('pořadí klíčů není změna', () => {
    const reversed = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(reversed) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)])) : value;
    expect(remixKeeps(chase, reversed(chase) as GameSpecV1, 'add snow')).toBe(true);
  });

  it('control change without asking → false; se slovesem ovládání projde', () => {
    const child = edited(run, (c) => {
      c.control = 'platform';
      c.controlParams = platform.controlParams as GameSpecV1['controlParams'];
    });
    expect(remixKeeps(run, child, 'add snow')).toBe(false);
    expect(remixKeeps(run, child, 'make it a platformer')).toBe(true);
  });

  it('přidaný doplněk je změna ovládání', () => {
    expect(remixKeeps(run, edited(run, (c) => void (c.addons = ['shoot'])), 'add snow')).toBe(false);
  });

  it('změna cíle bez slova cíle → false; se slovem cíle projde', () => {
    const child = edited(chase, (c) => void (c.objective = { ...c.objective, role: 'cart' }));
    expect(remixKeeps(chase, child, 'add snow')).toBe(false);
    expect(remixKeeps(chase, child, 'the goal is the cart instead')).toBe(true);
  });

  it('odebraný nebo změněný keypoint rodiče je změna cíle; přidaný ne', () => {
    expect(remixKeeps(chase, edited(chase, (c) => void c.verification.shift()), 'add snow')).toBe(false);
    expect(remixKeeps(chase, edited(chase, (c) => void (c.verification[1] = { ...c.verification[1], assert: { runState: 'lost' } } as GameSpecV1['verification'][number])), 'add snow')).toBe(false);
    expect(remixKeeps(chase, edited(chase, (c) => void c.verification.push({ id: 'extra', kind: 'reachability', assert: { runState: 'won' } } as GameSpecV1['verification'][number])), 'add snow')).toBe(true);
  });

  it('jiný hrdina bez žádosti → false; „play as“ projde', () => {
    const child = edited(chase, (c) => void (c.roles[0].label = 'cat'));
    expect(remixKeeps(chase, child, 'add snow')).toBe(false);
    expect(remixKeeps(chase, child, 'enemies chase the player faster')).toBe(false);
    expect(remixKeeps(chase, child, 'let me play as a cat')).toBe(true);
  });

  it('druhá role hráče je jiný hrdina (revize T4, nález 4)', () => {
    const child = edited(chase, (c) => void c.roles.push({ id: 'twin', kind: 'player', label: 'hamster', count: 1 } as GameSpecV1['roles'][number]));
    expect(remixKeeps(chase, child, 'add snow')).toBe(false);
  });

  it('sloveso ovládání nepustí změnu cíle ani hrdiny (revize T4, nález 4)', () => {
    const sentence = 'make enemies shoot fireballs';
    const goal = edited(chase, (c) => void (c.objective = { ...c.objective, role: 'cart' }));
    const hero = edited(chase, (c) => void (c.roles[0].label = 'cat'));
    expect(remixKeeps(chase, goal, sentence)).toBe(false);
    expect(remixKeeps(chase, hero, sentence)).toBe(false);
  });
});

describe('describeRemix', () => {
  it('prostředí, parametr mechaniky a počet role po lidsku', () => {
    const child = edited(chase, (c) => {
      c.theme.setting = 'snowy supermarket';
      (c.mechanics[0].params as { speed: string }).speed = 'fast';
      c.roles[3].count = 5;
      c.tutorial.goalLine = 'Run!';
    });
    expect(describeRemix(chase, createPatch(chase, child))).toEqual(['setting', 'chaser speed', 'number of shopping carts']);
  });

  it('parametr ovládání arkády nese své jméno', () => {
    const child = edited(run, (c) => void ((c.controlParams as { speed: string }).speed = 'fast'));
    expect(describeRemix(run, createPatch(run, child))).toEqual(['speed']);
  });
});
