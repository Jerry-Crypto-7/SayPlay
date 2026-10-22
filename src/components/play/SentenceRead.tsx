'use client';

/**
 * „About this game“ (P33 T7): jediný info prvek hry, od P34 T5 tlačítko na
 * kartě pauzy. Otevře list se třemi oddíly – co z věty vzniklo a kdo to
 * navrhl, jak se hraje (`HowItWorks`) a odkud hra pochází (`Lineage`); ty dva
 * zapíšou svůj obsah přes `InfoContext`. Návrh ze slov se hlásí jako rychlá
 * verze, nikdy jako AI (`authorshipOf`). Fakta skládá server (`lab.ts`).
 */

import type { Authorship, ReadFacts } from './lab';
import { Button, Icon, Sheet } from './ui';
import { useInfoParts } from './ui/InfoContext';

const BY: Readonly<Record<Authorship, string>> = {
  ai: 'Full-detail version of your idea',
  draft: 'Quick version from your idea',
  remix: 'Remixed with one change',
};

/** Návrh, jehož větu přečetl model (P29B T6; od P56A T10 i Groq, ne jen lokální) – pořád rychlá verze, ne hra od AI. */
const READ_BY_MODEL = 'Quick version read by AI';

/** Oddíl „Your sentence“: kdo hru navrhl, věta a co si z ní vzal. */
export function ReadSection({ read }: { readonly read: ReadFacts }) {
  const by = read.authorship === 'draft' && read.readBy === 'model' ? READ_BY_MODEL : BY[read.authorship];
  const rows: readonly (readonly [string, string])[] = [
    ['Game', read.game],
    ['Setting', read.world],
    ...(read.you === null ? [] : [['You are', read.you] as const]),
    ...(read.against.length === 0 ? [] : [['Against', read.against.join(', ')] as const]),
    ['Goal', read.goal],
    ['Rules', read.rules.join(', ')],
  ];
  return (
    <section className="play-info-part play-read" data-testid="play-read" data-authorship={read.authorship} data-read-by={read.readBy}>
      <h3 className="play-info-heading">Your idea</h3>
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

/** Tlačítko listu na kartě pauzy (P34 T5; dřív kolo v bočním sloupci P33 T12). */
export function AboutButton({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <Button variant="secondary" size="s" className="play-info" data-testid="play-info" aria-haspopup="dialog" onClick={onOpen}>
      <Icon name="info" />
      About this game
    </Button>
  );
}

/** List „About this game“; otevírá ho `AboutButton` na kartě pauzy, takže stav drží shell. */
export function SentenceRead({ read, open, onClose }: { readonly read: ReadFacts; readonly open: boolean; readonly onClose: () => void }) {
  const parts = useInfoParts();
  return (
    <Sheet open={open} title="About this game" onClose={onClose} className="play-info-sheet">
      <ReadSection read={read} />
      {parts.how !== undefined && (
        <section className="play-info-part" data-testid="play-lab">
          <h3 className="play-info-heading">How to play</h3>
          {parts.how}
        </section>
      )}
      {parts.lineage}
      {parts.board}
    </Sheet>
  );
}
