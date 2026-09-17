import { describe, expect, it, vi } from 'vitest';
import { createMeshyProvider } from '../meshy';
const signal = () => new AbortController().signal;

describe('Meshy adapter with injected transport only', () => {
  it('pins preview/refine and image PBR requests to meshy-6 and GLB', async () => {
    const fetcher = vi.fn(async () => Response.json({ result: 'task-1' }));
    const provider = createMeshyProvider({ apiKey: 'test-only', fetch: fetcher });
    await provider.create({ kind: 'text', prompt: 'coral chair' }, signal());
    await provider.create({ kind: 'refine', previewTaskId: 'task-1', prompt: 'matte ivory' }, signal());
    await provider.create({ kind: 'image', prompt: 'matte ivory', imageDataUri: 'data:image/png;base64,YQ==' }, signal());
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const bodies = calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toMatchObject({ mode: 'preview', ai_model: 'meshy-6', target_formats: ['glb'], target_polycount: 30000 });
    expect(bodies[1]).toMatchObject({ mode: 'refine', preview_task_id: 'task-1', enable_pbr: true, texture_resolution: '2k' });
    expect(bodies[2]).toMatchObject({ ai_model: 'meshy-6', image_enhancement: false, should_texture: true, enable_pbr: true });
    expect(calls[2][0]).toBe('https://api.meshy.ai/openapi/v1/image-to-3d');
    expect(calls.every(([, init]) => init.redirect === 'error')).toBe(true);
  });
  it('does not retry an uncertain POST and never logs provider response secrets', async () => {
    const fetcher = vi.fn(async () => new Response('secret', { status: 503 }));
    await expect(createMeshyProvider({ apiKey: 'secret', fetch: fetcher }).create({ kind: 'text', prompt: 'tool' }, signal()))
      .rejects.toThrow('HTTP 503');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('distinguishes provider deletion from running work that cannot be cancelled', async () => {
    const provider = createMeshyProvider({ apiKey: 'test', fetch: async () => new Response(null, { status: 409 }) });
    expect(await provider.cancel({ id: 'task-1', endpoint: 'text-to-3d' }, signal())).toBe('still-running');
  });
  it('rejects injected IDs, mismatched responses and remote image inputs', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'other', status: 'SUCCEEDED' }));
    const provider = createMeshyProvider({ apiKey: 'test', fetch: fetcher });
    await expect(provider.poll({ id: '../evil', endpoint: 'text-to-3d' }, signal())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(provider.poll({ id: 'task-1', endpoint: 'text-to-3d' }, signal())).rejects.toThrow('identity');
    await expect(provider.create({ kind: 'image', prompt: 'tool', imageDataUri: 'https://example.test/image.png' }, signal())).rejects.toThrow();
  });
});
