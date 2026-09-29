'use client';

/**
 * „About this game“ (P33 T7): jediný info prvek nad hrou. Řádek-tlačítko
 * otevře list se třemi oddíly – co z věty vzniklo a kdo to navrhl, jak se
 * hraje (`HowItWorks`) a odkud hra pochází (`Lineage`); ty dva zapíšou svůj
 * obsah přes `InfoContext`. Návrh ze slov se hlásí jako rychlá verze, nikdy
 * jako AI (`authorshipOf`). Fakta skládá server (`lab.ts`).
 */

import { useState } from 'react';

import type { Authorship, ReadFacts } from './lab';
import { Icon, Sheet } from './ui';
import { useInfoParts } from './ui/InfoContext';

const BY: Readonly<Record<Authorship, string>> = {
  ai: 'AI version of your sentence',
  draft: 'Quick version from your sentence',
  remix: 'Remixed with one change',
};

/** Návrh, jehož větu přečetl lokální model (P29B T6) – pořád rychlá verze, ne hra od AI. */
const READ_BY_MODEL = 'Quick version read by a local AI model';

/** Oddíl „Your sentence“: kdo hru navrhl, věta a co si z ní vzal. */
export function ReadSection({ read }: { readonly read: ReadFacts }) {
  const by = read.authorship === 'draft' && read.readBy === 'model' ? READ_BY_MODEL : BY[read.authorship];
  const rows: readonly (readonly [string, string])[] = [
    ['Game', read.game],
    ['World', read.world],
    ...(read.you === null ? [] : [['You are', read.you] as const]),
    ...(read.against.length === 0 ? [] : [['Against', read.against.join(', ')] as const]),
    ['Goal', read.goal],
    ['Rules', read.rules.join(', ')],
  ];
  return (
    <section className="play-info-part play-read" data-testid="play-read" data-authorship={read.authorship} data-read-by={read.readBy}>
      <h3 className="play-info-heading">Your sentence</h3>
      <p className="play-read-by" data-testid="play-read-by">
        <span className={`play-read-by-${read.authorship}`}>{by}</span>
        {read.sentence !== null && <span className="play-read-sentence"> “{read.sentence}”</span>}
      </p>
      <dl className="play-read-rows">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {read.authorship === 'draft' && (
        <p className="play-read-note">When the AI is online it rewrites this quick version; the new one appears as a button.</p>
      )}
    </section>
  );
}

export function SentenceRead({ read }: { readonly read: ReadFacts }) {
  const [open, setOpen] = useState(false);
  const parts = useInfoParts();
  return (
    <>
      <button type="button" className="play-lab play-info" data-testid="play-info" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="info" />
        About this game
      </button>
      <Sheet open={open} title="About this game" onClose={() => setOpen(false)} className="play-info-sheet">
        <ReadSection read={read} />
        {parts.how !== undefined && (
          <section className="play-info-part" data-testid="play-lab">
            <h3 className="play-info-heading">How to play</h3>
            {parts.how}
          </section>
        )}
        {parts.lineage}
      </Sheet>
    </>
  );
}
