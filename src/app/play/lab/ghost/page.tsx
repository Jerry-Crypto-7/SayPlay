import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { VERSION_ID_PATTERN } from '@/app/api/play/_errors';
import { DARE_ID_PATTERN } from '@/play/version';

import { GhostLab } from './GhostLab';

/**
 * `/play/lab/ghost?game=<id>&dare=<dareId>` – zkušební scéna ducha (P37C T3):
 * duch uložené výzvy závodí vedle ukázky robota, sonda vystaví jeho póze po
 * ticích a konec přehrání pro e2e `p37c-ghost`. Hra se nezapojuje do
 * `ArcadePlay.tsx` (to dělá P37B). Mimo vývoj jen s `PLAY_LAB=1`, jinak 404 –
 * porotce na ni nemá narazit.
 */
export default async function GhostLabPage({ searchParams }: { readonly searchParams: Promise<{ readonly game?: string; readonly dare?: string }> }) {
  await connection();
  if (process.env.NODE_ENV === 'production' && process.env.PLAY_LAB !== '1') notFound();
  const { game, dare } = await searchParams;
  if (game === undefined || dare === undefined || !VERSION_ID_PATTERN.test(game) || !DARE_ID_PATTERN.test(dare)) notFound();
  return <GhostLab game={game} dare={dare} />;
}
