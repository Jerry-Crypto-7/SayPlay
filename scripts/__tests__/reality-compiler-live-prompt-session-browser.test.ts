import { createHash } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPromptMaterializationBridge, materializationInputSchema, validateMaterializationRaw } from '../reality-compiler-live-prompt-session-browser';
import { chooseAuthored, emitterFor } from '../../src/worldstream/authored';
import { readPlannerEmission } from '../../src/model/worldstream-intent';
import { compileWithRepair } from '../../src/model/worldstream-repair';
import { serverGrammar } from '../../src/worldstream/sessions';

let raw: string;
beforeAll(async () => {
  const selected = chooseAuthored('A cathedral of stacked shipping containers around a light well.')!;
  const plan = readPlannerEmission(selected.world.planner), grammar = serverGrammar();
  if (!plan.ok || typeof grammar === 'string') throw new Error('FIXTURE_SETUP_FAILED');
  const built = await compileWithRepair({ plan: plan.value, grammar, sessionSeed: 4021, emit: emitterFor(selected.world) });
  if (built.kind !== 'compiled') throw new Error('FIXTURE_COMPILE_FAILED');
  raw = JSON.stringify(built.result.value);
});

describe('explicit full-blueprint materialization bridge', () => {
  it('validates schema, references and supported runtime before opening a browser', () => {
    expect(validateMaterializationRaw(raw).version).toBe('worldstream-v1');
    const changed = JSON.parse(raw); changed.objects[0].source = { kind: 'shape', shapeId: 'missingShape' };
    expect(() => validateMaterializationRaw(JSON.stringify(changed))).toThrow('MATERIALIZATION_INVALID_REFERENCES');
    expect(() => validateMaterializationRaw('{}')).toThrow('MATERIALIZATION_INVALID_BLUEPRINT');
    expect(() => validateMaterializationRaw('not json')).toThrow('MATERIALIZATION_INVALID_JSON');
    expect(() => validateMaterializationRaw('x'.repeat(8388609))).toThrow('MATERIALIZATION_RAW_LIMIT');
  });
  it.each(['https://localhost/', 'http://example.com/', 'http://user:pass@localhost/', 'http://localhost/foo', 'http://localhost/?token=x'])('rejects nonlocal or decorated base URL %s', baseURL => {
    expect(() => createPromptMaterializationBridge({ browser: {} as Browser, baseURL, prompt: 'fixture', origin: 'fixture', record: () => undefined })).toThrow('LOCAL_PRODUCTION_SERVER_REQUIRED');
  });
  it('refuses a changed response hash before allocating resources', async () => {
    const browser = { newContext: vi.fn() };
    const bridge = createPromptMaterializationBridge({ browser: browser as unknown as Browser, baseURL: 'http://127.0.0.1:3219/',
      prompt: 'fixture', origin: 'fixture', record: () => undefined });
    await expect(bridge.open({ raw, prompt: 'fixture', rawSha256: 'f'.repeat(64), slot: { id: 'fixture', caseId: 'fixture', arm: 'before', repetition: 1, retryOf: null }, build: null },
      new AbortController().signal)).rejects.toThrow('MATERIALIZATION_RAW_HASH_MISMATCH');
    expect(browser.newContext).not.toHaveBeenCalled();
  });
  it('binds the actual browser submit prompt to the frozen provider prompt', async () => {
    const browser = { newContext: vi.fn() };
    const bridge = createPromptMaterializationBridge({ browser: browser as unknown as Browser, baseURL: 'http://127.0.0.1:3219/',
      prompt: 'fixture', origin: 'fixture', record: () => undefined });
    await expect(bridge.open({ raw, prompt: 'changed', rawSha256: createHash('sha256').update(raw).digest('hex'),
      slot: { id: 'fixture', caseId: 'fixture', arm: 'before', repetition: 1, retryOf: null }, build: null },
      new AbortController().signal)).rejects.toThrow('MATERIALIZATION_PROMPT_MISMATCH');
    expect(browser.newContext).not.toHaveBeenCalled();
  });
  it('honors pre-abort after offline validation without allocating a context', async () => {
    const browser = { newContext: vi.fn() }, control = new AbortController(); control.abort();
    const bridge = createPromptMaterializationBridge({ browser: browser as unknown as Browser, baseURL: 'http://127.0.0.1:3219/',
      prompt: 'fixture', origin: 'fixture', record: () => undefined });
    await expect(bridge.open({ raw, prompt: 'fixture', rawSha256: createHash('sha256').update(raw).digest('hex'), slot: { id: 'fixture', caseId: 'fixture', arm: 'before', repetition: 1, retryOf: null }, build: null },
      control.signal)).rejects.toThrow('MATERIALIZATION_CANCELLED');
    expect(browser.newContext).not.toHaveBeenCalled();
  });
  it('closes an allocated context even when archive recording repeatedly fails', async () => {
    const page = { setDefaultTimeout: vi.fn(), addInitScript: vi.fn(async () => undefined) };
    const context = { newPage: vi.fn(async () => page), route: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const browser = { newContext: vi.fn(async () => context) };
    const bridge = createPromptMaterializationBridge({ browser: browser as unknown as Browser, baseURL: 'http://127.0.0.1:3219/',
      prompt: 'fixture', origin: 'fixture', record: () => { throw new Error('ARCHIVE_FAILED'); } });
    await expect(bridge.open({ raw, prompt: 'fixture', rawSha256: createHash('sha256').update(raw).digest('hex'),
      slot: { id: 'fixture', caseId: 'fixture', arm: 'before', repetition: 1, retryOf: null }, build: null },
      new AbortController().signal)).rejects.toThrow('ARCHIVE_FAILED');
    expect(context.close).toHaveBeenCalledOnce();
  });
  it('accepts only declared UI action labels/results without injected scripts or runtime clocks', () => {
    const action = { actionLabel: 'Walk to centralLightWell (visitor)', expectedApplied: 'Applied: sys.moveTo.centralLightWell' };
    expect(materializationInputSchema.safeParse({ version: 'materialization-ui-input-v1', actions: [action] }).success).toBe(true);
    expect(materializationInputSchema.safeParse({ version: 'materialization-ui-input-v1', actions: [{ ...action, tick: 50 }] }).success).toBe(false);
    expect(materializationInputSchema.safeParse({ version: 'materialization-ui-input-v1', actions: [], script: 'anything' }).success).toBe(false);
  });
});


