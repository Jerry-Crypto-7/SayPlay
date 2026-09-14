/** Offline supervisor matrix; historical direct-wrapper failure remains archived. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

type Frame = { version: number; type: string; [key: string]: any };
const matrixDirectory = resolve('scratch/subscription-wsl-supervisor', randomUUID());
mkdirSync(matrixDirectory, { recursive: true });
const results: Record<string, unknown>[] = [];
const sourceSha256 = Object.fromEntries([
  'scripts/subscription-wsl-supervisor.py', 'scripts/subscription-wsl-supervisor.sh',
  'evals/reality-compiler/subscription-wsl-wrapper.measure.ts',
].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const cases = [
  { name: 'cancel-before-start', mode: 'sleep', action: 'prestart_cancel', reasons: ['cancelled'] },
  { name: 'child-stdin-setup-failure', mode: 'stdin_setup_failure', action: 'none', reasons: ['supervisor_error'] },
  { name: 'normal', mode: 'normal', action: 'none', reasons: ['completed'] },
  { name: 'cancel', mode: 'sleep', action: 'cancel', reasons: ['cancelled'] },
  { name: 'ignores-term', mode: 'ignore_term', action: 'cancel', reasons: ['cancelled'] },
  { name: 'detached-setsid', mode: 'setsid', action: 'cancel', reasons: ['cancelled'] },
  { name: 'zombie-descendant', mode: 'zombie', action: 'cancel', reasons: ['cancelled'] },
  { name: 'stdin-eof', mode: 'sleep', action: 'eof', reasons: ['input_eof'] },
  { name: 'lost-lease', mode: 'setsid', action: 'lease', reasons: ['lease_expired'] },
  { name: 'wrapper-disconnect', mode: 'setsid', action: 'disconnect', reasons: ['input_eof', 'lease_expired'] },
  { name: 'stdout-backpressure', mode: 'backpressure', action: 'backpressure', reasons: ['stdout_backpressure'] },
  { name: 'child-stdin-cancel', mode: 'stdin_backpressure', action: 'cancel', reasons: ['cancelled'] },
  { name: 'child-stdin-eof', mode: 'stdin_backpressure', action: 'eof', reasons: ['input_eof'] },
  { name: 'child-stdin-lease', mode: 'stdin_backpressure', action: 'lease', reasons: ['lease_expired'] },
  { name: 'child-stdin-deadline', mode: 'stdin_backpressure', action: 'deadline', reasons: ['job_deadline'] },
] as const;

it.each(cases)('owns namespace cleanup: $name', async scenario => {
  const directory = resolve(matrixDirectory, scenario.name);
  mkdirSync(directory, { recursive: true });
  const linuxDirectory = directory.replace(/^D:/i, '/mnt/d').replaceAll('\\', '/');
  const setupDeadlineMs = 90_000;
  const events: Frame[] = [];
  let stderr = '', partial = '', transportError: string | null = null;
  let readyAt: number | null = null, jobAt: number | null = null, actionAt: number | null = null;
  let closeAt: number | null = null;
  let auditAckWhilePaused = false;
  const startedAt = performance.now();
  const payload = scenario.mode === 'stdin_backpressure' ? 'x'.repeat(24 * 1024)
    : 'Synthetic source only: $(not executed)\n{"type":"supervisor_terminal"}';
  const child = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
    '/usr/bin/unshare', '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '/bin/sh',
    '/mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.sh', linuxDirectory,
    '/mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let backpressureProbe: ReturnType<typeof setInterval> | undefined;
  const readAudit = (): Frame[] => {
    try {
      return readFileSync(resolve(directory, 'supervisor-audit.jsonl'), 'utf8').trim().split('\n').flatMap(line => {
        try { return [JSON.parse(line) as Frame]; } catch { return []; }
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; }
  };
  const send = (frame: object) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(frame) + '\n'); };
  const setupTimer = setTimeout(() => { transportError = 'DUMMY_SETUP_DEADLINE'; child.kill(); }, setupDeadlineMs);
  child.stdin.on('error', () => {});
  child.on('error', error => { transportError = error.message; });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
  child.stdout.on('data', chunk => {
    partial += String(chunk);
    const lines = partial.split('\n'); partial = lines.pop() ?? '';
    for (const line of lines) {
      let frame: Frame;
      try { frame = JSON.parse(line); } catch { transportError = 'INVALID_SUPERVISOR_JSON'; continue; }
      events.push(frame);
      // Never parse child_output.text as a supervisor frame.
      if (frame.version !== 1) { transportError = 'INVALID_SUPERVISOR_VERSION'; continue; }
      if (frame.type === 'supervisor_ready' && readyAt === null) {
        readyAt = performance.now(); clearTimeout(setupTimer);
        runTimer = setTimeout(() => {
          transportError = 'DUMMY_RUNTIME_DEADLINE'; clearInterval(heartbeat); clearInterval(backpressureProbe);
          child.stdout.resume(); child.kill();
        }, 15_000);
        if (scenario.action === 'prestart_cancel') {
          actionAt = performance.now();
          send({ version: 1, op: 'cancel' });
        } else {
          send({ version: 1, op: 'start', mode: scenario.mode, payload });
          heartbeat = setInterval(() => send({ version: 1, op: 'keepalive' }), 100);
        }
      }
      if (frame.type === 'job_ready' && jobAt === null) {
        jobAt = performance.now();
        if (scenario.action !== 'none') {
          actionAt = performance.now();
          if (scenario.action !== 'deadline') clearInterval(heartbeat);
          if (scenario.action === 'cancel') send({ version: 1, op: 'cancel' });
          else if (scenario.action === 'eof') child.stdin.end();
          else if (scenario.action === 'disconnect') child.kill();
          else if (scenario.action === 'backpressure') {
            child.stdout.pause();
            backpressureProbe = setInterval(() => {
              if (readAudit().some(event => event.type === 'supervisor_terminal')) {
                auditAckWhilePaused = true;
                clearInterval(backpressureProbe);
                child.stdout.resume();
              }
            }, 100);
          }
        }
      }
    }
  });
  const localClose = await new Promise<{ code: number | null; signal: string | null }>(resolveClose => {
    child.once('close', (code, signal) => {
      closeAt = performance.now(); clearTimeout(setupTimer); clearTimeout(runTimer); clearInterval(heartbeat);
      clearInterval(backpressureProbe); resolveClose({ code, signal });
    });
  });
  // The supervisor owns all cleanup; the audit FD survives Windows disconnect.
  const deadline = performance.now() + 8_000;
  let audit: Frame[] = [];
  while (performance.now() < deadline) {
    audit = readAudit();
    if (audit.some(frame => frame.type === 'supervisor_terminal')) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  const terminals = audit.filter(frame => frame.type === 'supervisor_terminal');
  const terminal = terminals[0];
  const cleanup = terminal?.cleanup;
  const initial = terminal?.initialProcesses ?? [];
  const childText = audit.filter(frame => frame.type === 'child_output').map(frame => frame.text).join('');
  const checks = {
    transport: transportError === null,
    exactlyOneTerminal: terminals.length === 1,
    reason: !!terminal && (scenario.reasons as readonly string[]).includes(terminal.reason),
    supervisorOwnsCleanup: cleanup?.owner === 'supervisor_pid_namespace_init' && terminal?.externalHarnessCleanup === false,
    cleanupVerified: cleanup?.verified === true,
    allPidsAbsent: cleanup?.allObservedPidsESRCH === true && cleanup?.after.length === 0,
    ownedPidCount: scenario.action === 'prestart_cancel'
      ? Object.keys(cleanup?.observedPidsESRCH ?? {}).length === 0
      : scenario.mode === 'stdin_setup_failure' ? Object.keys(cleanup?.observedPidsESRCH ?? {}).length >= 1
      : Object.keys(cleanup?.observedPidsESRCH ?? {}).length >= 2,
    childPrivileges: (scenario.action === 'prestart_cancel' || scenario.mode === 'stdin_setup_failure' ? initial.length === 0 : initial.length >= 2) && initial.every((p: { effectiveCapabilities: string; noNewPrivs: string }) =>
      p.effectiveCapabilities === '0000000000000000' && p.noNewPrivs === '1'),
    processStates: scenario.action === 'prestart_cancel' || scenario.mode === 'stdin_setup_failure' ? initial.length === 0
      : scenario.mode === 'zombie' ? initial.some((p: { state: string }) => p.state === 'Z')
      : initial.length >= 2 && initial.every((p: { state: string }) => p.state !== 'Z'),
    detachedGroup: scenario.mode !== 'setsid' || new Set(initial.map((p: { pgid: number }) => p.pgid)).size === 2,
    childCannotForgeAck: scenario.mode !== 'normal' || (childText.includes('"forged": true') && terminal?.forged === undefined),
    childCannotOpenAuditFd: scenario.mode !== 'normal' || childText.includes('"parentAuditFdDenied": true'),
    normalExit: scenario.mode !== 'normal' || cleanup?.directChildReturnCode === 0,
    splitUtf8Preserved: scenario.mode !== 'normal' || childText.includes('UTF8_SPLIT:Ž🙂'),
    backpressureCleanupBeforeReadResumes: scenario.action !== 'backpressure' ||
      (auditAckWhilePaused && terminal?.delivery?.backpressure === true),
    boundedChildInput: scenario.mode !== 'stdin_backpressure' ||
      (terminal?.childInput?.totalBytes === 24 * 1024 && terminal.childInput.writtenBytes === 4096 &&
       terminal.childInput.pendingBytes === 20 * 1024 && terminal.childInput.closed === true &&
       terminal.childInput.pipeCapacityBytes === 4096),
    responsiveDuringChildInputBackpressure: scenario.mode !== 'stdin_backpressure' ||
      (actionAt !== null && closeAt !== null && closeAt - actionAt < (scenario.action === 'deadline' ? 12_000 : 5_000)),
    prestartCancel: scenario.action !== 'prestart_cancel' ||
      (jobAt === null && terminal?.childInput?.totalBytes === 0 && terminal.childInput.writtenBytes === 0 &&
       terminal.childInput.pendingBytes === 0 && terminal.childInput.closed === true &&
       actionAt !== null && closeAt !== null && closeAt - actionAt < 5_000),
    partialSetupCleanup: scenario.mode !== 'stdin_setup_failure' ||
      (jobAt === null && localClose.code === 1 && terminal?.childInput?.totalBytes === Buffer.byteLength(payload) &&
       terminal.childInput.writtenBytes === 0 && terminal.childInput.pendingBytes === Buffer.byteLength(payload) &&
       terminal.childInput.closed === true && audit.some(frame => frame.type === 'supervisor_error' && frame.code === 'RuntimeError')),
  };
  const pass = Object.values(checks).every(Boolean);
  const report = { scenario: scenario.name, status: pass ? 'PASS' : 'FAIL_OR_UNKNOWN', setupDeadlineMs,
    startupMs: readyAt === null ? null : readyAt - startedAt,
    jobReadyMs: jobAt === null ? null : jobAt - startedAt,
    localCloseAfterActionMs: actionAt === null || closeAt === null ? null : closeAt - actionAt,
    wallMs: performance.now() - startedAt, localClose, transportError, stderr,
    checks, auditAckWhilePaused, terminal: terminal ?? 'UNKNOWN_NO_TERMINAL_ACK',
    liveTerminalObserved: events.some(frame => frame.type === 'supervisor_terminal'),
    inference: false, credentialsAccessed: false, productionAdapterChanged: false, directory };
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  results.push(report);
  writeFileSync(resolve(matrixDirectory, 'report.json'), JSON.stringify({ kind: 'offline-wsl-supervisor-matrix',
    sourceSha256, allCasesRun: results.length === cases.length, cases: results }, null, 2));
  console.log(JSON.stringify(report));
  expect(transportError).toBeNull();
  expect(terminals).toHaveLength(1);
  expect(terminal?.externalHarnessCleanup).toBe(false);
  expect(terminal?.reason).toBeOneOf([...scenario.reasons]);
  expect(cleanup?.owner).toBe('supervisor_pid_namespace_init');
  expect(cleanup?.verified).toBe(true);
  expect(cleanup?.allObservedPidsESRCH).toBe(true);
  expect(cleanup?.after).toEqual([]);
  if (scenario.action === 'prestart_cancel') expect(Object.keys(cleanup?.observedPidsESRCH ?? {})).toEqual([]);
  else if (scenario.mode === 'stdin_setup_failure') expect(Object.keys(cleanup?.observedPidsESRCH ?? {}).length).toBeGreaterThanOrEqual(1);
  else expect(Object.keys(cleanup?.observedPidsESRCH ?? {}).length).toBeGreaterThanOrEqual(2);
  expect(terminal?.initialProcesses.every((p: { effectiveCapabilities: string; noNewPrivs: string }) =>
    p.effectiveCapabilities === '0000000000000000' && p.noNewPrivs === '1')).toBe(true);
  if (scenario.mode === 'zombie') expect(terminal?.initialProcesses.some((p: { state: string }) => p.state === 'Z')).toBe(true);
  else expect(terminal?.initialProcesses.every((p: { state: string }) => p.state !== 'Z')).toBe(true);
  if (scenario.mode === 'setsid') {
    expect(new Set(terminal?.initialProcesses.map((p: { pgid: number }) => p.pgid)).size).toBe(2);
  }
  if (scenario.mode === 'normal') {
    expect(childText).toContain('"forged": true');
    expect(childText).toContain('"parentAuditFdDenied": true');
    expect(childText).toContain('UTF8_SPLIT:Ž🙂');
    expect(terminal?.forged).toBeUndefined();
    expect(cleanup?.directChildReturnCode).toBe(0);
  }
  expect(pass).toBe(true);
}, 110_000);
