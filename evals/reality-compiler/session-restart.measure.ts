import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { blueprintSchema } from '../../src/worldstream/schema';
import { buildRuntimeWorld } from '../../src/ir/build';

const PROMPT = 'A cathedral of stacked shipping containers around a light well.';
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

async function bounded<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('RESTART_PORT_UNAVAILABLE')));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(error => error ? reject(error) : done()));
  });
}

interface OwnedServer { child: ChildProcess; closed: Promise<void>; ready: Promise<void>; isClosed: () => boolean }

function startOwnedServer(port: number): OwnedServer {
  // Direct node child: no shell, no process-name lookup or tree-wide killing.
  const child = execFile(process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, WORLDSMITH_MODEL_ENDPOINT: '', WORLDSMITH_MODEL_KEY: '', NEXT_TELEMETRY_DISABLED: '1' } });
  let exited = false;
  const closed = new Promise<void>(done => child.once('close', () => { exited = true; done(); }));
  const ready = new Promise<void>((done, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output = (output + String(chunk)).slice(-4096);
      if (/Ready in/.test(output)) { child.stdout?.off('data', onData); done(); }
    };
    child.stdout?.on('data', onData);
    child.once('error', () => reject(new Error('RESTART_SERVER_SPAWN_FAILED')));
    child.once('close', () => reject(new Error('RESTART_SERVER_EXITED_BEFORE_READY')));
  });
  return { child, closed, ready, isClosed: () => exited };
}

async function stopOwnedServer(server: OwnedServer): Promise<void> {
  if (server.isClosed()) return;
  server.child.kill('SIGTERM');
  try { await bounded(server.closed, 5_000, 'RESTART_STOP_TIMEOUT'); }
  catch {
    // Escalation is still solely through the child handle created above.
    if (!server.isClosed()) server.child.kill('SIGKILL');
    await bounded(server.closed, 5_000, 'RESTART_OWNED_CHILD_DID_NOT_EXIT');
  }
}

it('proves process-local sessions disappear on production restart while a new prepared world remains usable', async () => {
  const port = Number(process.env.RC_RESTART_PORT ?? 3119);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_RESTART_PORT');
  const directory = resolve('scratch/session-restart', randomUUID());
  mkdirSync(directory, { recursive: true });
  const report: Record<string, unknown> = {
    status: 'NOT_RUN', mode: 'offline-prepared', humanObservation: false, liveRequests: 0,
    startedAt: new Date().toISOString(), port, steps: [],
  };
  const steps = report.steps as Record<string, unknown>[];
  const baseURL = `http://127.0.0.1:${port}`;
  let owned: OwnedServer | undefined;
  const request = async (path: string, init?: RequestInit) => {
    if (!owned || owned.isClosed() || owned.child.exitCode !== null || owned.child.signalCode !== null)
      throw new Error('RESTART_OWNED_SERVER_NOT_RUNNING');
    return fetch(`${baseURL}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  };
  const freshWorld = async () => {
    const response = await request('/api/worldstream/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: PROMPT }),
    });
    expect(response.status).toBe(202);
    const handle = await response.json();
    expect(handle.authored?.match).toBe('exact');
    expect(handle.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const snapshotResponse = await request(`/api/worldstream/sessions/${handle.sessionId}`);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json();
      if (snapshot.fault) throw new Error('RESTART_PREPARED_WORLD_FAULT');
      if (snapshot.blueprint) {
        const blueprint = blueprintSchema.parse(snapshot.blueprint);
        expect(buildRuntimeWorld(blueprint.world.sim).ok).toBe(true);
        return { sessionId: handle.sessionId as string, authored: handle.authored.match as string,
          blueprintReady: true, runtimeBuildValid: true, phase: snapshot.phase };
      }
      await pause(100);
    }
    throw new Error('RESTART_PREPARED_BLUEPRINT_TIMEOUT');
  };
  try {
    await requireFreePort(port);
    owned = startOwnedServer(port);
    await bounded(owned.ready, 30_000, 'RESTART_BUILD_REQUIRED_OR_START_TIMEOUT');
    const original = await freshWorld();
    steps.push({ step: 'before-restart', ...original });
    await stopOwnedServer(owned);
    steps.push({ step: 'owned-process-exited', complete: true });
    owned = undefined;
    await requireFreePort(port);
    owned = startOwnedServer(port);
    await bounded(owned.ready, 30_000, 'RESTART_BUILD_REQUIRED_OR_START_TIMEOUT');
    const expired = await request(`/api/worldstream/sessions/${original.sessionId}`);
    const expiredBody = await expired.json();
    expect(expired.status).toBe(404);
    expect(expiredBody.error?.code).toBe('UNKNOWN_SESSION');
    steps.push({ step: 'old-session-after-restart', status: expired.status, code: expiredBody.error.code });
    const replacement = await freshWorld();
    expect(replacement.sessionId).not.toBe(original.sessionId);
    steps.push({ step: 'fresh-session-after-restart', ...replacement });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try { if (owned) await stopOwnedServer(owned); }
    catch (error) {
      report.status = 'FAIL'; report.cleanupFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      report.finishedAt = new Date().toISOString();
      writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
      console.log(`SESSION_RESTART ${report.status} ${directory}; offline, not a human observation`);
    }
  }
}, 180_000);
