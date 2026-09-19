'use client';

import type { BranchComparison as Comparison } from '@/worldstream/branch-controller';
import { narrateComparison, type EntityNames } from '@/worldstream/comparison-narration';

function value(id: string, amount: number) {
  if (id.endsWith(':locked')) return amount ? 'locked' : 'unlocked';
  if (id.startsWith('f:')) return amount ? 'on' : 'off';
  if (id.startsWith('t:')) return `${amount} ticks`;
  return String(amount);
}

export default function BranchComparison({ comparison: c, names = {}, original, busy, onOriginal, onChanged, onRestart, scope = 'server', summary }: {
  readonly comparison: Comparison;
  /** Jména entit z blueprintu; zdrojový projekt žádný blueprint nemá a mluví stabilními ID. */
  readonly names?: EntityNames;
  readonly original: boolean;
  readonly busy: boolean;
  readonly onOriginal: () => void;
  readonly onChanged: () => void;
  readonly onRestart?: () => void;
  readonly scope?: 'server' | 'tab';
  readonly summary?: string;
}) {
  const keys = Object.keys(c.original.values).filter(id => id.startsWith('f:') || id.startsWith('t:')
    || (id.endsWith(':locked') && (c.original.values[id] !== 0 || c.changed.values[id] !== 0))
    || c.original.values[id] !== c.changed.values[id]);
  return <section data-testid="branch-comparison" aria-label="Branch comparison"
    style={{ pointerEvents: 'auto', padding: 12, background: '#0b1214', color: '#cfe3e6',
      font: '12px/1.4 ui-monospace, monospace', maxHeight: '36dvh', overflow: 'auto' }}>
    <strong>Original and changed outcome</strong>
    <p style={{ margin: '4px 0' }}><strong>From the state diff</strong></p>
    <p style={{ margin: '4px 0' }} data-testid="comparison-narration">{narrateComparison(c, names).join(' ')}</p>
    {summary && <p>{summary}</p>}
    <p style={{ margin: '4px 0' }} data-testid="branch-rule">Rule {c.ruleId}: {c.previousDurationTicks !== undefined && c.durationTicks !== undefined
      ? `${c.previousDurationTicks / 20}s → ${c.durationTicks / 20}s`
      : c.intervention.kind === 'condition' ? 'condition changed' : 'action changed'}</p>
    <p style={{ margin: '4px 0' }}>Same actions, compared at {(c.observationTick / 20).toFixed(1)}s.</p>
    <details><summary>State differences and replay details</summary>
    <p style={{ margin: '4px 0' }} data-testid="branch-horizon">Observation tick {c.observationTick} · fork tick {c.forkTick} · same {c.inputLog.length} visitor inputs</p>
    <table style={{ width: '100%', textAlign: 'left' }}>
      <thead><tr><th>State</th><th>Original</th><th>Changed</th></tr></thead>
      <tbody>
        {keys.map(id => <tr key={id} data-testid={`branch-value-${id}`}>
          <th>{id.replace(/^[eft]:/, '').replace(/:locked$/, '')}</th>
          <td>{value(id, c.original.values[id])}</td><td>{value(id, c.changed.values[id])}</td>
        </tr>)}
        <tr><th>Runtime tick</th><td>{c.original.tick}</td><td>{c.changed.tick}</td></tr>
        <tr><th>Ended at tick</th><td>{c.original.endedAtTick ?? 'Still running'}</td><td>{c.changed.endedAtTick ?? 'Still running'}</td></tr>
        <tr><th>Outcome</th><td>{c.original.runState}</td><td>{c.changed.runState}</td></tr>
      </tbody>
    </table>
    <details><summary>Rules applied in each branch</summary>
      {(['original', 'changed'] as const).map(side => <p key={side} data-testid={`branch-trace-${side}`}>
        {side}: {c[side].transitions.map(t => `${t.tick}: ${t.ruleIds.join(', ') || 'No rule applied'}`).join(' · ')}
      </p>)}
    </details>
    </details>
    <p>{original ? `Viewing the preserved original run. ${scope === 'tab' ? 'This tab keeps both source branches.' : 'The server keeps the accepted change.'}` : 'Viewing the changed run. Comparison above is a fixed replay at the shared observation tick.'}</p>
    <button type="button" data-testid="branch-original" disabled={original || busy} onClick={onOriginal}>{scope === 'tab' ? 'Show original source branch' : 'Return to original'}</button>{' '}
    <button type="button" data-testid="branch-changed" disabled={!original || busy} onClick={onChanged}>{scope === 'tab' ? 'Show changed source branch' : 'Show changed run'}</button>
    {onRestart ? <button type="button" data-testid="branch-restart" disabled={busy} onClick={onRestart}>Try another change from the original</button>
      : <p>One intervention per comparison.</p>}
    <small>One change per comparison. Reloading starts a new page; this visitor history is kept only in this tab.</small>
  </section>;
}
