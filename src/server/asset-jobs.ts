import { canonical } from '@/ir/worlddoc';
import { assetReferenceSchema, type AssetReference } from '@/assets/schema';
import type { AssetManifest } from '@/assets/manifest';
import type { AssetLoader } from '@/assets/loader';
import { disposeSubtree } from '@/components/viewer/dispose';
import { meshyRequestSchema, type AssetProvider, type MeshyRequest, type MeshyTask } from '@/assets/providers/meshy';
import { assetJobStateSchema, type AssetJobState, type AssetJobStore } from './asset-job-store';

export interface AssetJobRequest { readonly key: string; readonly stableId: string; readonly revision: number;
  readonly candidate: 1 | 2; readonly request: Exclude<MeshyRequest, { kind: 'refine' }> }
export interface AssetJobSnapshot {
  readonly id: string; readonly stableId: string; readonly revision: number;
  readonly status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
  readonly stage: 'queued' | 'preview' | 'refine' | 'image' | 'awaiting-import' | 'terminal';
  readonly tasks: readonly MeshyTask[]; readonly credits: Readonly<Record<string, number | null>>;
  readonly reference: AssetReference | null; readonly reason: string | null;
  readonly providerMayStillRun: boolean;
  readonly createdAt: number; readonly updatedAt: number;
}
interface Entry { input: AssetJobRequest; snapshot: AssetJobSnapshot; controller: AbortController; busy: boolean; polls: number; inFlightCreate: boolean }
const terminal = (s: AssetJobSnapshot) => ['ready', 'failed', 'cancelled'].includes(s.status);

/** Offline coordinator with optional explicit single-owner durability. No HTTP route, spend reservation or implicit polling. */
export function createAssetJobs(deps: { provider: AssetProvider; currentRevision: (stableId: string) => number | null;
  manifest: AssetManifest; loader: AssetLoader; now?: () => number; maxJobs?: number; maxConcurrent?: number;
  maxAgeMs?: number; maxPolls?: number; store?: AssetJobStore }) {
  const now = deps.now ?? Date.now, jobs = new Map<string, Entry>();
  const maxJobs = deps.maxJobs ?? 12, maxConcurrent = deps.maxConcurrent ?? 2;
  const maxAgeMs = deps.maxAgeMs ?? 10 * 60_000, maxPolls = deps.maxPolls ?? 120;
  if (![maxJobs, maxConcurrent, maxAgeMs, maxPolls].every(value => Number.isSafeInteger(value) && value > 0)
    || maxJobs > 12 || maxConcurrent > 2 || maxAgeMs > 10 * 60_000 || maxPolls > 120) throw new Error('Asset job limits exceed the spike budget.');
  const limits = { maxJobs, maxConcurrent, maxAgeMs, maxPolls };
  let version = 0, storageFailed = false;
  const guard = () => { if (storageFailed) throw new Error('Durable asset jobs failed closed'); };
  const state = (entries: readonly Entry[]): AssetJobState => assetJobStateSchema.parse({ format: 'asset-jobs-v1', limits,
    jobs: entries.map(({ input, snapshot, polls, inFlightCreate }) => ({ input, snapshot, polls, inFlightCreate })) });
  const persist = (entries: readonly Entry[]) => {
    guard(); if (!deps.store) return;
    try { const next = state(entries); deps.store.validate(next); version = deps.store.save(next, version); }
    catch (error) { storageFailed = true; throw error; }
  };
  if (deps.store) {
    const loaded = deps.store.load(); version = loaded.version;
    if (loaded.state) {
      const saved = assetJobStateSchema.parse(loaded.state);
      if (canonical(saved.limits) !== canonical(limits)) throw new Error('Durable asset-job limits changed');
      for (const entry of saved.jobs) jobs.set(entry.input.key, { ...entry, controller: new AbortController(), busy: false });
    }
  }
  const read = (e: Entry) => structuredClone(e.snapshot);
  const update = (e: Entry, patch: Partial<AssetJobSnapshot>, fields: Partial<Pick<Entry, 'polls' | 'inFlightCreate'>> = {}) => {
    guard(); const next = { ...e, ...fields, snapshot: { ...e.snapshot, ...patch, updatedAt: now() } };
    if (terminal(next.snapshot)) next.inFlightCreate = false;
    persist([...jobs.values()].map(old => old === e ? next : old)); Object.assign(e, next);
  };
  const fail = (e: Entry, reason: string) => update(e, { status: 'failed', stage: 'terminal', reason });
  const valid = (e: Entry) => {
    if (terminal(e.snapshot)) return false;
    if (deps.currentRevision(e.input.stableId) !== e.input.revision) { fail(e, 'STALE_REVISION'); return false; }
    if (now() - e.snapshot.createdAt > maxAgeMs) { fail(e, 'JOB_DEADLINE'); return false; }
    return true;
  };
  const get = (id: string) => { guard(); const e = jobs.get(id); if (!e) throw new Error('Unknown asset job.'); return e; };
  for (const entry of jobs.values()) if (entry.inFlightCreate) {
    update(entry, { status: 'failed', stage: 'terminal', reason: 'PROVIDER_OUTCOME_UNKNOWN_AFTER_RESTART', providerMayStillRun: true });
  }
  const create = async (e: Entry, request: MeshyRequest, stage: AssetJobSnapshot['stage']) => {
    update(e, { status: 'running', stage, providerMayStillRun: true }, { inFlightCreate: true });
    const task = await deps.provider.create(request, e.controller.signal);
    update(e, { tasks: [...e.snapshot.tasks, task], providerMayStillRun: true }, { inFlightCreate: false });
    if (!valid(e)) {
      try { const result = await deps.provider.cancel(task, AbortSignal.timeout(30_000));
        update(e, { providerMayStillRun: result === 'still-running' }); } catch { /* Unknown provider outcome stays explicit. */ }
    }
  };
  return {
    enqueue(input: AssetJobRequest) {
      guard();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.key) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.stableId)
        || !Number.isSafeInteger(input.revision) || input.revision < 0 || ![1, 2].includes(input.candidate)
        || input.request.kind === ('refine' as string)) throw new Error('Invalid asset job identity.');
      meshyRequestSchema.parse(input.request);
      const old = jobs.get(input.key);
      if (old) { if (canonical(old.input) !== canonical(input)) throw new Error('Idempotency key conflicts with an existing request.'); return read(old); }
      if (jobs.size >= maxJobs) throw new Error('Asset job budget exhausted.');
      if ([...jobs.values()].some(e => e.input.stableId === input.stableId && e.input.candidate === input.candidate))
        throw new Error('Only two distinct candidates are allowed per object in this experiment.');
      const stamp = now();
      const entry: Entry = { input: structuredClone(input), busy: false, polls: 0, inFlightCreate: false, controller: new AbortController(), snapshot: {
        id: input.key, stableId: input.stableId, revision: input.revision, status: 'queued', stage: 'queued', tasks: [], credits: {},
        reference: null, reason: null, providerMayStillRun: false, createdAt: stamp, updatedAt: stamp } };
      persist([...jobs.values(), entry]); jobs.set(input.key, entry); return read(entry);
    },
    getSnapshot(id: string) { return read(get(id)); },
    async advance(id: string) {
      const e = get(id); if (e.busy || !valid(e) || e.snapshot.stage === 'awaiting-import') return read(e);
      if (e.snapshot.status === 'queued' && [...jobs.values()].filter(other => other.snapshot.status === 'running' || other.snapshot.providerMayStillRun).length >= maxConcurrent) return read(e);
      e.busy = true;
      try {
        if (e.snapshot.status === 'queued') {
          await create(e, e.input.request, e.input.request.kind === 'text' ? 'preview' : 'image');
        } else {
          update(e, {}, { polls: e.polls + 1 });
          if (e.polls > maxPolls) { fail(e, 'POLL_BUDGET'); return read(e); }
          const task = e.snapshot.tasks.at(-1)!;
          const result = await deps.provider.poll(task, e.controller.signal);
          if (!valid(e)) return read(e);
          update(e, { credits: { ...e.snapshot.credits, [task.id]: result.credits } });
          if (result.status === 'SUCCEEDED') {
            update(e, { providerMayStillRun: false });
            if (e.snapshot.stage === 'preview') {
              await create(e, { kind: 'refine', previewTaskId: task.id, prompt: e.input.request.prompt }, 'refine');
            } else if (!result.glbUrl) fail(e, 'MISSING_GLB');
            else update(e, { stage: 'awaiting-import' }); // The remote URL is intentionally discarded.
          } else if (result.status === 'FAILED' || result.status === 'CANCELED') {
            update(e, { status: result.status === 'FAILED' ? 'failed' : 'cancelled', stage: 'terminal', reason: result.status, providerMayStillRun: false });
          }
        }
      } catch { if (!terminal(e.snapshot)) fail(e, 'PROVIDER_OUTCOME_UNKNOWN'); }
      finally { e.busy = false; }
      return read(e);
    },
    async cancel(id: string) {
      const e = get(id); if (terminal(e.snapshot)) return read(e);
      update(e, { status: 'cancelled', stage: 'terminal', reason: 'USER_CANCELLED' }); e.controller.abort();
      const task = e.snapshot.tasks.at(-1);
      if (task) try { const outcome = await deps.provider.cancel(task, AbortSignal.timeout(30_000));
        update(e, { providerMayStillRun: outcome === 'still-running' }); } catch { update(e, { providerMayStillRun: true }); }
      return read(e);
    },
    async attachImported(id: string, reference: unknown) {
      const e = get(id); if (e.busy || !valid(e) || e.snapshot.stage !== 'awaiting-import') throw new Error('Job is not ready for an approved local import.');
      const ref = assetReferenceSchema.parse(reference), resolved = deps.manifest.resolve(ref);
      if (!resolved.ok) throw new Error(resolved.reason);
      const task = e.snapshot.tasks.at(-1)!;
      if (resolved.asset.provenance.source !== `meshy:task/${task.id}`) throw new Error('Imported provenance belongs to a different provider task.');
      e.busy = true;
      try {
        const asset = await deps.loader.load(ref);
        disposeSubtree(asset.object);
        if (valid(e)) update(e, { status: 'ready', stage: 'terminal', reference: ref });
      } catch { if (!terminal(e.snapshot)) fail(e, 'IMPORT_VALIDATION_FAILED'); }
      finally { e.busy = false; }
      return read(e);
    },
  };
}
