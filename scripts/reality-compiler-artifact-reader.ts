import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ALLOWED_BYTES = 256 * 1024 * 1024;

/**
 * Read-only adapter for review artifacts under an explicitly trusted directory.
 * Paths use portable forward-slash components; links (including junctions) are
 * rejected even when they point inside the root. Every call returns owned bytes,
 * not a live file view. Hash verification remains the caller's responsibility.
 *
 * This is bounded filesystem hygiene, NOT an OS sandbox. The root, its ancestors
 * and artifact tree must not be concurrently writable by an adversary: portable
 * Node APIs cannot atomically walk all parents with directory-relative handles.
 * Pre/post path and handle checks detect ordinary replacements but cannot rule
 * out a swap-and-restore race, hard links, or same-size in-place writes whose
 * metadata is restored. A trusted producer must freeze/protect the tree; a
 * validated runtime/sandbox is still required separately for live execution.
 */
export function createReviewArtifactReader(trustedRoot: string, options: { maxBytes?: number } = {}): (path: string) => Buffer {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ALLOWED_BYTES) {
    throw new Error('ARTIFACT_BYTE_LIMIT_INVALID');
  }
  if (!isAbsolute(trustedRoot)) throw new Error('ARTIFACT_ROOT_MUST_BE_ABSOLUTE');
  const root = resolve(trustedRoot);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || realpathSync.native(root) !== root) {
    throw new Error('ARTIFACT_ROOT_NOT_CANONICAL_DIRECTORY');
  }
  const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const unchanged = (a: Stats, b: Stats) => sameIdentity(a, b) && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const checkRoot = () => {
    const current = lstatSync(root);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(rootStat, current) || realpathSync.native(root) !== root) {
      throw new Error('ARTIFACT_ROOT_CHANGED');
    }
  };
  return (artifactPath: string): Buffer => {
    if (typeof artifactPath !== 'string' || artifactPath.length === 0 || artifactPath.length > 4096 ||
      /[\\\x00-\x1f\x7f<>:"|?*]/u.test(artifactPath)) throw new Error('ARTIFACT_PATH_INVALID');
    const parts = artifactPath.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))) {
      throw new Error('ARTIFACT_PATH_INVALID');
    }
    checkRoot();
    const target = join(root, ...parts);
    const within = relative(root, target);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error('ARTIFACT_PATH_OUTSIDE_ROOT');
    }
    const walk = (): Stats => {
      checkRoot();
      let path = root;
      let stat: Stats = rootStat;
      for (let i = 0; i < parts.length; i++) {
        path = join(path, parts[i]);
        stat = lstatSync(path);
        if (stat.isSymbolicLink() || realpathSync.native(path) !== path) throw new Error('ARTIFACT_LINK_REJECTED');
        if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('ARTIFACT_NOT_REGULAR_FILE');
      }
      return stat;
    };
    const before = walk();
    if (before.size > maxBytes) throw new Error('ARTIFACT_TOO_LARGE');
    // NOFOLLOW defends the final component on supporting platforms. NONBLOCK
    // avoids blocking on a FIFO swapped in after lstat on supporting platforms.
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || !unchanged(before, opened)) throw new Error('ARTIFACT_CHANGED_DURING_READ');
      const bytes = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
      let count = 0;
      while (count < bytes.length) {
        const n = readSync(fd, bytes, count, bytes.length - count, null);
        if (n === 0) break;
        count += n;
      }
      if (count > maxBytes) throw new Error('ARTIFACT_TOO_LARGE');
      const after = fstatSync(fd);
      if (count !== opened.size || !unchanged(opened, after) || !unchanged(after, walk())) {
        throw new Error('ARTIFACT_CHANGED_DURING_READ');
      }
      return Buffer.from(bytes.subarray(0, count));
    } finally {
      closeSync(fd);
    }
  };
}
