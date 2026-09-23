/**
 * Proužek rodokmenu (P23-C T6): odkud hra pochází a kolik remixů z ní vzešlo.
 *
 * `lineage` je uložený při publikaci, od kořene k listu, a poslední záznam je
 * tahle hra – rodič je tedy předposlední. Počet dětí se čte při načtení
 * stránky; na hraně smí být o chvíli pozadu, je to navigace, ne pravda o hře.
 */

import Link from 'next/link';

import type { GameVersion } from '@/play/contracts';

/** `aiVersion`: hra je vylepšení návrhu od AI (`relation: 'upgrade'`), ne remix hráče (P26 T8). */
export function Lineage({ lineage, remixes, aiVersion = false }: { readonly lineage: readonly GameVersion[]; readonly remixes: number; readonly aiVersion?: boolean }) {
  const parent = lineage.length >= 2 ? lineage[lineage.length - 2] : null;
  return (
    <p className="play-lineage" data-testid="play-lineage">
      {parent === null ? (
        <span>Original</span>
      ) : (
        <span>
          {aiVersion ? 'AI version of' : 'Remixed from'} <Link href={`/play/${parent.versionId}`}>{parent.title}</Link>
        </span>
      )}
      {remixes > 0 && <span className="play-lineage-count">{remixes === 1 ? '1 remix' : `${remixes} remixes`}</span>}
    </p>
  );
}
