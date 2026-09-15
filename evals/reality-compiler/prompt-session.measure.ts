/** Opt-in scripted smoke against an existing local production server. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { it } from 'vitest';
import { browserRenderer } from '../../scripts/browser-renderer';
import { createReviewArtifactSink } from '../../scripts/reality-compiler-review-runner';
import { runPreparedPromptSession } from '../../scripts/reality-compiler-prompt-browser';

it.skipIf(process.env.RC_PROMPT_SMOKE !== '1')('records actual prepared exact/nearest display and interrupted interaction', async () => {
  const baseURL = process.env.RC_PROMPT_BASE_URL;
  if (!baseURL) throw new Error('RC_PROMPT_BASE_URL_REQUIRED');
  const directory = resolve(process.env.RC_PROMPT_ARTIFACT_ROOT ?? 'scratch/prompt-session', randomUUID()); mkdirSync(directory, { recursive: true });
  const build = { buildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
    pageSha256: createHash('sha256').update(readFileSync('.next/server/app/page.js')).digest('hex'),
    commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    scope: 'Existing local production artifact, dirty source tree; not a live-model or independent holdout run.' };
  const browser = await chromium.launch({ headless: true, args: browserRenderer().args });
  const results: unknown[] = [];
  try {
    for (const entry of [
      { id: 'exact', prompt: 'A cathedral of stacked shipping containers around a light well.', match: 'exact', endpoint: 'display', act: false },
      { id: 'nearest', prompt: 'A tiny rainbow submarine made of strawberries inside a teacup.', match: 'nearest', endpoint: 'display', act: false },
      { id: 'no-interaction', prompt: 'A cathedral of stacked shipping containers around a light well.', match: 'exact', endpoint: 'interaction', act: false },
      { id: 'interaction', prompt: 'A cathedral of stacked shipping containers around a light well.', match: 'exact', endpoint: 'interaction', act: true },
      { id: 'cancelled-driver', prompt: 'A cathedral of stacked shipping containers around a light well.', match: 'exact', endpoint: 'interaction', act: false },
    ] as const) {
      const cancellation = new AbortController();
      const result = await runPreparedPromptSession({ browser, baseURL, prompt: entry.prompt, endpoint: entry.endpoint,
        build, sink: createReviewArtifactSink(resolve(directory, entry.id), entry.id), timeoutMs: entry.id === 'no-interaction' ? 5000 : 45000,
        signal: cancellation.signal,
        driver: async page => {
          await page.getByTestId('prompt-submit').click();
          if (entry.id === 'cancelled-driver') {
            await expect(page.getByTestId('runtime-act')).toBeEnabled();
            const pending = page.getByTestId('fixture-never-present').waitFor({ timeout: 60000 });
            cancellation.abort();
            return pending;
          }
          if (entry.act) {
            await expect(page.getByTestId('runtime-act')).toBeEnabled();
            await page.getByTestId('runtime-action').selectOption({ label: 'Walk to centralLightWell (visitor)' });
            await page.getByTestId('runtime-act').click();
            await expect(page.getByTestId('runtime-input-result')).toContainText('Applied: sys.moveTo.centralLightWell');
          }
        } });
      results.push({ id: entry.id, result });
      expect(result).toMatchObject({ version: 'prepared-prompt-browser-v1', modelCalls: 0, humanObservation: false,
        protocolAttempt: null, origin: 'prepared', match: entry.match,
        outcome: entry.id === 'no-interaction' ? 'interrupted' : entry.id === 'cancelled-driver' ? 'cancelled' : 'completed' });
      if (entry.id === 'no-interaction') expect(result.error).toBe('SESSION_TIMEOUT');
      if (entry.id === 'cancelled-driver') expect(result.error).toBe('SESSION_CANCELLED');
      expect(browser.contexts()).toHaveLength(0);
    }
    writeFileSync(resolve(directory, 'smoke-report.json'), JSON.stringify({ status: 'PASS', results }, null, 2), { flag: 'wx' });
    console.log(`PROMPT_SESSION_SMOKE_PASS ${directory}`);
  } catch (error) {
    writeFileSync(resolve(directory, 'smoke-report.json'), JSON.stringify({ status: 'FAIL', error: String(error), results }, null, 2), { flag: 'wx' });
    throw error;
  } finally { await browser.close(); }
}, 150000);
