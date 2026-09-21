import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { VERSION_ID_PATTERN } from '@/app/api/play/_errors';
import { admit } from '@/app/api/play/_publish';
import { labFacts } from '@/components/play/lab';
import { PlayShell } from '@/components/play/PlayShell';
import type { GameVersion } from '@/play/contracts';
import { type PublishedGame, versionStoreFromEnv } from '@/play/version';

type Params = { params: Promise<{ id: string }> };

/**
 * `/play/[id]` – PLAY shell. Hra se čte z úložiště verzí **přímo**, ne přes
 * `GET /api/play/games/:id`: stránka běží v témž procesu jako dveře a HTTP
 * volání sebe sama by jen přidalo bránu stropu na cestu, kterou žádný cizí
 * volající nejde. Neznámé i tvarově špatné id končí stejně – `notFound()`.
 * Žádné přihlášení ani krok „create“: sdílený odkaz jde rovnou do hry.
 */
type Loaded =
  | { readonly kind: 'refused' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'game'; readonly game: PublishedGame; readonly children: readonly string[]; readonly lineage: readonly GameVersion[] };

/**
 * Jedno načtení na požadavek, sdílené metadaty i stránkou (`cache` z Reactu).
 *
 * Stránka je veřejné čtení stejně jako `GET /api/play/games/:id`, a proto má
 * tytéž brány: páku `snapshots` a strop frekvence na dveřích `play` (nález
 * revize fáze 4, 21. 9. 2026 – bez nich šla smyčka nad `/play/<hex>` točit
 * placená čtení úložiště bez meze a vypínač ji nezastavil). Brána se ptá na
 * `Request` složený z hlaviček, aby klíč stropu vznikal týmž kódem jako u dveří.
 */
const load = cache(async (id: string): Promise<Loaded> => {
  const refused = await admit(new Request('http://play.invalid/', { headers: await headers() }), 'snapshots');
  if (refused !== null) return { kind: 'refused' };
  if (!VERSION_ID_PATTERN.test(id)) return { kind: 'missing' };
  const versions = versionStoreFromEnv(process.env);
  const game = await versions.get(id);
  if (game === null) return { kind: 'missing' };
  const [children, lineage] = await Promise.all([versions.childrenOf(id), versions.lineageOf(id)]);
  return { kind: 'game', game, children, lineage };
});

/**
 * Náhled odkazu. `og:image` musí být absolutní adresa a kořenový layout
 * `metadataBase` nemá (a sahat na něj tenhle plán nesmí), proto se základ
 * skládá z hlaviček požadavku – na Vercelu i lokálně je to adresa, na kterou
 * se právě někdo díval.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const loaded = await load(id);
  if (loaded.kind !== 'game') return { title: 'WORLDSTREAM PLAY' };
  const { game } = loaded;
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
  const loaded = await load(id);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'refused') {
    return (
      <main className="play-create">
        <p className="play-alert" role="alert" data-testid="play-busy">PLAY is busy right now. Try again in a moment.</p>
      </main>
    );
  }
  const { game, children, lineage } = loaded;
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
      upgrade={game.origin !== undefined && game.relation === undefined ? `/api/play/games/${game.version.versionId}/upgrade` : null}
    />
  );
}
