/**
 * „How this game works“ (P23-C T8): sbalený panel během hry i po ní.
 *
 * Mechaniky jednou větou z registru s parametry, zpráva o kvalitě lidsky,
 * zkrácené id verze a rodokmen. Žádný výpis JSON – kdo chce surová data,
 * má `GET /api/play/games/:id`. Věty skládá server (`lab.ts`).
 */

import type { GameVersion } from '@/play/contracts';

import type { LabFacts } from './lab';

export function HowItWorks({ facts, versionId, lineage }: {
  readonly facts: LabFacts;
  readonly versionId: string;
  readonly lineage: readonly GameVersion[];
}) {
  return (
    <details className="play-lab" data-testid="play-lab">
      <summary data-testid="play-lab-toggle">How this game works</summary>
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
    </details>
  );
}
