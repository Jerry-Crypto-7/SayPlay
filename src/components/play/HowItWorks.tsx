'use client';

/**
 * „How to play“ (P23-C T8, od P33 T7 oddíl listu „About this game“).
 *
 * Mechaniky jednou větou z registru s parametry, zpráva o kvalitě lidsky,
 * zkrácené id verze a rodokmen. Žádný výpis JSON – kdo chce surová data,
 * má `GET /api/play/games/:id`. Věty skládá server (`lab.ts`). Ve shellu se
 * obsah zapíše do listu (`useInfoPart`); bez něj zůstane sbalený panel.
 */

import { useMemo } from 'react';

import type { GameVersion } from '@/play/contracts';

import type { LabFacts } from './lab';
import { useInfoPart } from './ui/InfoContext';

interface HowProps {
  readonly facts: LabFacts;
  readonly versionId: string;
  readonly lineage: readonly GameVersion[];
}

function HowToPlay({ facts, versionId, lineage }: HowProps) {
  return (
    <>
      <ul className="play-lab-mechanics">
        {facts.mechanics.map((mechanic) => (
          <li key={mechanic.id}>
            <strong>{mechanic.name}</strong> – {mechanic.explanation}
            {mechanic.params.length > 0 && (
              <span className="play-lab-params">
                {mechanic.params.map(([key, value]) => `${key}: ${value}`).join(' · ')}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="play-lab-quality">
        {facts.rulesChecked} · {facts.winnable} · {facts.replay}
      </p>
      <p className="play-lab-version">
        Version {versionId.slice(0, 12)}
        {lineage.length > 1 && ` · ${lineage.length - 1} ${lineage.length === 2 ? 'ancestor' : 'ancestors'}: ${lineage.slice(0, -1).map((entry) => entry.title).join(' → ')}`}
      </p>
    </>
  );
}

export function HowItWorks({ facts, versionId, lineage }: HowProps) {
  const part = useMemo(() => <HowToPlay facts={facts} versionId={versionId} lineage={lineage} />, [facts, versionId, lineage]);
  if (useInfoPart('how', part)) return null;
  return (
    <details className="play-lab" data-testid="play-lab">
      <summary data-testid="play-lab-toggle">How this game works</summary>
      {part}
    </details>
  );
}
