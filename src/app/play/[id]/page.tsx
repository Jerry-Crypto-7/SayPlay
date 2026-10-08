import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { VERSION_ID_PATTERN } from '@/app/api/play/_errors';
import { admit } from '@/app/api/play/_publish';
import { PrefetchPhysics } from '@/components/play/arcade/ArcadePlay';
import type { Dare } from '@/components/play/best';
import { authorshipOf, labFacts, readFacts } from '@/components/play/lab';
import { PlayShell } from '@/components/play/PlayShell';
import { worldHasPhysics } from '@/play/arcade/kernel';
import type { GameVersion } from '@/play/contracts';
import { type Honesty, sentenceOf, honestyOf } from '@/play/draft/unsupported';
import { shownNickname } from '@/play/player/nickname';
import { DARE_ID_PATTERN, type PublishedGame, versionStoreFromEnv } from '@/play/version';

type Params = { params: Promise<{ id: string }> };
type PageProps = Params & { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Výzva kamaráda z odkazu `?dare=` (P36B T7): výsledek, který server ověřil
 * přehráním. Jen výzva téhle hry; neplatné, cizí nebo prošlé id (i výpadek
 * úložiště – `getDare` vrací `null`) = obyčejná hra, žádná chyba. Výzva s autorem
 * nese jeho přezdívku (P44B T7) přes `shownNickname`; id hráče do props nejde.
 */
async function challengeOf(id: string, dare: string | string[] | undefined): Promise<Dare | null> {
  if (typeof dare !== 'string' || !DARE_ID_PATTERN.test(dare)) return null;
  const versions = versionStoreFromEnv(process.env);
  const record = await versions.getDare(dare);
  if (record === null || record.versionId !== id) return null;
  const challenge = { score: record.score, ticks: record.ticks, liveChanges: record.liveChanges };
  if (record.by === undefined) return challenge;
  return { ...challenge, by: shownNickname(record.by, (await versions.getPlayer(record.by))?.nickname) };
}

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
  | { readonly kind: 'game'; readonly game: PublishedGame; readonly children: readonly string[]; readonly lineage: readonly GameVersion[]; readonly honesty: Honesty | null; readonly sentence: string | null };

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
  const [children, lineage, sentence] = await Promise.all([versions.childrenOf(id), versions.lineageOf(id), sentenceOf(versions, game)]);
  const honesty = await honestyOf(versions, game);
  return { kind: 'game', game, children, lineage, honesty, sentence };
});

/**
 * Náhled odkazu. `og:image` musí být absolutní adresa a kořenový layout
 * `metadataBase` nemá (a sahat na něj tenhle plán nesmí), proto se základ
 * skládá z hlaviček požadavku – na Vercelu i lokálně je to adresa, na kterou
 * se právě někdo díval. Odkaz výzvy (`?dare=`) nese výsledek i do náhledu
 * (P36B T8); jestli výzva platí a patří téhle hře, rozhodne route `og`.
 */
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const { dare } = await searchParams;
  const loaded = await load(id);
  if (loaded.kind !== 'game') return { title: 'sayplay' };
  const { game } = loaded;
  const incoming = await headers();
  const host = incoming.get('x-forwarded-host') ?? incoming.get('host') ?? 'localhost';
  const proto = incoming.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  const title = `${game.spec.title} – sayplay`;
  const description = game.spec.tutorial.goalLine;
  const image = `${proto}://${host}/api/play/games/${id}/og${typeof dare === 'string' && DARE_ID_PATTERN.test(dare) ? `?dare=${dare}` : ''}`;
  return {
    title,
    description,
    // Obrázek je titulní obrázek z dat hry (P27B T6), ne snímek scény.
    openGraph: { title, description, type: 'website', images: [{ url: image, width: 1200, height: 630, alt: `${game.spec.title} – cover image` }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function PlayGamePage({ params, searchParams }: PageProps) {
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
  const { game, children, lineage, honesty, sentence } = loaded;
  // Arkádová hra (P25A) nese svět v `arcade` a `blueprint: null`; hra bez obojího nemá kde běžet.
  if (game.blueprint === null && game.arcade === undefined) notFound();
  // Výzvu nese jen arkáda (P36B T5) – mřížková hra odkaz s `dare=` otevře jako obyčejnou hru.
  const challenge = game.arcade === undefined ? null : await challengeOf(id, (await searchParams).dare);
  // `key`: přechod na remix je klientská navigace a nová hra musí dostat nový runtime, ne ten rodičův.
  // Rapier (P32D T4) se začne stahovat v renderu stránky, souběžně se scénou – hra bez těles ho nestáhne.
  return (
    <>
      <PrefetchPhysics needed={game.arcade !== undefined && worldHasPhysics(game.arcade)} />
      <PlayShell
        key={game.version.versionId}
        versionId={game.version.versionId}
        spec={game.spec}
        blueprint={game.blueprint}
        {...(game.arcade === undefined ? {} : { arcade: game.arcade })}
        lineage={lineage.length > 0 ? lineage : [game.version]}
        remixes={children.length}
        aiVersion={game.relation === 'upgrade'}
        lab={labFacts(game.spec, game.report)}
        read={readFacts(game.spec, authorshipOf(game), sentence, game.origin?.readBy ?? 'keywords')}
        honesty={honesty}
        upgrade={game.origin !== undefined && game.relation === undefined ? `/api/play/games/${game.version.versionId}/upgrade` : null}
        par={game.report.par ?? null}
        challenge={challenge}
      />
    </>
  );
}
