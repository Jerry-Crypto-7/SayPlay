import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { meshyRequestSchema } from '@/assets/providers/meshy';
import { assetReferenceSchema } from '@/assets/schema';

const task = z.object({ id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/), endpoint: z.enum(['text-to-3d', 'image-to-3d']) }).strict();
const finite = z.number().finite().nonnegative();
const input = z.object({ key: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), stableId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  revision: z.int().nonnegative(), candidate: z.union([z.literal(1), z.literal(2)]),
  request: z.union([meshyRequestSchema.options[0], meshyRequestSchema.options[1]]) }).strict();
const snapshot = z.object({ id: input.shape.key, stableId: input.shape.stableId, revision: input.shape.revision,
  status: z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']),
  stage: z.enum(['queued', 'preview', 'refine', 'image', 'awaiting-import', 'terminal']),
  tasks: z.array(task).max(2), credits: z.record(z.string().max(128), finite.nullable()).refine(v => Object.keys(v).length <= 2),
  reference: assetReferenceSchema.nullable(), reason: z.string().max(256).nullable(), providerMayStillRun: z.boolean(), createdAt: finite, updatedAt: finite }).strict();
export const assetJobStateSchema = z.object({ format: z.literal('asset-jobs-v1'),
  limits: z.object({ maxJobs: z.int().min(1).max(12), maxConcurrent: z.int().min(1).max(2), maxAgeMs: z.int().min(1).max(600000), maxPolls: z.int().min(1).max(120) }).strict(),
  jobs: z.array(z.object({ input, snapshot, polls: z.int().min(0).max(121), inFlightCreate: z.boolean() }).strict()).max(12),
}).strict().superRefine((state, ctx) => {
  const ids = new Set<string>(), candidates = new Set<string>();
  for (const entry of state.jobs) {
    const s = entry.snapshot, key = `${entry.input.stableId}/${entry.input.candidate}`;
    if (ids.has(entry.input.key) || candidates.has(key) || s.id !== entry.input.key || s.stableId !== entry.input.stableId || s.revision !== entry.input.revision
      || (s.status === 'queued' && (s.stage !== 'queued' || s.tasks.length !== 0 || entry.inFlightCreate))
      || (s.status === 'running' && (!['preview', 'image', 'refine', 'awaiting-import'].includes(s.stage) || (!entry.inFlightCreate && s.tasks.length === 0)))
      || (s.status === 'running' && s.stage === 'refine' && !entry.inFlightCreate && s.tasks.length !== 2)
      || (['ready', 'failed', 'cancelled'].includes(s.status) && s.stage !== 'terminal')
      || (s.status === 'ready' && s.reference === null) || (entry.inFlightCreate && s.status !== 'running')
      || s.updatedAt < s.createdAt || Object.keys(s.credits).some(id => !s.tasks.some(t => t.id === id)))
      ctx.addIssue({ code: 'custom', message: 'Inconsistent persisted asset job' });
    ids.add(entry.input.key); candidates.add(key);
  }
  if (state.jobs.length > state.limits.maxJobs || state.jobs.filter(e => e.snapshot.status === 'running').length > state.limits.maxConcurrent)
    ctx.addIssue({ code: 'custom', message: 'Persisted job budget exceeded' });
});
export type AssetJobState = z.infer<typeof assetJobStateSchema>;
export interface AssetJobStore {
  load(): { version: number; state: AssetJobState | null };
  /** Preflight before any in-memory mutation or provider operation. */
  validate(state: AssetJobState): void;
  save(state: AssetJobState, expectedVersion: number): number;
}
const envelope = z.object({ version: z.int().positive(), state: assetJobStateSchema }).strict();
const DEFAULT_BYTES = 16 * 1024 ** 2;

/** Single local process owner. The exclusive lock is NOT a distributed lease.
 * An abrupt crash leaves a lock requiring operator removal after proving the old
 * process stopped; never steal it based on time or a reused PID. No env lookup. */
export function openAssetJobFileStore(file: string, options: { maxBytes?: number } = {}): AssetJobStore & { close(): void } {
  const target = resolve(file), maxBytes = options.maxBytes ?? DEFAULT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > DEFAULT_BYTES) throw new Error('Invalid durable asset-job byte limit');
  mkdirSync(dirname(target), { recursive: true });
  const lockPath = `${target}.lock`, token = randomUUID();
  const lock = openSync(lockPath, 'wx', 0o600);
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, token })); fsyncSync(lock); } finally { closeSync(lock); }
  let closed = false;
  const guard = () => {
    if (closed || JSON.parse(readFileSync(lockPath, 'utf8')).token !== token) throw new Error('Asset job store ownership lost');
  };
  const serialize = (state: AssetJobState, version: number) => {
    if (state.jobs.reduce((bytes, entry) => bytes + (entry.input.request.kind === 'image' ? Buffer.byteLength(entry.input.request.imageDataUri) : 0), 0) > maxBytes)
      throw new Error('Durable asset job byte budget exceeded');
    const value = JSON.stringify({ version, state: assetJobStateSchema.parse(state) });
    if (Buffer.byteLength(value) > maxBytes) throw new Error('Durable asset job byte budget exceeded'); return value;
  };
  const load = () => {
    guard(); if (!existsSync(target)) return { version: 0, state: null };
    const fd = openSync(target, 'r');
    try {
      const size = fstatSync(fd).size; if (size <= 0 || size > maxBytes) throw new Error('Invalid durable asset job file size');
      const bytes = Buffer.alloc(size + 1); let count = 0;
      while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
      if (count !== size) throw new Error('Durable asset job file changed while reading');
      return envelope.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
    } finally { closeSync(fd); }
  };
  return { load, validate(state) { guard(); serialize(state, Number.MAX_SAFE_INTEGER); },
    save(state, expectedVersion) {
      guard(); const current = load(); if (current.version !== expectedVersion) throw new Error('Stale durable asset job writer');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) throw new Error('Durable asset job version exhausted');
      const next = expectedVersion + 1, bytes = serialize(state, next), temporary = `${target}.${token}.tmp`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { replaceAssetJobFile(temporary, target); }
      catch (error) { try { unlinkSync(temporary); } catch { /* Preserve original error. */ } throw error; }
      // Directory durability supported by the selected Linux host. Windows cannot fsync directories.
      if (process.platform !== 'win32') { const directory = openSync(dirname(target), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
      return next;
    },
    close() { if (closed) return; guard(); unlinkSync(lockPath); closed = true; },
  };
}

/** Windows file scanners may briefly deny replacement of a closed target.
 * Retry only the same atomic rename; never delete the accepted file first.
 * Permanent I/O errors still escape to the coordinator's fail-closed barrier. */
export function replaceAssetJobFile(source: string, target: string, options: {
  platform?: string; rename?: typeof renameSync; wait?: (ms: number) => void;
} = {}): void {
  const rename = options.rename ?? renameSync;
  const wait = options.wait ?? ((ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const delays = [10, 25, 50];
  for (let attempt = 0; ; attempt++) {
    try { rename(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((options.platform ?? process.platform) !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= delays.length) throw error;
      wait(delays[attempt]);
    }
  }
}
