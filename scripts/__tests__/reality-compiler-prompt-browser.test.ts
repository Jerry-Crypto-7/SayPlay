import { expect, it, vi } from 'vitest';
import type { Browser } from '@playwright/test';
import { runPreparedPromptSession } from '../reality-compiler-prompt-browser';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';

function setup() {
  const artifacts: Record<string, unknown> = {};
  const sink: ReviewArtifactSink = { append: vi.fn(), late: vi.fn(), seal: () => ({ path: 'journal', sha256: 'a'.repeat(64) }),
    write(name, value) { artifacts[name] = value; return { path: name, sha256: 'a'.repeat(64) }; } };
  return { sink, artifacts };
}
it('archives pre-abort without opening a browser', async () => {
  const { sink } = setup(), newContext = vi.fn();
  const control = new AbortController(); control.abort();
  const result = await runPreparedPromptSession({ browser: { newContext } as unknown as Browser,
    sink, build: {}, baseURL: 'http://127.0.0.1:3219', prompt: 'Frozen.', endpoint: 'display', signal: control.signal });
  expect(result).toMatchObject({ outcome: 'cancelled', error: 'SESSION_CANCELLED', modelCalls: 0 });
  expect(newContext).not.toHaveBeenCalled();
});
it.each(['https://example.com', 'http://user:password@127.0.0.1:3219', 'http://127.0.0.1:3219/other'])('rejects nonlocal or credential URL %s before browser', async baseURL => {
  const { sink } = setup(), newContext = vi.fn();
  const result = await runPreparedPromptSession({ browser: { newContext } as unknown as Browser,
    sink, build: {}, baseURL, prompt: 'Frozen.', endpoint: 'display' });
  expect(result.error).toBe('LOCAL_PRODUCTION_SERVER_REQUIRED'); expect(newContext).not.toHaveBeenCalled();
});
it('bounds unresolved browser creation and handles a later rejection', async () => {
  const { sink } = setup(); let rejectCreation!: (error: Error) => void;
  const newContext = vi.fn(() => new Promise((_resolve, reject) => { rejectCreation = reject; }));
  const result = await runPreparedPromptSession({ browser: { newContext } as unknown as Browser,
    sink, build: {}, baseURL: 'http://127.0.0.1:3219', prompt: 'Frozen.', endpoint: 'display', timeoutMs: 10 });
  expect(result).toMatchObject({ outcome: 'interrupted', error: 'SESSION_TIMEOUT' });
  rejectCreation(new Error('late browser rejection')); await Promise.resolve(); await Promise.resolve();
});
it('closes a browser context that arrives after timeout', async () => {
  const { sink } = setup(); let resolveCreation!: (value: unknown) => void;
  const newContext = vi.fn(() => new Promise(resolve => { resolveCreation = resolve; }));
  const result = await runPreparedPromptSession({ browser: { newContext } as unknown as Browser,
    sink, build: {}, baseURL: 'http://127.0.0.1:3219', prompt: 'Frozen.', endpoint: 'display', timeoutMs: 10 });
  const close = vi.fn(async () => undefined); resolveCreation({ close }); await Promise.resolve(); await Promise.resolve();
  expect(result.error).toBe('SESSION_TIMEOUT'); expect(close).toHaveBeenCalledOnce();
});
it('archives interrupted device evaluation and closes the context', async () => {
  const { sink } = setup();
  const page = { setDefaultTimeout: vi.fn(), once: vi.fn(), on: vi.fn(), goto: vi.fn(async () => undefined),
    evaluate: vi.fn(() => new Promise(() => undefined)) };
  const context = { newPage: vi.fn(async () => page), route: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const result = await runPreparedPromptSession({ browser: { newContext: vi.fn(async () => context) } as unknown as Browser,
    sink, build: {}, baseURL: 'http://127.0.0.1:3219', prompt: 'Frozen.', endpoint: 'display', timeoutMs: 20 });
  expect(result).toMatchObject({ outcome: 'interrupted', error: 'SESSION_TIMEOUT' });
  expect(context.close).toHaveBeenCalledOnce();
});
