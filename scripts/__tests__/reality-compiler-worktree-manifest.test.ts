import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorktreeManifest } from '../reality-compiler-worktree-manifest';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const directories: string[] = [];
const head = 'a'.repeat(40), object = 'b'.repeat(40);
function fixture(options: { tracked?: string[]; headOnly?: string[]; untracked?: string[];
  modes?: Record<string, string>; dirty?: string; mutate?: (root: string) => void } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rc-worktree-manifest-')));
  directories.push(root);
  const tracked = options.tracked ?? ['a.txt'];
  let statuses = 0;
  const git = (args: readonly string[]) => {
    let result: string;
    if (args[0] === 'rev-parse') result = args.includes('--show-toplevel') ? root : head;
    else if (args[0] === 'ls-tree') result = [...tracked, ...(options.headOnly ?? [])].map(path =>
      `${options.modes?.[path] ?? '100644'} ${options.modes?.[path] === '160000' ? 'commit' : 'blob'} ${object}\t${path}\0`).join('');
    else if (args[0] === 'ls-files' && args.includes('--stage')) result = tracked.map(path =>
      `${options.modes?.[path] ?? '100644'} ${object} 0\t${path}\0`).join('');
    else if (args[0] === 'ls-files') result = (options.untracked ?? []).map(path => path + '\0').join('');
    else if (args[0] === 'status') {
      if (++statuses === 2) options.mutate?.(root);
      result = options.dirty ?? '';
    } else throw new Error(`Unexpected Git operation ${args}`);
    return Buffer.from(result);
  };
  return { root, git };
}
afterEach(() => {
  vi.restoreAllMocks();
  const temp = realpathSync.native(tmpdir());
  for (const root of directories.splice(0)) {
    const rel = relative(temp, root);
    if (!rel.startsWith('rc-worktree-manifest-') || rel.includes('..') || isAbsolute(rel)) throw new Error('UNSAFE_TEST_CLEANUP');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('complete explicit Git worktree snapshot scope', () => {
  it('captures every enumerated regular file, binary bytes, untracked entries and HEAD-only deletions', async () => {
    const { root, git } = fixture({ tracked: ['z.bin', 'a.txt'], headOnly: ['deleted.txt'], untracked: ['new.txt'], dirty: ' D deleted.txt\0?? new.txt\0' });
    writeFileSync(join(root, 'z.bin'), Buffer.from([0, 255, 1]));
    writeFileSync(join(root, 'a.txt'), 'alpha'); writeFileSync(join(root, 'new.txt'), 'new');
    const result = await createWorktreeManifest(root, git);
    expect(result.entries.map(e => e.path)).toEqual(['a.txt', 'deleted.txt', 'new.txt', 'z.bin']);
    expect(result.counts).toEqual({ total: 4, files: 3, missing: 1, refused: 0, protected: 0 });
    expect(result.entries[1]).toMatchObject({ status: 'missing', tracked: true, indexDeleted: true, sha256: null });
    expect(result.entries[2]).toMatchObject({ status: 'file', tracked: false, bytes: 3 });
    expect(result.completeContentCapture).toBe(true); expect(result.enumerationComplete).toBe(true); expect(result.gitDiagnostics).toEqual([]);
    expect(result.dirty).toBe(true); expect(result.head).toBe(head);
  });
  it('is deterministic independent of enumeration ordering and capture timestamp', async () => {
    const { root, git } = fixture({ tracked: ['z.txt', 'a.txt'] });
    writeFileSync(join(root, 'z.txt'), 'z'); writeFileSync(join(root, 'a.txt'), 'a');
    const first = await createWorktreeManifest(root, git);
    const second = await createWorktreeManifest(root, args => {
      const bytes = git(args);
      return args[0] === 'ls-tree' || args[0] === 'ls-files'
        ? Buffer.from(bytes.toString().split('\0').filter(Boolean).reverse().join('\0') + (bytes.length ? '\0' : '')) : bytes;
    });
    expect(first.aggregateSha256).toBe(second.aggregateSha256);
    writeFileSync(join(root, 'z.txt'), 'changed');
    expect((await createWorktreeManifest(root, git)).aggregateSha256).not.toBe(first.aggregateSha256);
  });
  it('does not open ignored files and records protected tracked files without content hashes', async () => {
    const { root, git } = fixture({ tracked: ['a.txt', '.env', '.codex/auth.json', 'SECURITY-FINDINGS.md'] });
    writeFileSync(join(root, 'a.txt'), 'public'); writeFileSync(join(root, '.env'), 'SYNTHETIC_ONLY');
    writeFileSync(join(root, 'PROJECT-STATUS.md'), 'ignored local fixture');
    const result = await createWorktreeManifest(root, git);
    expect(result.entries.some(e => e.path === 'PROJECT-STATUS.md')).toBe(false);
    expect(result.entries.filter(e => e.status === 'protected')).toHaveLength(3);
    expect(result.entries.filter(e => e.status === 'protected').every(e => e.sha256 === null && e.bytes === null)).toBe(true);
    expect(result.completeContentCapture).toBe(false);
  });
  it('includes public env templates and application session routes, not credential stores', async () => {
    const { root, git } = fixture({ tracked: ['.env.example', 'src/sessions/route.ts'] });
    mkdirSync(join(root, 'src', 'sessions'), { recursive: true });
    writeFileSync(join(root, '.env.example'), 'EXAMPLE=');
    writeFileSync(join(root, 'src', 'sessions', 'route.ts'), 'export const fixture = true;');
    expect((await createWorktreeManifest(root, git)).counts).toEqual({ total: 2, files: 2, missing: 0, refused: 0, protected: 0 });
  });
  it('refuses real directory junctions without reading targets', async () => {
    const { root, git } = fixture({ tracked: ['link/data.txt'] });
    mkdirSync(join(root, 'actual')); writeFileSync(join(root, 'actual', 'data.txt'), 'synthetic target');
    symlinkSync(join(root, 'actual'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await createWorktreeManifest(root, git)).entries[0]).toMatchObject({ status: 'refused', sha256: null, reason: 'ARTIFACT_LINK_REJECTED' });
  });
  it.each(['120000', '160000'])('refuses Git mode %s even when Windows represents it as a regular file', async mode => {
    const { root, git } = fixture({ modes: { 'a.txt': mode } });
    writeFileSync(join(root, 'a.txt'), 'not followed');
    expect((await createWorktreeManifest(root, git)).entries[0]).toMatchObject({ status: 'refused', reason: 'UNSUPPORTED_GIT_MODE', sha256: null });
  });
  it('refuses directories and unsafe path syntax without traversing outside the tree', async () => {
    const { root, git } = fixture({ tracked: ['folder', '../outside', 'folder/../a.txt'] });
    mkdirSync(join(root, 'folder'));
    expect((await createWorktreeManifest(root, git)).counts.refused).toBe(3);
  });
  it('keeps missing untracked entries incomplete', async () => {
    const { root, git } = fixture({ tracked: [], untracked: ['vanished.txt'] });
    const result = await createWorktreeManifest(root, git);
    expect(result.entries[0]).toMatchObject({ status: 'missing', tracked: false });
    expect(result.completeContentCapture).toBe(false);
  });
  it('rejects ordinary concurrent content changes between the two passes', async () => {
    const { root, git } = fixture({ mutate: directory => writeFileSync(join(directory, 'a.txt'), 'after') });
    writeFileSync(join(root, 'a.txt'), 'before');
    await expect(createWorktreeManifest(root, git)).rejects.toThrow('MANIFEST_WORKTREE_CHANGED_DURING_CAPTURE');
  });
  it('rejects truncated NUL-delimited Git metadata', async () => {
    const { root, git } = fixture();
    await expect(createWorktreeManifest(root, args => args[0] === 'ls-tree' ? Buffer.from('truncated') : git(args)))
      .rejects.toThrow('MANIFEST_GIT_TRUNCATED');
  });

  it('keeps hashed enumerated files usable but refuses completeness after exit-zero stderr', async () => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'enumerated content');
    const warning = Buffer.from('warning: cannot open directory synthetic-denied/: Permission denied\n');
    const result = await createWorktreeManifest(root, args => ({ stdout: git(args), status: 0,
      stderr: args[0] === 'status' ? warning : Buffer.alloc(0) }));
    expect(result.enumerationComplete).toBe(false); expect(result.completeContentCapture).toBe(false);
    expect(result.entries[0]).toMatchObject({ status: 'file', bytes: 18, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.counts.files).toBe(1);
    expect(result.gitDiagnostics).toEqual(['before', 'after'].map(pass => ({ pass,
      operation: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], exitCode: 0,
      stderrBytes: warning.length, stderrSha256: createHash('sha256').update(warning).digest('hex'), errorCode: null, signal: null })));
    expect(JSON.stringify(result)).not.toContain('synthetic-denied');
  });

  it('binds a warning first appearing in the late inventory pass into the manifest identity', async () => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'stable');
    const clean = await createWorktreeManifest(root, git); let statuses = 0;
    const warned = await createWorktreeManifest(root, args => ({ stdout: git(args), status: 0,
      stderr: args[0] === 'status' && ++statuses === 2 ? Buffer.from('late warning') : Buffer.alloc(0) }));
    expect(warned.entries).toEqual(clean.entries); expect(warned.enumerationSha256).toBe(clean.enumerationSha256);
    expect(warned.aggregateSha256).not.toBe(clean.aggregateSha256);
    expect(warned).toMatchObject({ enumerationComplete: false, completeContentCapture: false });
    expect(warned.gitDiagnostics).toHaveLength(1); expect(warned.gitDiagnostics[0].pass).toBe('after');
  });

  it.each(['root', 'before', 'after'])('retains exact diagnostic bytes/hash and phase binding for %s', async pass => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'stable');
    const warning = Buffer.from([0, 255, 27, 10, 128]); let heads = 0;
    const result = await createWorktreeManifest(root, args => {
      const phase = args.includes('--show-toplevel') ? 'root' : args[0] === 'rev-parse' ? (++heads === 1 ? 'before' : 'after') : null;
      return { stdout: git(args), status: 0, stderr: phase === pass ? warning : Buffer.alloc(0) };
    });
    expect(result.gitDiagnostics).toHaveLength(1);
    expect(result.gitDiagnostics[0]).toMatchObject({ pass, stderrBytes: 5, stderrSha256: createHash('sha256').update(warning).digest('hex') });
    expect(result.enumerationComplete).toBe(false);
  });

  it('does not let a clean second pass erase an earlier enumeration warning', async () => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'stable'); let calls = 0;
    const result = await createWorktreeManifest(root, args => ({ stdout: git(args), status: 0,
      stderr: args[0] === 'ls-files' && args.includes('--others') && ++calls === 1 ? Buffer.from('partial enumeration') : Buffer.alloc(0) }));
    expect(result.gitDiagnostics).toHaveLength(1); expect(result.gitDiagnostics[0].pass).toBe('before');
    expect(result.enumerationComplete).toBe(false); expect(result.completeContentCapture).toBe(false);
  });

  it('binds distinct diagnostic bytes even when enumerated file content matches', async () => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'stable');
    const run = (message: string) => createWorktreeManifest(root, args => ({ stdout: git(args), status: 0,
      stderr: args[0] === 'status' ? Buffer.from(message) : Buffer.alloc(0) }));
    const first = await run('warning one'), same = await run('warning one'), different = await run('warning two');
    expect(first.aggregateSha256).toBe(same.aggregateSha256); expect(first.aggregateSha256).not.toBe(different.aggregateSha256);
  });

  it.each([
    { status: 1, errorCode: null, signal: null }, { status: null, errorCode: 'ENOENT', signal: null },
    { status: null, errorCode: 'ETIMEDOUT', signal: 'SIGTERM' }, { status: 0, errorCode: null, signal: 'SIGKILL' },
    { status: 0, errorCode: 'ENOBUFS', signal: null },
  ])('fails closed for process failure metadata %j instead of publishing partial success', async metadata => {
    const { root, git } = fixture();
    try {
      await createWorktreeManifest(root, args => ({ stdout: git(args), stderr: Buffer.from('diagnostic'), ...metadata }));
      expect.fail('manifest unexpectedly returned');
    } catch (error) {
      expect(error).toMatchObject({ message: 'MANIFEST_GIT_FAILED', gitDiagnostics: [expect.objectContaining({ pass: 'root', exitCode: metadata.status })] });
      expect(JSON.stringify(error)).not.toContain('"diagnostic"');
    }
  });

  it('normalizes thrown spawn errors without copying error messages into evidence', async () => {
    const { root } = fixture();
    await expect(createWorktreeManifest(root, () => { throw Object.assign(new Error('untrusted message contents'), { code: 'EPERM' }); }))
      .rejects.toMatchObject({ message: 'MANIFEST_GIT_FAILED', gitDiagnostics: [expect.objectContaining({ errorCode: 'EPERM', stderrBytes: 0 })] });
  });

  it('enforces bounded Git buffers even for an injected exit-zero process response', async () => {
    const { root, git } = fixture();
    await expect(createWorktreeManifest(root, args => ({ stdout: git(args), stderr: Buffer.alloc(32 * 1024 * 1024 + 1), status: 0 })))
      .rejects.toMatchObject({ message: 'MANIFEST_GIT_FAILED', gitDiagnostics: [expect.objectContaining({ errorCode: 'MANIFEST_GIT_BUFFER_LIMIT' })] });
  });

  it('clean structured Git capture and trusted legacy Buffer injection have the same identity', async () => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'stable');
    const legacy = await createWorktreeManifest(root, git);
    const structured = await createWorktreeManifest(root, args => ({ stdout: git(args), stderr: Buffer.alloc(0), status: 0 }));
    expect(structured.enumerationComplete).toBe(true); expect(structured.completeContentCapture).toBe(true);
    expect(structured.aggregateSha256).toBe(legacy.aggregateSha256);
  });

  it('the default process reader captures exit-zero stderr instead of silently dropping it', async () => {
    const { root, git } = fixture(); writeFileSync(join(root, 'a.txt'), 'stable');
    const diagnostic = Buffer.from('synthetic directory warning');
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const operation = (args as string[]).slice(4), stdout = git(operation);
      const stderr = operation[0] === 'status' ? diagnostic : Buffer.alloc(0);
      return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status: 0, signal: null };
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await createWorktreeManifest(root);
    expect(result.enumerationComplete).toBe(false); expect(result.completeContentCapture).toBe(false);
    expect(result.gitDiagnostics).toHaveLength(2);
    expect(spawnSync).toHaveBeenCalledWith('git', expect.arrayContaining(['--no-replace-objects', '--no-optional-locks']),
      expect.objectContaining({ timeout: 30000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Manifest Git diagnostic: before/status'));
    expect(stderr.mock.calls.some(args => String(args[0]).includes('synthetic directory warning'))).toBe(false);
  });
});
