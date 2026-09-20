import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAssetJobs, type AssetJobRequest } from '../asset-jobs';
import { createAssetManifest } from '@/assets/manifest';
import { createAssetLoader } from '@/assets/loader';
import catalog from '@/assets/catalog.json';
import type { AssetProvider, MeshyResult, MeshyTask } from '@/assets/providers/meshy';
import { ASSET_SPIKE } from '../../../evals/worldstream/world-quality/asset-spike';

const request: AssetJobRequest = { key: 'case-a', stableId: 'coral', revision: 1, candidate: 1,
  request: { kind: 'text', prompt: 'branching coral' } };
function setup(overrides: Partial<AssetProvider> = {}, limits = {}) {
  let revision = 1, stamp = 10, sequence = 0;
  const record = structuredClone(catalog.assets[0]);
  record.provenance.source = 'meshy:task/task-2'; // Mock provenance only; packaged bytes are not a generated object.
  const manifest = createAssetManifest({ version: 'worldstream-assets-v1', assets: [record] });
  const fetcher = vi.fn(async (path: string | URL | Request) => new Response(readFileSync(`public${String(path)}`)));
  const loader = createAssetLoader(manifest, { fetch: fetcher });
  const provider: AssetProvider = { create: vi.fn(async () => ({ id: `task-${++sequence}`, endpoint: 'text-to-3d' as const })),
    poll: vi.fn(async (): Promise<MeshyResult> => ({ status: 'SUCCEEDED', credits: 10, glbUrl: 'https://assets.meshy.ai/quarantine.glb' })),
    cancel: vi.fn(async () => 'still-running' as const), ...overrides };
  const jobs = createAssetJobs({ provider, manifest, loader, currentRevision: () => revision, now: () => stamp, ...limits });
  const ref = { kind: 'asset', assetId: record.assetId, version: record.version, hash: record.hash };
  return { jobs, provider, ref, fetcher, setRevision: (value: number) => { revision = value; }, setTime: (value: number) => { stamp = value; } };
}
describe('bounded process-local asset jobs', () => {
  it('runs preview/refine once and only becomes ready after the real approved local loader succeeds', async () => {
    const { jobs, provider, ref, fetcher } = setup();
    expect(jobs.enqueue(request).status).toBe('queued'); jobs.enqueue(request);
    await Promise.all([jobs.advance(request.key), jobs.advance(request.key)]);
    expect(provider.create).toHaveBeenCalledTimes(1);
    await jobs.advance(request.key); await jobs.advance(request.key);
    expect(jobs.getSnapshot(request.key)).toMatchObject({ status: 'running', stage: 'awaiting-import', credits: { 'task-1': 10, 'task-2': 10 } });
    expect(provider.create).toHaveBeenCalledTimes(2); expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(jobs.getSnapshot(request.key))).not.toContain('https:');
    expect(await jobs.attachImported(request.key, ref)).toMatchObject({ status: 'ready', reference: ref });
    expect(fetcher.mock.calls[0][0]).toMatch(/^\/assets\/worldstream\//);
  });
  it('rejects duplicate candidate slots, changed idempotency payloads and a third candidate', () => {
    const { jobs } = setup(); jobs.enqueue(request);
    expect(() => jobs.enqueue({ ...request, revision: 2 })).toThrow('conflicts');
    expect(() => jobs.enqueue({ ...request, key: 'another' })).toThrow('two distinct');
    expect(() => jobs.enqueue({ ...request, key: 'new-revision', revision: 2 })).toThrow('two distinct');
    expect(() => jobs.enqueue({ ...request, key: 'third', candidate: 3 as 1 })).toThrow('identity');
  });
  it('limits concurrency, polls and elapsed work', async () => {
    const { jobs, provider, setTime } = setup({ poll: async () => ({ status: 'PENDING', credits: null, glbUrl: null }) }, { maxConcurrent: 1, maxPolls: 1 });
    jobs.enqueue(request); jobs.enqueue({ ...request, key: 'second', candidate: 2 });
    await jobs.advance(request.key); expect((await jobs.advance('second')).status).toBe('queued');
    await jobs.advance(request.key); expect((await jobs.advance(request.key)).reason).toBe('POLL_BUDGET');
    setTime(700000); expect((await jobs.advance('second')).reason).toBe('JOB_DEADLINE');
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it('discards a stale result before it can start refine or import', async () => {
    let resolve!: (result: MeshyResult) => void;
    const { jobs, setRevision, provider } = setup({ poll: () => new Promise(done => { resolve = done; }) });
    jobs.enqueue(request); await jobs.advance(request.key);
    const pending = jobs.advance(request.key); setRevision(2);
    resolve({ status: 'SUCCEEDED', credits: 10, glbUrl: 'https://assets.meshy.ai/x' });
    expect((await pending).reason).toBe('STALE_REVISION'); expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it('cancels locally while honestly retaining remote running status, including late create acknowledgements', async () => {
    let resolve!: (result: MeshyTask) => void;
    const { jobs, provider } = setup({ create: () => new Promise(done => { resolve = done; }) });
    jobs.enqueue(request); const pending = jobs.advance(request.key);
    await jobs.cancel(request.key);
    resolve({ id: 'late-task', endpoint: 'text-to-3d' });
    expect(await pending).toMatchObject({ status: 'cancelled', providerMayStillRun: true });
    expect(provider.cancel).toHaveBeenCalledOnce();
  });
  it('does not retry unknown submission outcomes', async () => {
    const create = vi.fn(async () => { throw new Error('socket lost after upload'); });
    const { jobs } = setup({ create }); jobs.enqueue(request);
    expect(await jobs.advance(request.key)).toMatchObject({ status: 'failed', providerMayStillRun: true, reason: 'PROVIDER_OUTCOME_UNKNOWN' });
    await jobs.advance(request.key); expect(create).toHaveBeenCalledOnce();
  });
  it('refuses remote runtime URLs and forged import identity', async () => {
    const { jobs, ref, fetcher } = setup(); jobs.enqueue(request);
    await jobs.advance(request.key); await jobs.advance(request.key); await jobs.advance(request.key);
    await expect(jobs.attachImported(request.key, { ...ref, path: 'https://assets.meshy.ai/x' })).rejects.toThrow();
    await expect(jobs.attachImported(request.key, { ...ref, hash: 'f'.repeat(64) })).rejects.toThrow('hash');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not install an approved model when the object revision changes during loading', async () => {
    const { jobs, ref, setRevision } = setup(); jobs.enqueue(request);
    await jobs.advance(request.key); await jobs.advance(request.key); await jobs.advance(request.key);
    const pending = jobs.attachImported(request.key, ref); setRevision(2);
    expect(await pending).toMatchObject({ status: 'failed', reason: 'STALE_REVISION', reference: null });
  });
  it('cancels a queued job without contacting the provider', async () => {
    const { jobs, provider } = setup(); jobs.enqueue(request);
    expect(await jobs.cancel(request.key)).toMatchObject({ status: 'cancelled', providerMayStillRun: false });
    await jobs.advance(request.key); expect(provider.create).not.toHaveBeenCalled(); expect(provider.cancel).not.toHaveBeenCalled();
  });
  it('runs image candidate without a second refine task and records explicit provider failure', async () => {
    const { jobs, provider } = setup({ poll: async () => ({ status: 'FAILED', credits: 0, glbUrl: null }) });
    jobs.enqueue({ ...request, request: { kind: 'image', prompt: 'coral', imageDataUri: 'data:image/png;base64,YQ==' } });
    expect(await jobs.advance(request.key)).toMatchObject({ status: 'running', stage: 'image' });
    expect(await jobs.advance(request.key)).toMatchObject({ status: 'failed', reason: 'FAILED', credits: { 'task-1': 0 }, providerMayStillRun: false });
    expect(provider.create).toHaveBeenCalledOnce();
  });
  it('fixes six distinct object briefs and exactly two candidate modes', () => {
    expect(ASSET_SPIKE.objects).toHaveLength(6);
    expect(new Set(ASSET_SPIKE.objects.map(o => o.id)).size).toBe(6);
    expect(ASSET_SPIKE.candidates).toEqual(['text-preview-refine', 'owned-image-to-3d']);
    expect(ASSET_SPIKE.objects.every(o => o.prompt.length <= 800 && o.parts.length > 0)).toBe(true);
  });
});
