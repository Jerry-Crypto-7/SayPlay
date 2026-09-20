import { z } from 'zod';

/** Pinned API contract, reviewed 2026-09-17. No implicit network or credential lookup. */
export const MESHY_MODEL = 'meshy-6' as const;
const taskId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);
const prompt = z.string().min(1).max(800);
export const meshyRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), prompt }).strict(),
  z.object({ kind: z.literal('image'), prompt,
    imageDataUri: z.string().max(8 * 1024 * 1024).regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  z.object({ kind: z.literal('refine'), previewTaskId: taskId, prompt }).strict(),
]);
export type MeshyRequest = z.infer<typeof meshyRequestSchema>;
export interface MeshyTask { readonly id: string; readonly endpoint: 'text-to-3d' | 'image-to-3d' }
export interface MeshyResult {
  readonly status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  readonly credits: number | null;
  /** Quarantine metadata only. Never forwarded to the runtime loader. */
  readonly glbUrl: string | null;
}
export interface AssetProvider {
  create(request: MeshyRequest, signal: AbortSignal): Promise<MeshyTask>;
  poll(task: MeshyTask, signal: AbortSignal): Promise<MeshyResult>;
  cancel(task: MeshyTask, signal: AbortSignal): Promise<'deleted' | 'still-running'>;
}
const resultSchema = z.object({ id: taskId,
  status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
  consumed_credits: z.number().finite().nonnegative().optional(),
  model_urls: z.object({ glb: z.string().url().max(4096).optional() }).optional(),
});

export function createMeshyProvider(options: { apiKey: string; fetch: typeof fetch; timeoutMs?: number }): AssetProvider {
  if (!options.apiKey.trim()) throw new Error('An explicitly supplied Meshy key is required.');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid provider request deadline.');
  const path = (task: MeshyTask) => {
    const id = taskId.parse(task.id);
    if (!['text-to-3d', 'image-to-3d'].includes(task.endpoint)) throw new Error('Invalid task endpoint.');
    return `/openapi/${task.endpoint === 'text-to-3d' ? 'v2' : 'v1'}/${task.endpoint}/${id}`;
  };
  async function call(pathname: string, method: string, signal: AbortSignal, payload?: unknown) {
    const response = await options.fetch(`https://api.meshy.ai/${pathname.slice(1)}`, { method, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (method === 'DELETE' && response.status === 409) return 'still-running' as const;
    if (!response.ok || response.redirected) throw new Error(`Meshy ${method} failed with HTTP ${response.status}; no automatic create retry.`);
    if (method === 'DELETE') return 'deleted' as const;
    // API metadata is small. Bound the stream before JSON parsing.
    if (!response.body) throw new Error('Meshy returned an empty response.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > 256 * 1024) throw new Error('Meshy response exceeds metadata budget.'); chunks.push(next.value); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    const all = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(all)) as unknown;
  }
  return {
    async create(input, signal) {
      const request = meshyRequestSchema.parse(input);
      const endpoint = request.kind === 'image' ? 'image-to-3d' as const : 'text-to-3d' as const;
      const common = { ai_model: MESHY_MODEL, target_formats: ['glb'], moderation: true };
      const body = request.kind === 'refine' ? { ...common, mode: 'refine', preview_task_id: request.previewTaskId,
        texture_prompt: request.prompt, enable_pbr: true, texture_resolution: '2k' }
        : { ...common, model_type: 'standard', should_remesh: true, topology: 'triangle', target_polycount: 30000,
          ...(request.kind === 'text' ? { mode: 'preview', prompt: request.prompt }
            : { image_url: request.imageDataUri, texture_prompt: request.prompt, should_texture: true,
              enable_pbr: true, texture_resolution: '2k', image_enhancement: false }) };
      const parsed = z.object({ result: taskId }).parse(await call(`/openapi/${endpoint === 'text-to-3d' ? 'v2' : 'v1'}/${endpoint}`, 'POST', signal, body));
      return { id: parsed.result, endpoint };
    },
    async poll(task, signal) {
      const parsed = resultSchema.parse(await call(path(task), 'GET', signal));
      if (parsed.id !== task.id) throw new Error('Meshy returned a different task identity.');
      const glbUrl = parsed.model_urls?.glb ?? null;
      if (glbUrl && new URL(glbUrl).protocol !== 'https:') throw new Error('Meshy download metadata must use HTTPS.');
      return { status: parsed.status, credits: parsed.consumed_credits ?? null, glbUrl };
    },
    async cancel(task, signal) { return await call(path(task), 'DELETE', signal) as 'deleted' | 'still-running'; },
  };
}
