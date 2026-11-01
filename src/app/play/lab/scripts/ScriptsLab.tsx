'use client';

import { useEffect, useState } from 'react';

type LabState = { readonly state: 'running' } | { readonly state: 'done'; readonly output: string; readonly cases: number } | { readonly state: 'failed'; readonly error: string };

/**
 * Spustí zkušební sadu skriptů úrovní v prohlížeči a vystaví kanonický výstup e2e sadě (P68 T13). QuickJS a sada se
 * načtou až tady (dynamický import), takže je nenese žádná jiná stránka.
 */
export function ScriptsLab() {
  const [lab, setLab] = useState<LabState>({ state: 'running' });
  useEffect(() => {
    Promise.all([import('@/play/scripts/sandbox'), import('@/play/scripts/lab')])
      .then(async ([sandbox, suite]) => {
        const cases = suite.runLab(await sandbox.loadQuickJs());
        setLab({ state: 'done', output: suite.labOutput(cases), cases: cases.length });
      })
      .catch((error: unknown) => setLab({ state: 'failed', error: String(error) }));
  }, []);
  return (
    <main data-testid="scripts-lab" data-state={lab.state} style={{ padding: 'var(--sp-space-4)', color: 'var(--sp-text)', background: 'var(--sp-surface)' }}>
      <p>{lab.state === 'done' ? `Level scripts: ${String(lab.cases)} runs` : lab.state === 'failed' ? lab.error : 'Running the level scripts…'}</p>
      {lab.state === 'done' ? (
        <pre data-testid="scripts-lab-output" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 'var(--sp-text-body-s-size)', color: 'var(--sp-text-secondary)' }}>
          {lab.output}
        </pre>
      ) : null}
    </main>
  );
}
