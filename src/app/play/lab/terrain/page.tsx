import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { type IslandSpot, platformIslands } from '@/components/play/arcade/look/rig/terrain/islands';
import platform from '@/play/arcade/__fixtures__/platform.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { LOOK_IDS } from '@/play/arcade/look';
import { readGameSpec } from '@/play/spec';

import { TerrainLab } from './TerrainLab';

/** Seznam i tady, ne z `TerrainLab`: hodnota z klientského modulu je v serverové komponentě jen odkaz. */
const KITS = ['islands', 'arena', 'water'] as const;

/**
 * `/play/lab/terrain?kit=islands|arena|water&look=<sada>` – galerie knihovny
 * terénu (P32A T9): jeden generátor pod rigem vzhledu v jedné sadě, e2e
 * `p32-terrain-gallery` ho vyfotí do `evals/play/p32/terrain/`. Ostrůvky stojí
 * na deskách skutečné úrovně plošinovky – překlad potřebuje `node:crypto`,
 * běží tady. Mimo vývoj jen s `PLAY_LAB=1`, jinak 404 – porotce na ni nemá narazit.
 */
export default async function TerrainLabPage({ searchParams }: { readonly searchParams: Promise<{ readonly kit?: string; readonly look?: string }> }) {
  await connection();
  if (process.env.NODE_ENV === 'production' && process.env.PLAY_LAB !== '1') notFound();
  const { kit, look } = await searchParams;
  const known = KITS.find((id) => id === kit);
  const lookId = LOOK_IDS.find((id) => id === look);
  if (known === undefined || lookId === undefined) notFound();
  let islands: IslandSpot[] = [];
  if (known === 'islands') {
    const spec = readGameSpec(platform);
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    const made = arcadeWorldOf(spec.value, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    islands = platformIslands(made.world);
  }
  return <TerrainLab kit={known} lookId={lookId} islands={islands} />;
}
