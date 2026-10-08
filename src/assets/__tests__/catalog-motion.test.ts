import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { catalogHash } from '../../../scripts/p45d/motion-class.mjs';
import catalog from '../catalog.json';
import motion from '../catalog-motion.json';

/**
 * Třída těla každého modelu (P45D T2). Špatná třída v JSON vypadá správně a v obraze
 * ryba „chodí“ – proto zlatý seznam napsaný dřív než skript, ručně podle toho, čím model je.
 */
const GOLDEN: Readonly<Record<string, string>> = {
  'cc0-corgi': 'quadruped',
  cat: 'quadruped',
  dog: 'quadruped',
  fox: 'quadruped',
  'cc0-elephant': 'quadruped',
  'cc0-giraffe': 'quadruped',
  'gen3d-horse': 'quadruped',
  'cc0-pigeon': 'flyer',
  'cc0-bee': 'flyer',
  'cc0-dragon': 'flyer',
  'gen3d-flying-bat': 'flyer',
  'gen3d-parrot': 'flyer',
  plane: 'flyer',
  'cc0-shark': 'swimmer',
  'cc0-clownfish': 'swimmer',
  'cc0-piranha': 'swimmer',
  'gen3d-octopus': 'swimmer',
  'gen3d-snake': 'swimmer',
  'gen3d-whale': 'swimmer',
  'race-car': 'vehicle',
  'cc0-bus': 'vehicle',
  'rowing-boat': 'vehicle',
  explorer: 'biped',
  'cc0-zombie': 'biped',
  robot: 'biped',
  'gen3d-witch': 'biped',
  knight: 'biped',
  'panel-door': 'prop',
  'cc0-apple': 'prop',
  'cc0-pancake': 'prop',
};

type Entry = { class: string; parts?: { id: string; node: string; role: string; pivot: number[] }[]; regions?: Record<string, number> };
const models = motion.models as Record<string, Entry>;

describe('catalog-motion.json (P45D T2)', () => {
  it('has an entry for every catalog model and matches the current catalog', () => {
    // Čerstvost: po povýšení nových modelů zčervená, dokud se `scripts/p45d/motion-class.mjs` nepustí znovu.
    expect(motion.catalogHash).toBe(catalogHash(catalog));
    const missing = catalog.assets.map((asset) => asset.assetId).filter((id) => models[id] === undefined);
    expect(missing).toEqual([]);
    expect(Object.keys(models)).toHaveLength(catalog.assets.length);
  });

  it.each(Object.entries(GOLDEN))('gives %s the body class %s', (id, expected) => {
    expect(models[id]?.class).toBe(expected);
  });

  it('keeps the panel door leaf with the pivot from the catalog', () => {
    const leaf = catalog.assets.find((asset) => asset.assetId === 'panel-door')?.parts.find((part) => part.id === 'leaf');
    expect(models['panel-door']?.parts).toContainEqual({ id: 'leaf', node: leaf?.node, role: 'door', pivot: leaf?.pivot });
  });

  it('puts wings only on flyers that flap, tails on animals and fish, and nothing on vehicles', () => {
    expect(models['cc0-pigeon']?.regions?.wingX).toBeGreaterThan(0);
    expect(models.plane?.regions?.wingX).toBeUndefined();
    expect(models['cc0-shark']?.regions?.tailZ).toBeLessThan(0);
    expect(models.dog?.regions?.legY).toBeGreaterThan(0);
    expect(models['race-car']?.regions).toBeUndefined();
  });

  it('stays small enough to ship to the browser', () => {
    expect(statSync(fileURLToPath(new URL('../catalog-motion.json', import.meta.url))).size).toBeLessThanOrEqual(120 * 1024);
  });
});
