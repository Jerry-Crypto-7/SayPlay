'use client';

/**
 * Remixy hry (P44B T11): v listu „About this game“ pod řetězem předků odkazy na nejnovější
 * remixy s čipy rozdílu a nejlepším hráčem **jejich** žebříčku („Top: Ada 2,450“). Čte
 * `GET /api/play/games/:id/remixes`; bez remixů, nebo když čtení selže, oddíl chybí.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ARCADE_HZ } from '@/play/arcade/contract';

import { clockText } from './ui/GameHud';

export interface RemixRow {
  readonly versionId: string;
  readonly title: string;
  readonly chips: readonly string[];
  readonly top: { readonly nickname: string; readonly score: number; readonly ticks: number } | null;
}

/** „Top: Ada 2,450“; běh bez bodů svým časem („Top: Ada 31.0s“) – jako cíl výzvy (`dareGoal`). */
export function topText(top: NonNullable<RemixRow['top']>): string {
  return `Top: ${top.nickname} ${top.score > 0 ? top.score.toLocaleString('en-US') : clockText(top.ticks / ARCADE_HZ)}`;
}

export function RemixList({ remixes }: { readonly remixes: readonly RemixRow[] }) {
  if (remixes.length === 0) return null;
  return (
    <span className="play-remix-chain" data-testid="play-remix-chain">
      <span className="play-remix-chain-title">Remixes</span>
      {remixes.map((remix) => (
        <span key={remix.versionId} className="play-remix-chain-row">
          <Link href={`/play/${remix.versionId}`}>{remix.title}</Link>
          {remix.chips.map((chip) => (
            <span key={chip} className="sp-chip">
              {chip}
            </span>
          ))}
          {remix.top !== null && <span className="play-remix-chain-top">{topText(remix.top)}</span>}
        </span>
      ))}
    </span>
  );
}

export function RemixChain({ versionId }: { readonly versionId: string }) {
  const [remixes, setRemixes] = useState<readonly RemixRow[]>([]);
  useEffect(() => {
    const control = new AbortController();
    fetch(`/api/play/games/${versionId}/remixes`, { signal: control.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { remixes: RemixRow[] }).remixes : []))
      .then(setRemixes)
      // Bez řetězu remixů rodokmen pořád řekne, kolik jich je.
      .catch(() => undefined);
    return () => control.abort();
  }, [versionId]);
  return <RemixList remixes={remixes} />;
}
