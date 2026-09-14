import type { Browser, BrowserContext, Page } from '@playwright/test';

/** A closed controlled browser stops the local subscription transport. */
export function bindSubscriptionLifetime(controller: AbortController, browser: Browser, context: BrowserContext, page: Page) {
  const stop = () => controller.abort();
  browser.once('disconnected', stop);
  context.once('close', stop);
  page.once('close', stop);
  if (!browser.isConnected() || page.isClosed()) stop();
}

export function waitForSubscriptionClose(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
