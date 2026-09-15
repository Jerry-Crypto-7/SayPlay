import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { createSubscriptionCommand } from '../codex-subscription';
import { bindSubscriptionLifetime, waitForSubscriptionClose } from '../subscription-lifetime';

// Readiness cannot arrive after the simulator has terminated. Preserve that
// outcome instead of waiting for Vitest's unrelated outer timeout.
async function waitForSimulatorReady(ready: Promise<void>, outcome: Promise<string>): Promise<void> {
  await Promise.race([ready, outcome.then(result => {
    throw new Error(`SIMULATOR_TERMINATED_BEFORE_READY:${result}`);
  })]);
}

describe('controlled browser shutdown with offline Node CLI simulator', () => {
  it.each(['page', 'context', 'browser'] as const)('%s close aborts a running local command and releases the launcher wait', async surface => {
    const browser = await chromium.launch({ headless: true });
    const controller = new AbortController();
    let outcome: Promise<string> | undefined;
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      bindSubscriptionLifetime(controller, browser, context, page);
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const command = createSubscriptionCommand({ executable: process.execPath,
        prefix: ['-e', `console.log(JSON.stringify({type:'thread.started'})); setInterval(() => {}, 1000);`, '--'],
        timeoutMs: 60_000, progress: () => started() });
      // Observe rejection immediately; browser shutdown can complete after the child closes.
      outcome = command([], '', controller.signal).then(() => 'UNEXPECTED_SUCCESS', error => error.message);
      const waiting = waitForSubscriptionClose(controller.signal, 10_000);
      await waitForSimulatorReady(ready, outcome);
      await ({ page, context, browser })[surface].close();
      expect(controller.signal.aborted).toBe(true);
      await expect(outcome).resolves.toBe('CODEX_CANCELLED');
      await waiting;
    } finally { controller.abort(); await outcome; await browser.close(); }
    // Spouští skutečné Chromium třikrát uvnitř paralelní jednotkové sady, takže
    // 30 s stropu z `vitest.config.mts` je pod zátěží 204 souborů málo na samotný
    // start prohlížeče. Vnitřní `timeoutMs` je strop příkazu, ne měřená vlastnost —
    // ta je „zavření page/context/browser zruší běžící příkaz a uvolní čekání".
  }, 120_000);
  it.each(['CODEX_TIMEOUT', 'CODEX_COMMAND_FAILED', 'UNEXPECTED_SUCCESS'])('reports %s before progress without waiting for readiness', async terminal => {
    const neverReady = new Promise<void>(() => {});
    await expect(waitForSimulatorReady(neverReady, Promise.resolve(terminal)))
      .rejects.toThrow(`SIMULATOR_TERMINATED_BEFORE_READY:${terminal}`);
  });
  it('returns immediately when shutdown happened before the wait was installed', async () => {
    await expect(waitForSubscriptionClose(AbortSignal.abort(), 10_000)).resolves.toBeUndefined();
  });
});
