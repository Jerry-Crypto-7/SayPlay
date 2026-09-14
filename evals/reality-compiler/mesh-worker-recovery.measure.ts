/** Actual native browser workers, with explicitly synthetic messageerror injection. */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { rolldown, VERSION } from 'rolldown';
import { expect, it } from 'vitest';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const ownedSources = ['src/shape/mesh-client.ts', 'src/shape/mesh-worker.ts', 'src/shape/schema.ts',
  'src/shape/surface-nets.ts', 'src/shape/field.ts', 'src/shape/types.ts', 'src/shape/__tests__/mesh.test.ts',
  'evals/reality-compiler/mesh-worker-recovery.measure.ts', 'evals/reality-compiler/mesh-worker-recovery.md',
  'node_modules/rolldown/package.json', 'node_modules/@playwright/test/package.json'];
function source(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NONREGULAR_SOURCE');
  const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: sha(bytes) };
}

it.skipIf(process.env.RC_MESH_WORKER_RECOVERY !== '1')('recovers queued native-worker meshing after synthetic messageerror and ignores retired delivery', async () => {
  const directory = resolve('scratch/session8-mesh-worker-recovery', randomUUID()); mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const initial = ownedSources.map(source);
  write('sources-initial.json', initial);
  expect(initial.find(value => value.path === 'src/shape/mesh-client.ts')?.sha256).toBe('9df2ad3e3ace63713f3df0e5dd1316cd89177e4bdbb53d57ec1d4a91d8f12bb9');
  expect(initial.find(value => value.path === 'src/shape/__tests__/mesh.test.ts')?.sha256).toBe('aa83e337a5d7ed82ac834dc1c08320c7aaa41e8b04e0a5f544e12b1a017ff8a7');
  write('frozen.json', { scenario: 'synthetic-messageerror-native-worker-recovery', resolution: 16, seed: 20260829,
    warmup: 'One fixed radius0.6 sphere on the first worker before starting A; proves the native worker started before termination.',
    expected: { first: 'rejected', second: 'valid-native-worker-mesh', workersCreated: 2, mainThreadFallback: false },
    injection: 'Untrusted synthetic MessageEvent; not an actual deserialization failure.', bundler: `local rolldown ${VERSION}`,
    modelCalls: 0, auth: 'NOT_RUN', inference: 'NOT_RUN', threeDFrame: 'NOT_RUN', gpuPerformance: 'NOT_MEASURED' });
  const consumed = new Map<string, ReturnType<typeof source>>();
  const bundle = async (entry: string) => {
    const build = await rolldown({ input: resolve(entry), platform: 'browser', plugins: [{ name: 'record-consumed-source',
      load(id) {
        if (!isAbsolute(id) || !/\.[cm]?[jt]s$/.test(id)) return null;
        const path = relative(process.cwd(), id).replaceAll('\\', '/');
        if (path.startsWith('../')) throw new Error('BUNDLE_SOURCE_OUTSIDE_WORKSPACE');
        const entry = source(path); const previous = consumed.get(path);
        if (previous && previous.sha256 !== entry.sha256) throw new Error('BUNDLE_SOURCE_DRIFT');
        consumed.set(path, entry);
        const code = readFileSync(id, 'utf8');
        if (sha(code) !== entry.sha256) throw new Error('BUNDLE_SOURCE_READ_DRIFT');
        return { code };
      },
    }] });
    try {
      const generated = await build.generate({ format: 'esm', codeSplitting: false, sourcemap: false });
      if (generated.output.length !== 1 || generated.output[0].type !== 'chunk') throw new Error('UNEXPECTED_BUNDLE_OUTPUT');
      return generated.output[0].code;
    } finally { await build.close(); }
  };
  let browser: Browser | undefined, context: BrowserContext | undefined;
  let result: unknown = null, caught: unknown = null, before: ReturnType<typeof source>[] = [], sourceStable = false;
  const workerEvents: unknown[] = [], httpRequests: unknown[] = [], pageErrors: string[] = [];
  const cleanup = { clientDisposed: false, nativeWorkerCloses: 0, contextClosed: false, browserClosed: false,
    serverClosed: false, portRefused: false };
  const routes = new Map<string, { body: Buffer; type: string }>();
  const server = createServer((request, response) => {
    httpRequests.push({ method: request.method, path: request.url });
    const route = routes.get(request.url ?? '');
    if (request.method !== 'GET' || !route) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': route.type, 'Cache-Control': 'no-store' }); response.end(route.body);
  });
  let port = 0;
  try {
    const client = await bundle('src/shape/mesh-client.ts'), worker = await bundle('src/shape/mesh-worker.ts');
    writeFileSync(resolve(directory, 'mesh-client.js'), client, { flag: 'wx' });
    writeFileSync(resolve(directory, 'mesh-worker.js'), worker, { flag: 'wx' });
    write('bundle-receipt.json', { bundler: VERSION, client: { bytes: Buffer.byteLength(client), sha256: sha(client) },
      worker: { bytes: Buffer.byteLength(worker), sha256: sha(worker) }, consumed: [...consumed.values()] });
    before = [...new Set([...ownedSources, ...consumed.keys()])].sort().map(source);
    for (const value of initial) expect(before.find(item => item.path === value.path)).toEqual(value);
    for (const value of consumed.values()) expect(before.find(item => item.path === value.path)).toEqual(value);
    write('sources-before-browser.json', before);
    routes.set('/', { body: Buffer.from('<!doctype html><meta charset="utf-8"><title>Fixture native worker recovery</title><p>Fault injection fixture. No 3D frame or model inference.</p>'), type: 'text/html; charset=utf-8' });
    routes.set('/mesh-client.js', { body: Buffer.from(client), type: 'text/javascript; charset=utf-8' });
    routes.set('/mesh-worker.js', { body: Buffer.from(worker), type: 'text/javascript; charset=utf-8' });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('NO_OWN_SERVER_PORT'); port = address.port;
    const baseURL = `http://127.0.0.1:${port}`;
    write('server.json', { baseURL, owned: true, staticRoutes: [...routes.keys()] });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('worker', worker => {
      const index = workerEvents.length + 1; workerEvents.push({ event: 'created', index, url: worker.url() });
      worker.on('close', () => { cleanup.nativeWorkerCloses++; workerEvents.push({ event: 'closed', index }); });
    });
    await page.goto(baseURL, { waitUntil: 'load', timeout: 15000 });
    result = await page.evaluate(async () => {
      const moduleURL = new URL('/mesh-client.js', location.href).href;
      // Keep the browser import out of Vite's server-side test transform.
      const { createMeshClient } = await new Function('url', 'return import(url)')(moduleURL);
      const workers: Worker[] = [], terminateCounts: number[] = [], events: unknown[] = [];
      const client = createMeshClient({ allowMainThread: false, createWorker: () => {
        const worker = new Worker('/mesh-worker.js', { type: 'module' }), index = workers.length;
        workers.push(worker); terminateCounts.push(0);
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { terminateCounts[index]++; terminate(); };
        worker.addEventListener('message', event => events.push({ event: 'native-message', worker: index, isTrusted: event.isTrusted, jobId: event.data?.jobId }));
        return worker;
      } });
      const bounds = { min: [-2, -2, -2], max: [2, 2, 2] };
      const order = (shapeId: string, radius: number) => ({ program: { shapeId, stableId: shapeId, nodes: [{ kind: 'sphere', radius }], root: 0,
        targetBounds: bounds, anchors: [], materialIntent: 'clay', priority: 0 }, sessionSeed: 20260829, resolution: 16, bounds });
      let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('BROWSER_WORKER_DEADLINE')), 15000); });
      try {
        const warmed = await Promise.race([client.mesh(order('warmup', 0.6)), limit]);
        if (warmed.vertexCount <= 0 || warmed.triangleCount <= 0 || client.pending !== 0) throw new Error('NATIVE_WORKER_WARMUP_FAILED');
        const first = client.mesh(order('fault-A', 1)).then(() => ({ outcome: 'resolved', error: null }), (error: Error) => ({ outcome: 'rejected', error: error.message }));
        const second = client.mesh(order('recovered-B', 0.8));
        const pendingBefore = client.pending;
        const retired = workers[0], fault = new MessageEvent('messageerror');
        retired.dispatchEvent(fault);
        const pendingAfterFailure = client.pending, workersAfterFailure = workers.length;
        retired.dispatchEvent(new MessageEvent('messageerror'));
        retired.dispatchEvent(new ErrorEvent('error', { message: 'synthetic late retired error' }));
        const pendingAfterLate = client.pending;
        const [firstResult, mesh] = await Promise.race([Promise.all([first, second]), limit]);
        const positions = Array.from(mesh.positions as Float32Array), normals = Array.from(mesh.normals as Float32Array), indices = Array.from(mesh.indices as Uint32Array);
        const valid = mesh.positions instanceof Float32Array && mesh.normals instanceof Float32Array && mesh.indices instanceof Uint32Array &&
          mesh.vertexCount > 0 && mesh.triangleCount > 0 && positions.length === mesh.vertexCount * 3 && normals.length === positions.length &&
          indices.length === mesh.triangleCount * 3 && positions.every(Number.isFinite) && normals.every(Number.isFinite) &&
          indices.every(value => Number.isInteger(value) && value >= 0 && value < mesh.vertexCount) &&
          positions.every(value => Math.abs(value) <= 2.3);
        const pendingAfterSuccess = client.pending;
        client.dispose(); disposed = true;
        return { warmup: { shapeId: warmed.shapeId, vertexCount: warmed.vertexCount, triangleCount: warmed.triangleCount }, first: firstResult, second: { shapeId: mesh.shapeId, valid, vertexCount: mesh.vertexCount, triangleCount: mesh.triangleCount,
          bounds: mesh.bounds, workerComputeElapsedMs: mesh.elapsedMs, positions, normals, indices }, pendingBefore, pendingAfterFailure,
          pendingAfterLate, pendingAfterSuccess, workersAfterFailure, workersCreated: workers.length, terminateCounts,
          faultIsTrusted: fault.isTrusted, events, clientDisposed: disposed, mainThreadFallback: false };
      } finally { if (timer) clearTimeout(timer); if (!disposed) client.dispose(); }
    });
    cleanup.clientDisposed = (result as { clientDisposed?: boolean }).clientDisposed === true;
    write('browser-result.json', result);
    expect(result).toMatchObject({ first: { outcome: 'rejected', error: 'mesh worker response could not be deserialized' },
      second: { shapeId: 'recovered-B', valid: true }, pendingBefore: 2, pendingAfterFailure: 1, pendingAfterLate: 1,
      pendingAfterSuccess: 0, workersAfterFailure: 2, workersCreated: 2, terminateCounts: [1, 1], faultIsTrusted: false, clientDisposed: true });
    const emitted = (result as { events: { event: string; worker: number; isTrusted: boolean }[] }).events;
    expect(emitted.some(event => event.event === 'native-message' && event.worker === 0 && event.isTrusted)).toBe(true);
    expect(emitted.some(event => event.event === 'native-message' && event.worker === 1 && event.isTrusted)).toBe(true);
    expect(pageErrors).toEqual([]);
  } catch (error) { caught = error; }
  finally {
    try { if (context) { await context.close(); cleanup.contextClosed = true; } } catch (error) { caught ??= error; }
    try { if (browser) { await browser.close(); cleanup.browserClosed = !browser.isConnected(); } } catch (error) { caught ??= error; }
    try { if (server.listening) {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } } catch (error) { caught ??= error; }
    cleanup.serverClosed = !server.listening;
    if (port) cleanup.portRefused = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', error => resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    const after = (before.length ? before.map(value => value.path) : ownedSources).map(source);
    write('sources-after.json', after); write('cleanup.json', cleanup); write('http-requests.json', httpRequests); write('worker-events.json', workerEvents);
    sourceStable = before.length > 0 && JSON.stringify(before) === JSON.stringify(after);
    write('summary.json', { status: !caught && sourceStable && cleanup.nativeWorkerCloses === 2 && cleanup.clientDisposed && cleanup.contextClosed && cleanup.browserClosed && cleanup.serverClosed && cleanup.portRefused ? 'PASS' : 'FAIL',
      sourceStable, error: caught ? String(caught) : null, result, cleanup, workerEvents, pageErrors,
      modelCalls: 0, actualNativeWorkers: workerEvents.filter(value => (value as { event: string }).event === 'created').length,
      faultInjection: 'synthetic-untrusted-messageerror', actualDeserializationFault: 'NOT_RUN', threeDFrame: 'NOT_RUN', gpuPerformance: 'NOT_MEASURED' });
  }
  console.log(`MESH_WORKER_RECOVERY_ARTIFACT ${directory}`);
  if (caught) throw caught;
  expect(sourceStable).toBe(true);
  expect(cleanup).toMatchObject({ clientDisposed: true, nativeWorkerCloses: 2, contextClosed: true, browserClosed: true, serverClosed: true, portRefused: true });
}, 60000);
