import { describe, expect, it } from 'vitest';

import forward from '../p32-forward.json';
import { catalogEntries } from '../p32-manifest.mjs';

const asset = (assetId: string, tags: string[]) => ({
  assetId,
  tags,
  path: `/assets/worldstream/gen3d/${assetId}-lod1.glb`,
  bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
});

const inputs = (assets: ReturnType<typeof asset>[], handClasses: Record<string, string>) => ({
  catalog: { assets },
  rigged: { characters: [] },
  disclosure: { entries: assets.map((entry) => ({ name: `public${entry.path}`, license: 'CC0-1.0' })) },
  forward,
  handClasses,
});

const classes = (entries: { id: string; class: string }[]) => Object.fromEntries(entries.map((entry) => [entry.id, entry.class]));

describe('hero manifest class (P45I T2)', () => {
  it('a hand-set prop is no hero whatever word of a class its name carries', () => {
    const assets = [asset('gen3d-dog-kennel', ['dog kennel']), asset('gen3d-car-jack', ['car jack']), asset('gen3d-wall-sign', ['wall sign'])];
    const hand = { 'gen3d-dog-kennel': 'prop', 'gen3d-car-jack': 'prop', 'gen3d-wall-sign': 'flat' };
    expect(catalogEntries(inputs(assets, hand))).toEqual([]);
  });

  it('a name without a hand-set record keeps the class of its words', () => {
    const assets = [asset('gen3d-dog-kennel', ['dog kennel']), asset('gen3d-car-jack', ['car jack'])];
    expect(classes(catalogEntries(inputs(assets, {})))).toEqual({ 'gen3d-dog-kennel': 'animal', 'gen3d-car-jack': 'vehicle' });
  });

  it('a hand-set body class leaves the finer manifest class to the words', () => {
    const assets = [asset('gen3d-sailboat', ['sailboat']), asset('gen3d-hearse', ['hearse'])];
    const hand = { 'gen3d-sailboat': 'vehicle', 'gen3d-hearse': 'vehicle' };
    expect(classes(catalogEntries(inputs(assets, hand)))).toEqual({ 'gen3d-sailboat': 'boat' });
  });

  it('reads the hand-set classes of the gen3d noun lists by default', () => {
    const assets = [asset('gen3d-dog-kennel', ['dog kennel', 'seen:doghouse']), asset('gen3d-wizard-tower', ['wizard tower'])];
    const { handClasses: _ignored, ...withoutHand } = inputs(assets, {});
    expect(catalogEntries(withoutHand)).toEqual([]);
  });
});
