import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import index from '../../../assets/catalog-index.json';
import disclosure from '../../../../disclosure.json';
import { heroChoice, modelOf } from '../../arcade/models';

/**
 * Knihovna P62 T2: nepřátelé a předměty, které dřív kreslila náhrada (gepard kočkou, rampouch
 * krápníkem ze země, šiška dopravním kuželem), mají vlastní model a vojáka jmenují i „sentry“ a „marine“.
 * Náhrada vypadá na snímku jako model, proto test nečte „nějaký model“, ale identitu: model nese
 * slovo věty jako vlastní štítek katalogu a výběr postavy ho bere na úrovni `identity`, ne `near`,
 * `class` ani `fallback`.
 */

const GENERATED = 'LicenseRef-Worldsmith-Generated';

/** Slovo věty → vlastní model. Víceslovné tvary a množné číslo jdou stejnou cestou jako věta. */
const PROMOTED: ReadonlyArray<readonly [noun: string, model: string]> = [
  ['cheetah', 'gen3d-cheetah'],
  ['cheetahs', 'gen3d-cheetah'],
  ['snowplow', 'gen3d-snowplow'],
  ['snow plow', 'gen3d-snowplow'],
  ['firecracker', 'gen3d-firecracker'],
  ['pinecone', 'gen3d-pinecone'],
  ['pine cone', 'gen3d-pinecone'],
  ['termite', 'gen3d-termite'],
  ['termites', 'gen3d-termite'],
  ['stalactite', 'gen3d-stalactite'],
];

const tagsOf = (id: string): readonly string[] => index.assets.find((asset) => asset.assetId === id)?.tags ?? [];
const soldier = modelOf('soldier', true);

describe('P62 library models', () => {
  it.each(PROMOTED)('"%s" is drawn by its own model %s, not a stand-in', (noun, model) => {
    expect(modelOf(noun, true)).toBe(model);
    expect(modelOf(noun, false)).toBe(model);
    expect(heroChoice(noun, undefined, undefined, 'enemy')).toMatchObject({ model, level: 'identity' });
  });

  it.each([
    ['sentry', 'sentry'],
    ['sentries', 'sentry'],
    ['marine', 'marine'],
    ['marines', 'marine'],
  ])('"%s" is the soldier model under its own tag "%s"', (noun, tag) => {
    expect(soldier).toBe('gen3d-guard');
    expect(modelOf(noun, true)).toBe(soldier);
    expect(tagsOf(soldier!)).toContain(tag);
    expect(heroChoice(noun, undefined, undefined, 'enemy')).toMatchObject({ model: soldier, level: 'identity' });
  });

  it('ships both LODs of every promoted model with a first-party generated disclosure record', () => {
    const records = new Map(disclosure.entries.filter((entry) => entry.kind === 'asset').map((entry) => [entry.name, entry]));
    for (const model of new Set(PROMOTED.map(([, id]) => id))) {
      const lod1 = index.assets.find((asset) => asset.assetId === model)?.path;
      expect(lod1, model).toMatch(new RegExp(`/${model}-lod1\\.glb$`));
      for (const file of [lod1!.replace('-lod1.glb', '-lod0.glb'), lod1!].map((url) => `public${url}`)) {
        expect(existsSync(file), file).toBe(true);
        expect(records.get(file), file).toMatchObject({ license: GENERATED, firstParty: true });
      }
    }
  });
});
