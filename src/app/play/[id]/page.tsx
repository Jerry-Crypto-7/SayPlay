import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { VERSION_ID_PATTERN } from '@/app/api/play/_errors';
import { labFacts } from '@/components/play/lab';
import { PlayShell } from '@/components/play/PlayShell';
import { versionStoreFromEnv } from '@/play/version';

type Params = { params: Promise<{ id: string }> };

/**
 * `/play/[id]` – PLAY shell. Hra se čte z úložiště verzí **přímo**, ne přes
 * `GET /api/play/games/:id`: stránka běží v témž procesu jako dveře a HTTP
 * volání sebe sama by jen přidalo bránu stropu na cestu, kterou žádný cizí
 * volající nejde. Neznámé i tvarově špatné id končí stejně – `notFound()`.
 * Žádné přihlášení ani krok „create“: sdílený odkaz jde rovnou do hry.
 */
async function load(id: string) {
  if (!VERSION_ID_PATTERN.test(id)) return null;
  return versionStoreFromEnv(process.env).get(id);
}

/**
 * Náhled odkazu. `og:image` musí být absolutní adresa a kořenový layout
 * `metadataBase` nemá (a sahat na něj tenhle plán nesmí), proto se základ
 * skládá z hlaviček požadavku – na Vercelu i lokálně je to adresa, na kterou
 * se právě někdo díval.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const game = await load(id);
  if (game === null) return { title: 'Game not found – WORLDSTREAM PLAY' };
  const incoming = await headers();
  const host = incoming.get('x-forwarded-host') ?? incoming.get('host') ?? 'localhost';
  const proto = incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  const title = `${game.spec.title} – WORLDSTREAM PLAY`;
  const description = game.spec.tutorial.goalLine;
  const image = `${proto}://${host}/api/play/games/${id}/og`;
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function PlayGamePage({ params }: Params) {
  const { id } = await params;
  const game = await load(id);
  if (game === null) notFound();
  const versions = versionStoreFromEnv(process.env);
  const [children, lineage] = await Promise.all([versions.childrenOf(id), versions.lineageOf(id)]);
  // `key`: přechod na remix je klientská navigace a nová hra musí dostat nový runtime, ne ten rodičův.
  return (
    <PlayShell
      key={game.version.versionId}
      versionId={game.version.versionId}
      spec={game.spec}
      blueprint={game.blueprint}
      lineage={lineage.length > 0 ? lineage : [game.version]}
      remixes={children.length}
      lab={labFacts(game.spec, game.report)}
    />
  );
}
