import { notFound } from 'next/navigation';

import { VERSION_ID_PATTERN } from '@/app/api/play/_errors';
import { PlayShell } from '@/components/play/PlayShell';
import { versionStoreFromEnv } from '@/play/version';

/**
 * `/play/[id]` – PLAY shell. Hra se čte z úložiště verzí **přímo**, ne přes
 * `GET /api/play/games/:id`: stránka běží v témž procesu jako dveře a HTTP
 * volání sebe sama by jen přidalo bránu stropu na cestu, kterou žádný cizí
 * volající nejde. Neznámé i tvarově špatné id končí stejně – `notFound()`.
 */
export default async function PlayGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!VERSION_ID_PATTERN.test(id)) notFound();
  const game = await versionStoreFromEnv(process.env).get(id);
  if (game === null) notFound();
  return <PlayShell versionId={game.version.versionId} spec={game.spec} blueprint={game.blueprint} />;
}
