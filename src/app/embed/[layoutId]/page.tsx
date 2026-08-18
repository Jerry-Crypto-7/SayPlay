import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { LAYOUTS, layoutById } from '@/kit';

import EmbedView from './EmbedView';
import { siteUrlFrom } from './site-url';

/**
 * `/embed/<layoutId>` — svět bez okolní stránky, k vložení do iframe.
 *
 * Je to cesta, kterou se demo dostane do cizí stránky (přihláška, článek,
 * příspěvek), takže tu není hlavička ani navigace: celý výřez je plátno.
 * Náhled odkazu kreslí `/api/og`, protože bez `og:image` se ze sdíleného
 * odkazu stane šedý obdélník.
 *
 * Neznámý layout je **404**, ne tichý pád na první: odkaz s překlepem má
 * odpovědět, že takový svět není, ne ukázat cizí.
 */

/** Adresa pro `og:image`. Pořadí a jeho důvod jsou v `site-url.ts`. */
async function siteUrl(): Promise<string> {
  return siteUrlFrom(process.env, await headers());
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ layoutId: string }>;
}): Promise<Metadata> {
  const { layoutId } = await params;
  const layout = layoutById(layoutId);
  if (layout === undefined) return { title: 'worldsmith' };

  return {
    metadataBase: new URL(await siteUrl()),
    title: `${layout.title} — worldsmith`,
    openGraph: {
      title: layout.title,
      description: 'A sentence in, a playable 3D world out.',
      images: [{ url: `/api/og?layout=${layout.id}`, width: 1200, height: 630, type: 'image/png' }],
    },
  };
}

/**
 * `?emit=<promptId>` zapne kanál s průběhem emise. Bez něj embed jen ukazuje
 * svět — vyvolávat emisi z každého vloženého rámu by znamenalo, že cizí stránka
 * spustí náš řetěz jen tím, že se načte.
 */
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ layoutId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { layoutId } = await params;
  if (layoutById(layoutId) === undefined) notFound();

  const requested = (await searchParams).emit;
  const promptId = typeof requested === 'string' && requested !== '' ? requested : null;

  // Vyžádaný svět jde první, zbytek za ním — přepínání tak má kam jít a začíná
  // se tam, kam odkaz mířil.
  const layouts = [layoutId, ...LAYOUTS.map((layout) => layout.id).filter((id) => id !== layoutId)];

  return (
    <main style={{ height: '100dvh', width: '100vw' }} data-testid="embed-root" data-layout={layoutId}>
      <EmbedView layouts={layouts} promptId={promptId} />
    </main>
  );
}
