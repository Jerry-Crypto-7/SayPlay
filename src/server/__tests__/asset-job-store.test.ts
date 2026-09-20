import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openAssetJobFileStore, replaceAssetJobFile } from '../asset-job-store';
import { createAssetJobs, type AssetJobRequest } from '../asset-jobs';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import type { AssetLoader } from '@/assets/loader';
import type { AssetProvider, MeshyTask } from '@/assets/providers/meshy';

const directories: string[] = [], closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of directories.splice(0)) { if (dirname(dir) !== tmpdir()) throw new Error('Unsafe test cleanup'); rmSync(dir, { recursive: true, force: true }); }
});
function setup(options: { maxBytes?: number; maxPolls?: number; maxConcurrent?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worldstream-asset-store-')); directories.push(dir);
  const file = join(dir, 'jobs.json'); let revision = 1, time = 100, sequence = 0;
  const provider: AssetProvider = {
    create: vi.fn(async () => ({ id: `task-${++sequence}`, endpoint: 'text-to-3d' as const })),
    poll: vi.fn(async () => ({ status: 'IN_PROGRESS' as const, credits: 1, glbUrl: null })),
    cancel: vi.fn(async () => 'deleted' as const),
  };
  const open = () => {
    const store = openAssetJobFileStore(file, { maxBytes: options.maxBytes }); closers.push(() => store.close());
    const jobs = createAssetJobs({ provider, store, currentRevision: () => revision, now: () => time,
      maxPolls: options.maxPolls, maxConcurrent: options.maxConcurrent,
      manifest: WORLDSTREAM_ASSETS, loader: { load: vi.fn() } as AssetLoader });
    return { store, jobs };
  };
  return { file, open, provider, setRevision: (value: number) => { revision = value; }, setTime: (value: number) => { time = value; } };
}
const input = (key = 'a'): AssetJobRequest => ({ key, stableId: `object-${key}`, revision: 1, candidate: 1, request: { kind: 'text', prompt: 'fixture' } });

describe('durable single-owner asset jobs', () => {
  it('restarts queued work and polls known tasks without repeating create; three clients share backpressure', async () => {
    const f = setup(); let current = f.open();
    for (const id of ['a', 'b', 'c']) current.jobs.enqueue(input(id));
    current.store.close(); current = f.open();
    const results = await Promise.all(['a', 'b', 'c'].map(id => current.jobs.advance(id)));
    expect(results.map(result => result.status)).toEqual(['running', 'running', 'queued']);
    expect(f.provider.create).toHaveBeenCalledTimes(2);
    current.store.close(); current = f.open();
    expect(current.jobs.enqueue(input('a')).tasks).toHaveLength(1);
    await current.jobs.advance('a'); expect(f.provider.create).toHaveBeenCalledTimes(2); expect(f.provider.poll).toHaveBeenCalledOnce();
    await current.jobs.cancel('a'); await current.jobs.advance('c'); expect(f.provider.create).toHaveBeenCalledTimes(3);
    expect(() => current.jobs.enqueue({ ...input('a'), revision: 2 })).toThrow('Idempotency');
  });

  it.each(['initial', 'refine'])('never repeats an uncertain %s POST after restart', async stage => {
    const f = setup({ maxConcurrent: 1 }); let current = f.open(); current.jobs.enqueue(input());
    if (stage === 'refine') {
      await current.jobs.advance('a'); vi.mocked(f.provider.poll).mockResolvedValue({ status: 'SUCCEEDED', credits: 1, glbUrl: 'https://example.invalid/model.glb' });
    }
    let finish!: (task: MeshyTask) => void;
    vi.mocked(f.provider.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = current.jobs.advance('a');
    // Refine starts after its readonly poll; allow that continuation to persist its marker.
    await Promise.resolve(); await Promise.resolve();
    const persisted = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(persisted.state.jobs[0].inFlightCreate).toBe(true);
    current.store.close(); current = f.open();
    expect(current.jobs.getSnapshot('a')).toMatchObject({ status: 'failed', reason: 'PROVIDER_OUTCOME_UNKNOWN_AFTER_RESTART', providerMayStillRun: true });
    const count = vi.mocked(f.provider.create).mock.calls.length; await current.jobs.advance('a');
    expect(f.provider.create).toHaveBeenCalledTimes(count);
    current.jobs.enqueue(input('b')); expect((await current.jobs.advance('b')).status).toBe('queued');
    expect(f.provider.create).toHaveBeenCalledTimes(count); // An unknown remote POST still owns its concurrency slot.
    finish({ id: 'late-task', endpoint: 'text-to-3d' });
    await expect(pending).rejects.toThrow('failed closed'); // Old process cannot overwrite the restored owner.
  });

  it('persists poll budget, cancellation, revision checks and absolute deadline', async () => {
    const f = setup({ maxPolls: 1 }); let current = f.open(); current.jobs.enqueue(input()); await current.jobs.advance('a'); await current.jobs.advance('a');
    current.store.close(); current = f.open();
    expect(await current.jobs.advance('a')).toMatchObject({ reason: 'POLL_BUDGET' }); expect(f.provider.poll).toHaveBeenCalledOnce();
    current.jobs.enqueue(input('b')); f.setRevision(2);
    expect(await current.jobs.advance('b')).toMatchObject({ reason: 'STALE_REVISION' });
    f.setRevision(1); current.jobs.enqueue(input('c')); await current.jobs.cancel('c');
    current.store.close(); current = f.open(); expect(current.jobs.getSnapshot('c').status).toBe('cancelled');
    current.jobs.enqueue(input('d')); f.setTime(600101);
    expect(await current.jobs.advance('d')).toMatchObject({ reason: 'JOB_DEADLINE' });
  });

  it.each(['json', 'schema'])('refuses a second owner, stale writes and %s corruption without provider work', kind => {
    const f = setup(), current = f.open(); current.jobs.enqueue(input());
    expect(() => openAssetJobFileStore(f.file)).toThrow();
    const loaded = current.store.load(); expect(() => current.store.save(loaded.state!, loaded.version - 1)).toThrow('Stale');
    current.store.close();
    const corrupted = structuredClone(loaded); if (corrupted.state) corrupted.state.jobs[0].snapshot.id = 'different-identity';
    writeFileSync(f.file, kind === 'json' ? '{corrupted' : JSON.stringify(corrupted));
    const reopened = openAssetJobFileStore(f.file); closers.push(() => reopened.close());
    expect(() => reopened.load()).toThrow(); expect(f.provider.create).not.toHaveBeenCalled();
  });

  it('rejects image backup overflow before mutation and leaves the persisted state unchanged', () => {
    const f = setup({ maxBytes: 2048 }), { jobs } = f.open(); jobs.enqueue(input());
    const before = readFileSync(f.file);
    expect(() => jobs.enqueue({ ...input('b'), request: { kind: 'image', prompt: 'fixture', imageDataUri: `data:image/png;base64,${'A'.repeat(4096)}` } })).toThrow('byte budget');
    expect(readFileSync(f.file)).toEqual(before); expect(f.provider.create).not.toHaveBeenCalled();
    expect(() => jobs.getSnapshot('a')).toThrow('failed closed');
  });
});

it('retries only transient Windows atomic replacement without deleting the accepted target', () => {
  const failure = Object.assign(new Error('sharing violation'), {code:'EPERM'});
  const rename = vi.fn().mockImplementationOnce(()=>{throw failure;}).mockImplementationOnce(()=>{throw failure;});
  const wait = vi.fn();
  replaceAssetJobFile('source.tmp','accepted.json',{platform:'win32',rename,wait});
  expect(rename.mock.calls).toEqual(Array(3).fill(['source.tmp','accepted.json']));
  expect(wait.mock.calls).toEqual([[10],[25]]);
});
it.each(['win32','linux'])('preserves permanent replacement failures on %s', platform => {
  const failure = Object.assign(new Error('sharing violation'), {code:'EPERM'});
  const rename = vi.fn(()=>{throw failure;}), wait=vi.fn();
  expect(()=>replaceAssetJobFile('source.tmp','accepted.json',{platform,rename,wait})).toThrow(failure);
  expect(rename).toHaveBeenCalledTimes(platform==='win32'?4:1);
  expect(wait).toHaveBeenCalledTimes(platform==='win32'?3:0);
});
