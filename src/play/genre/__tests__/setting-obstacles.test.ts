/**
 * Překážky podle prostředí (P46D T6): výchozí překážka běžce, bodák skákačky a zeď
 * okruhu patří k místu věty – v supermarketu vozík, v lese kmen, ve městě zábrana,
 * v poušti kaktus – a každá má model v katalogu. Místo bez vlastní překážky nechá dnešní.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LOOK_IDS } from '@/play/arcade/look';
import { modelOf, propModels } from '@/play/arcade/models';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { defaultFoe, defaultObstacle } from '../roles';

const CATALOG = new Set((JSON.parse(readFileSync('src/assets/catalog.json', 'utf8')) as { assets: { assetId: string }[] }).assets.map((asset) => asset.assetId));

const draft = (sentence: string): GameSpecV1 => draftGameSpecWithMeta(sentence, 1).spec;
const label = (spec: GameSpecV1, id: string): string | undefined => spec.roles.find((role) => role.id === id)?.label;

describe('překážky podle prostředí', () => {
  it('„Hamster escapes a supermarket Roomba“ nemá kámen: vozík ze supermarketu', () => {
    const spec = draft('Hamster escapes a supermarket Roomba');
    expect(spec.roles.map((role) => role.label)).not.toContain('rock');
    expect(label(spec, 'obstacle')).toBe('shopping cart');
    expect(propModels(spec).obstacle).toBe('shopping-cart');
  });

  it.each([
    ['A hamster runs through a supermarket', 'obstacle', 'shopping cart'],
    ['A fox runs through the forest', 'obstacle', 'log'],
    ['A kid runs through the city', 'obstacle', 'traffic barrier'],
    ['A lizard runs across the desert', 'obstacle', 'cactus'],
    ['A frog jumps across lily pads in the desert', 'spikes', 'cactus'],
    ['A frog jumps across lily pads in the forest', 'spikes', 'log'],
    ['A car races through the city', 'barrier', 'traffic barrier'],
    ['A car races through the forest', 'barrier', 'log'],
    ['A truck drives across the desert', 'barrier', 'cactus'],
    ['A kid drives a kart through the supermarket', 'barrier', 'shopping cart'],
  ])('%s → %s je %s s modelem z katalogu', (sentence, role, expected) => {
    const spec = draft(sentence);
    expect(label(spec, role)).toBe(expected);
    const model = propModels(spec)[role as keyof ReturnType<typeof propModels>];
    expect(model, sentence).toBeDefined();
    expect(CATALOG.has(model as string), `${sentence}: ${model}`).toBe(true);
  });

  it('každá překážka prostředí má model v katalogu', () => {
    const obstacles = LOOK_IDS.flatMap((look) => defaultObstacle({ setting: look, palette: look }) ?? []);
    expect(obstacles.length).toBeGreaterThanOrEqual(4);
    for (const obstacle of obstacles) expect(CATALOG.has(modelOf(obstacle, false) ?? ''), obstacle).toBe(true);
  });

  it('místo bez vlastní překážky nechá dnešní výchozí', () => {
    expect(label(draft('A fox runs through the meadow'), 'obstacle')).toBe('bee');
    expect(label(draft('A fox runs through the village'), 'obstacle')).toBe('rock');
    expect(label(draft('A frog jumps across the platforms in the meadow'), 'spikes')).toBe('spikes');
    expect(label(draft('A rocket races through outer space'), 'barrier')).not.toBe('cactus');
    // Nepřítel, který honí nebo se střílí, zůstává zvíře prostředí.
    expect(defaultFoe('dark forest', 'arena').label).toBe('wolf');
    expect(defaultFoe('dark forest', 'shooter').label).toBe('wolf');
  });
});
