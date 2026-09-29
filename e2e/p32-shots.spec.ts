import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Harness P32 (`scripts/p32/shots.mjs`, P32D T2) na jedné větě offline proti
 * `next start`: skutečná stránka musí nést sondu vstupu, jinak harness větu
 * odmítne. Výstup jde do dočasné složky, ne do `evals/play/p32/runs/`.
 */
test('the P32 harness shoots one sentence with timings against the real page', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), 'p32-shots-e2e-'));
  const set = join(dir, 'sentences.json');
  writeFileSync(set, JSON.stringify({ sentences: [{ id: 'penguin', text: 'A penguin slides down an icy mountain, collects snowflakes and avoids rocks' }], sealed: [] }));
  const out = join(dir, 'run');

  const run = spawnSync(process.execPath, ['scripts/p32/shots.mjs', '--base', baseURL ?? '', '--set', set, '--out', out, '--fps-seconds', '5'], {
    encoding: 'utf8',
    timeout: 220_000,
  });
  expect(run.status, run.stderr).toBe(0);

  const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  const [one] = result.sentences;
  expect(one.error).toBeNull();
  expect(one.gamePath).toMatch(/^\/play\/[0-9a-f]+$/);
  expect(one.timeToPlayableMs).toBeGreaterThan(0);
  expect(one.timeToFirstFrameMs).toBeGreaterThan(0);
  expect(Number.isInteger(one.inputTick)).toBe(true);
  expect(one.fpsMedian).toBeGreaterThan(0);
  expect(one.network.some((entry: { category: string }) => entry.category === 'api')).toBe(true);
  for (const shot of [one.shots.draftDesktop, one.shots.draftPhone]) {
    expect(shot).not.toBeNull();
    expect(existsSync(join(out, shot))).toBe(true);
  }
});
