'use client';

/**
 * „How to play“ (P23-C T8, od P33 T7 oddíl listu „About this game“).
 *
 * Od P70C T3 jen pro hráče: jak vyhrát, jak prohrát, ovládání (na dotyku bez
 * kláves, stejně jako karta před startem) a 2–3 věty, jak hra běží. Tiky,
 * replay, id verze ani parametry mechanik sem nepatří. Věty skládá server
 * (`lab.ts`). Ve shellu se obsah zapíše do listu (`useInfoPart`); bez něj
 * zůstane sbalený panel.
 */

import { useMemo } from 'react';

import { touchHint, useCoarsePointer } from './FirstPrompt';
import type { LabFacts } from './lab';
import { useInfoPart } from './ui/InfoContext';

function HowToPlay({ facts }: { readonly facts: LabFacts }) {
  const coarse = useCoarsePointer();
  const rows: readonly (readonly [string, string])[] = [
    ['Win', facts.goal],
    ...(facts.lose === null ? [] : [['Lose', facts.lose] as const]),
    ['Controls', coarse ? touchHint(facts.controls) : facts.controls],
  ];
  return (
    <>
      <dl className="play-read-rows play-lab-rows">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="play-lab-mechanics">
        {facts.how.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

export function HowItWorks({ facts }: { readonly facts: LabFacts }) {
  const part = useMemo(() => <HowToPlay facts={facts} />, [facts]);
  if (useInfoPart('how', part)) return null;
  return (
    <details className="play-lab" data-testid="play-lab">
      <summary data-testid="play-lab-toggle">How to play</summary>
      {part}
    </details>
  );
}
