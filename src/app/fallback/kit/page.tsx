import { LAYOUTS, defaultLayout } from '@/kit';

import KitLayoutView from './KitLayoutView';

/**
 * Náhled ručně skládaných layoutů. Je to oracle úlohy T201 — otázka „vykreslí
 * se to do prvního snímku bez síťového požadavku" nemá jinou odpověď než
 * skutečný prohlížeč nad skutečnou stránkou.
 */
export default async function KitLayoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams).layout;
  const layout =
    (typeof requested === 'string' ? LAYOUTS.find((item) => item.id === requested) : undefined) ??
    defaultLayout();

  return <KitLayoutView layoutId={layout.id} />;
}
