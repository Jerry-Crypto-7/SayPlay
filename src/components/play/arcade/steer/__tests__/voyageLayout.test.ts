import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { compileGenre, readGenreSpec } from '@/play/genre/index';
import { voyageGenre } from '@/play/genre/voyage';

import { voyageLayoutOf } from '../voyageLayout';

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;

function worldOf(id: string) {
  const read = readGenreSpec(voyageGenre.draftFill(SENTENCES.find((entry) => entry.id === id)!.text, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  const made = arcadeWorldOf(compileGenre(read.value), 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('voyageLayoutOf (P32F T4)', () => {
  it('reads the pirate as a boat race between island banks, with gates, cannonballs and the treasure', () => {
    const layout = voyageLayoutOf(worldOf('pirate'))!;
    expect(layout).toMatchObject({ mode: 'race', terrain: 'islands', motion: 'boat' });
    expect(layout.course).toBeDefined();
    expect(layout.walls.length).toBeGreaterThan(4);
    // Každý mantinel stojí vnitřní hranou u osy úseku: levé vlevo, pravé vpravo.
    for (const wall of layout.walls) expect(Math.sign(wall.inner - wall.x)).toBe(-wall.side);
    expect(layout.gates.length).toBeGreaterThan(0);
    expect(layout.hazards.some((hazard) => hazard.kind === 'shot')).toBe(true);
    expect(layout.goal).not.toBeNull();
  });

  it('reads the rocket as a lander over a pad beside it', () => {
    const layout = voyageLayoutOf(worldOf('rocket'))!;
    expect(layout).toMatchObject({ mode: 'land', motion: 'lander', walls: [], gates: [] });
    expect(layout.pad).not.toBeNull();
    expect(layout.hero.y).toBeGreaterThan(30);
    expect(Math.abs(layout.pad!.x)).toBeGreaterThan(10);
  });

  it('reads the dog as a street race and leaves a plain race to the road', () => {
    expect(voyageLayoutOf(worldOf('dog'))).toMatchObject({ terrain: 'buildings', motion: 'vehicle' });
    const plain = readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/steer.json'), 'utf8');
    const made = arcadeWorldOf(JSON.parse(plain), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(voyageLayoutOf(made.world)).toBeNull();
  });
});
