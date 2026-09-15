'use client';

/**
 * `/target` — brána K0. Ručně napsaný cílový snímek, na který musí produkt dosáhnout.
 *
 * Stránka je schválně holá: celý výřez je plátno, žádná hlavička, žádný dok,
 * žádný odkaz zpět. Rozhoduje se tu o jediné otázce — *stojí ten svět za to,
 * aby ho někdo navštívil?* — a cokoliv kolem plátna by na tu otázku odpovídalo
 * za obraz.
 *
 * `ssr: false` není kosmetika: `<Canvas>` potřebuje WebGL kontext a ten na
 * serveru neexistuje. Táž cesta jako `EmbedView`.
 */

import dynamic from 'next/dynamic';

const TargetFrame = dynamic(() => import('@/components/viewer/TargetFrame'), { ssr: false });

export default function TargetPage() {
  return (
    <main style={{ height: '100dvh', width: '100vw', overflow: 'hidden' }} data-testid="target-root">
      <TargetFrame />
    </main>
  );
}
