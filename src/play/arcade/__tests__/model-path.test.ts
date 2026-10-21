/**
 * Cesta ke GLB nikdy nenese předponu riggované postavy (P56B T3). Audit 21. 10.: 19× 404
 * na `/assets/worldstream/game/rigged:*-lod1.glb` – chybějící model se kreslí jako
 * náhradní kvádr a hra jinak běží, takže na pohled to nikdo nepozná.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BASE_ENTRIES } from '../../assets/entries/base';
import { CATALOG_ENTRIES } from '../../assets/entries/catalog';
import { RIGGED_P32_ENTRIES } from '../../assets/entries/rigged-p32';
import { RIGGED_P54_ENTRIES } from '../../assets/entries/rigged-p54';
import { modelPath, RIGGED_PREFIX } from '../models';

const PUBLIC = join(process.cwd(), 'public');
const ids = [...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES, ...RIGGED_P54_ENTRIES].map((entry) => entry.id);

describe('modelPath', () => {
  it.each(ids.flatMap((id) => [id, `${RIGGED_PREFIX}${id}`]))('%s resolves to a file on disk', (id) => {
    const path = modelPath(id);
    expect(path).not.toContain(RIGGED_PREFIX);
    expect(existsSync(join(PUBLIC, path)), path).toBe(true);
  });
});
