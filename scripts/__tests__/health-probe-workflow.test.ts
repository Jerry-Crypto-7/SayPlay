/**
 * P78 T5: hlídač dostupnosti do 31. 12. je naplánovaný workflow GitHub Actions. Běží bez dozoru, takže se pinuje
 * tvar, na který se spoléhá: interval, cíle shodné s `ops/monitoring/uptime.json` (ty čte `submission-check` [7]),
 * že pád otevře issue a run zčervená, a že token smí jen číst repo a psát issues.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { externalMonitorProblems } from '../submission-check.mjs';

const workflow = readFileSync('.github/workflows/health-probe.yml', 'utf8');
const uptime = JSON.parse(readFileSync('ops/monitoring/uptime.json', 'utf8')) as { external: { service: string; intervalMin: number; targets: string[] } };
const manifest = JSON.parse(readFileSync('docs/submission/submission.json', 'utf8')) as Record<string, unknown>;
/** `demoUrl` a `backendUrl` manifestu přihlášky – na nejvyšší úrovni, nebo v prvním vnořeném objektu, který je nese. */
const urls = (('demoUrl' in manifest ? manifest : Object.values(manifest).find((value) => typeof value === 'object' && value !== null && 'demoUrl' in value)) ?? {}) as { demoUrl: string; backendUrl: string };

/** Adresy, které krok sondy obchází (řádky smyčky `for url in`). */
const probed = (): string[] => {
  const loop = /for url in \\\n([\s\S]*?); do/.exec(workflow)?.[1] ?? '';
  return loop.split('\n').map((line) => line.replace(/\\$/, '').trim()).filter((line) => line !== '');
};

describe('health probe workflow', () => {
  it('runs every 10 minutes and on demand', () => {
    expect(workflow).toMatch(/schedule:\n\s+- cron: '\*\/10 \* \* \* \*'/);
    expect(workflow).toMatch(/\n {2}workflow_dispatch:/);
    expect(uptime.external.intervalMin).toBe(10);
  });

  it('probes exactly the targets uptime.json declares, and those satisfy submission-check [7]', () => {
    expect(probed()).toEqual(uptime.external.targets);
    expect(uptime.external.targets).toEqual(expect.arrayContaining(['https://worldstream-sigma.vercel.app/play', 'https://worldstream-sigma.vercel.app/api/build-id']));
    expect(externalMonitorProblems(uptime.external, urls)).toEqual([]);
  });

  it('a non-200 answer fails the probe, opens or comments the outage issue and turns the run red', () => {
    expect(workflow).toContain('if [ "$code" != "200" ]; then failed=');
    const conditional = workflow.match(/if: steps\.probe\.outputs\.failed != ''/g) ?? [];
    expect(conditional).toHaveLength(2);
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('gh issue comment');
    expect(workflow).toMatch(/Mark the run red\n\s+if: steps\.probe\.outputs\.failed != ''\n\s+run: exit 1/);
  });

  it('the token can only read the repo and write issues; step output reaches the shell through env, not inline', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n {2}issues: write\n\n/);
    expect(workflow).not.toMatch(/write-all|pull-requests:|actions: write|contents: write/);
    expect(workflow).not.toMatch(/run: [^\n]*\$\{\{/);
    expect(workflow.split('\n').filter((line) => line.includes('${{')).map((line) => line.trim())).toEqual([
      'GH_TOKEN: ${{ github.token }}',
      'FAILED: ${{ steps.probe.outputs.failed }}',
    ]);
  });
});
