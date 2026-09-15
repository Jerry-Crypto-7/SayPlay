/** Current local worktree bytes, not a historical test/build identity or a
 * publication approval. Git enumerates HEAD/index plus nonignored untracked
 * names; only the bounded artifact reader opens their content. The tree must
 * not be adversarially writable. Two passes detect ordinary concurrent edits,
 * not swap-and-restore races or a repository-wide atomic snapshot.
 * CLI: node --experimental-strip-types scripts/reality-compiler-worktree-manifest.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ManifestGitResult {
  stdout: Buffer; stderr: Buffer; status: number | null;
  signal?: string | null; errorCode?: string | null;
}
/** Buffer-only readers remain a trusted test injection with no reported stderr. */
export type ManifestGitReader = (args: readonly string[]) => Buffer | ManifestGitResult;
type GitBytesReader = (args: readonly string[]) => Buffer;
type GitPass = 'root' | 'before' | 'after';
type GitDiagnostic = { pass: GitPass; operation: readonly string[]; exitCode: number | null;
  stderrBytes: number; stderrSha256: string; signal: string | null; errorCode: string | null };
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
type Entry = { path: string; headMode: string | null; indexMode: string | null;
  indexDeleted: boolean; tracked: boolean; status: 'file' | 'missing' | 'refused' | 'protected';
  bytes: number | null; sha256: string | null; reason: string | null };
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const records = (bytes: Buffer) => {
  const text = decode(bytes);
  if (text && !text.endsWith('\0')) throw new Error('MANIFEST_GIT_TRUNCATED');
  return text ? text.slice(0, -1).split('\0') : [];
};
// Never inspect credential/security stores even if accidentally tracked.
const protectedPath = (path: string) => path.split('/').some(part =>
  /^(?:\.git|\.codex|\.aws|\.ssh)$/i.test(part) ||
  /^(?:auth\.json|credentials(?:\.json)?|SECURITY-FINDINGS\.md)$/i.test(part)) ||
  /^(?:sessions?)(?:\/|$)/i.test(path) ||
  (/(?:^|\/)\.env(?:\.|$)/i.test(path) && !/(?:^|\/)\.env\.(?:example|sample)$/i.test(path));

function inventory(git: GitBytesReader) {
  const head = decode(git(['rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('MANIFEST_HEAD_INVALID');
  const headFiles = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  const index = git(['ls-files', '--cached', '--stage', '-z']);
  const other = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  const paths = new Map<string, { headMode: string | null; indexMode: string | null; conflict: boolean }>();
  const entry = (path: string) => {
    if (!paths.has(path)) paths.set(path, { headMode: null, indexMode: null, conflict: false });
    return paths.get(path)!;
  };
  for (const row of records(headFiles)) {
    const match = /^(\d{6}) (?:blob|commit) [a-f0-9]+\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('MANIFEST_HEAD_ENTRY_INVALID');
    entry(match[2]).headMode = match[1];
  }
  for (const row of records(index)) {
    const match = /^(\d{6}) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('MANIFEST_INDEX_ENTRY_INVALID');
    const value = entry(match[3]); value.indexMode = match[1]; value.conflict ||= match[2] !== '0';
  }
  for (const path of records(other)) entry(path);
  return { head, paths, dirty: status.length > 0, statusSha256: sha256(status),
    enumerationSha256: sha256(JSON.stringify([head, decode(headFiles), decode(index), decode(other), decode(status)])) };
}

/** Test injection supplies only trusted Git responses, never file content. */
export async function createWorktreeManifest(root: string, injectedGit?: ManifestGitReader) {
  const canonicalRoot = realpathSync.native(resolve(root));
  if (canonicalRoot !== resolve(root) || lstatSync(resolve(root)).isSymbolicLink()) throw new Error('MANIFEST_ROOT_NOT_CANONICAL');
  const runGit: ManifestGitReader = injectedGit ?? (args => {
    const result = spawnSync('git', ['--no-replace-objects',
    '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: canonicalRoot, windowsHide: true, timeout: 30000, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    });
    return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0), status: result.status,
      signal: result.signal, errorCode: result.error ? (result.error as NodeJS.ErrnoException).code ?? 'GIT_PROCESS_ERROR' : null };
  });
  const gitDiagnostics: GitDiagnostic[] = [];
  let pass: GitPass = 'root';
  const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'GIT_PROCESS_ERROR';
  const git: GitBytesReader = args => {
    let response: Buffer | ManifestGitResult;
    try { response = runGit(args); }
    catch (error) { response = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null,
      errorCode: safeCode((error as NodeJS.ErrnoException)?.code) }; }
    const result: ManifestGitResult = Buffer.isBuffer(response) ? { stdout: response, stderr: Buffer.alloc(0), status: 0 } : response;
    if (!result || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) ||
      (result.status !== null && !Number.isSafeInteger(result.status))) throw new Error('MANIFEST_GIT_RESPONSE_INVALID');
    const errorCode = result.errorCode == null ? null : safeCode(result.errorCode);
    const signal = result.signal == null ? null : typeof result.signal === 'string' && /^SIG[A-Z0-9]{1,20}$/.test(result.signal) ? result.signal : 'UNKNOWN_SIGNAL';
    const bufferExceeded = result.stdout.length > GIT_MAX_BUFFER || result.stderr.length > GIT_MAX_BUFFER;
    if (result.stderr.length || result.status !== 0 || errorCode || signal || bufferExceeded) {
      gitDiagnostics.push({ pass, operation: [...args], exitCode: result.status,
        stderrBytes: result.stderr.length, stderrSha256: sha256(result.stderr), signal,
        errorCode: bufferExceeded ? 'MANIFEST_GIT_BUFFER_LIMIT' : errorCode });
      // Do not echo arbitrary stderr text. Persist exact byte/hash metadata and
      // surface its existence without importing content into this manifest.
      if (!injectedGit) process.stderr.write(`Manifest Git diagnostic: ${pass}/${args[0]} (exit ${result.status}, stderr ${result.stderr.length} bytes).\n`);
    }
    if (result.status !== 0 || errorCode || signal || bufferExceeded) {
      throw Object.assign(new Error('MANIFEST_GIT_FAILED'), { gitDiagnostics: structuredClone(gitDiagnostics) });
    }
    return result.stdout;
  };
  const top = decode(git(['rev-parse', '--show-toplevel'])).trim();
  if (realpathSync.native(top) !== canonicalRoot) throw new Error('MANIFEST_REPOSITORY_ROOT_REQUIRED');
  // URL import permits native Node TS execution while retaining the reader's
  // type contract and avoiding a second, weaker implementation of file access.
  const { createReviewArtifactReader } = await import(new URL('./reality-compiler-artifact-reader.ts', import.meta.url).href) as
    typeof import('./reality-compiler-artifact-reader');
  const read = createReviewArtifactReader(canonicalRoot, { maxBytes: 256 * 1024 * 1024 });
  pass = 'before';
  const before = inventory(git);
  const collect = (): Entry[] => [...before.paths].sort(([a], [b]) => compare(a, b)).map(([path, value]) => {
    const row: Entry = { path, headMode: value.headMode, indexMode: value.indexMode,
      indexDeleted: value.headMode !== null && value.indexMode === null,
      tracked: value.headMode !== null || value.indexMode !== null,
      status: 'refused', bytes: null, sha256: null, reason: null };
    if (protectedPath(path)) return { ...row, status: 'protected', reason: 'PROTECTED_PATH_NOT_READ' };
    if (value.conflict || [value.headMode, value.indexMode].some(mode => mode !== null && !['100644', '100755'].includes(mode)))
      return { ...row, reason: value.conflict ? 'UNMERGED_INDEX' : 'UNSUPPORTED_GIT_MODE' };
    try {
      const bytes = read(path);
      return { ...row, status: 'file', bytes: bytes.length, sha256: sha256(bytes) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ...row, status: 'missing', reason: 'PATH_MISSING' };
      const reason = error instanceof Error && /^ARTIFACT_[A-Z_]+$/.test(error.message)
        ? error.message : 'FILE_READ_REFUSED';
      return { ...row, reason };
    }
  });
  const entries = collect();
  pass = 'after';
  const after = inventory(git);
  if (before.enumerationSha256 !== after.enumerationSha256 || JSON.stringify(entries) !== JSON.stringify(collect()))
    throw new Error('MANIFEST_WORKTREE_CHANGED_DURING_CAPTURE');
  const scope = { kind: 'head-and-index-tracked-plus-nonignored-untracked',
    ignoredFiles: 'excluded-without-content-read', protectedPaths: 'metadata-only-refusal',
    submodules: 'unsupported-no-recursion', pathOrder: 'unicode-code-unit', fileByteLimit: 256 * 1024 * 1024 };
  const enumerationComplete = gitDiagnostics.length === 0;
  return { version: 'reality-compiler-current-worktree-manifest-v1', capturedAt: new Date().toISOString(),
    scope, head: before.head, dirty: before.dirty, statusSha256: before.statusSha256,
    enumerationSha256: before.enumerationSha256, enumerationComplete, gitDiagnostics,
    aggregateSha256: sha256(JSON.stringify({ scope, head: before.head, dirty: before.dirty,
      statusSha256: before.statusSha256, enumerationComplete, gitDiagnostics, entries })), entries,
    counts: { total: entries.length, files: entries.filter(e => e.status === 'file').length,
      missing: entries.filter(e => e.status === 'missing').length,
      refused: entries.filter(e => e.status === 'refused').length, protected: entries.filter(e => e.status === 'protected').length },
    completeContentCapture: enumerationComplete && entries.every(e => e.status === 'file' || (e.status === 'missing' && e.tracked)),
    limitations: ['Current local worktree identity; not a historical build or test-run hash.',
      'Two-pass stability check is not an atomic filesystem snapshot or an OS sandbox.',
      'Missing, protected and unsupported entries have no content digest.',
      'Ignored local documents and scratch evidence are outside this explicit scope.',
      'Git stderr in any pass makes enumeration incomplete even with exit code zero; hashed enumerated entries remain usable.',
      'Git diagnostics store exact stderr byte counts/hashes, never stderr text; unknown or inaccessible paths are not inferred.',
      'Injected Buffer-only Git readers are trusted tests reporting no stderr, not native enumeration evidence.',
      'No publication approval, credential audit or semantic evaluation is implied.'] };
}

/** Creates only a new local scratch file. Existing artifacts are never replaced. */
export async function writeWorktreeManifest(root: string): Promise<string> {
  const manifest = await createWorktreeManifest(root);
  const scratch = join(resolve(root), 'scratch');
  mkdirSync(scratch, { recursive: true });
  if (lstatSync(scratch).isSymbolicLink() || !lstatSync(scratch).isDirectory() || realpathSync.native(scratch) !== scratch)
    throw new Error('MANIFEST_SCRATCH_NOT_CANONICAL');
  const output = join(scratch, `full-worktree-manifest-${randomUUID()}.json`);
  writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('MANIFEST_CLI_ACCEPTS_NO_ARGUMENTS');
  console.log(await writeWorktreeManifest(process.cwd()));
}
