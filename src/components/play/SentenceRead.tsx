/**
 * „From your sentence“: co z věty vzniklo a kdo to navrhl. Sbalený řádek je
 * vidět pořád, aby porotce bez klikání viděl, že hru skládá model z jeho věty;
 * rozbalený ukáže, co si z ní vzal. Návrh ze slov se hlásí jako návrh, nikdy
 * jako AI (`authorshipOf`). Fakta skládá server (`lab.ts`).
 */

import type { Authorship, ReadFacts } from './lab';

const BY: Readonly<Record<Authorship, readonly [string, string]>> = {
  ai: ['Designed by AI', 'from'],
  draft: ['Instant draft', 'from the keywords in'],
  remix: ['Remixed with one change', 'of'],
};

/** Návrh, jehož větu přečetl lokální model (P29B T6) – pořád návrh, ne hra od AI. */
const READ_BY_MODEL = 'read by a local AI model from';

export function SentenceRead({ read }: { readonly read: ReadFacts }) {
  const from = read.authorship === 'draft' && read.readBy === 'model' ? READ_BY_MODEL : BY[read.authorship][1];
  const rows: readonly (readonly [string, string])[] = [
    ['Game', read.game],
    ['World', read.world],
    ...(read.you === null ? [] : [['You are', read.you] as const]),
    ...(read.against.length === 0 ? [] : [['Against', read.against.join(', ')] as const]),
    ['Goal', read.goal],
    ['Rules', read.rules.join(', ')],
  ];
  return (
    <details className="play-lab play-read" data-testid="play-read" data-authorship={read.authorship} data-read-by={read.readBy}>
      <summary data-testid="play-read-toggle">
        <span className={`play-read-by play-read-by-${read.authorship}`}>{BY[read.authorship][0]}</span>
        {read.sentence !== null && <span className="play-read-sentence"> {from} “{read.sentence}”</span>}
      </summary>
      <dl className="play-read-rows">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {read.authorship === 'draft' && (
        <p className="play-read-note">The AI model rewrites this draft when it is online; the new version appears as a button.</p>
      )}
    </details>
  );
}
