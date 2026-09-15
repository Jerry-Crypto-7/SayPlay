import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewArtifactReader } from '../reality-compiler-artifact-reader';

const temporary: string[] = [];
function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'rc-artifact-reader-')));
  temporary.push(base);
  const root = join(base, 'artifacts');
  mkdirSync(root);
  writeFileSync(join(root, 'source.txt'), 'source');
  writeFileSync(join(base, 'outside.txt'), 'outside-fixture');
  return { base, root };
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('bounded review artifact filesystem reader', () => {
  it('reads nested regular files as owned snapshots', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'unicode-ž.txt'), 'žluťoučký');
    const read = createReviewArtifactReader(root);
    const bytes = read('nested/unicode-ž.txt');
    writeFileSync(join(root, 'nested', 'unicode-ž.txt'), 'changed');
    expect(bytes.toString()).toBe('žluťoučký');
    bytes.fill(0);
    expect(read('nested/unicode-ž.txt').toString()).toBe('changed');
    expect(readFileSync(join(root, 'nested', 'unicode-ž.txt'), 'utf8')).toBe('changed');
  });

  it.each(['', '.', '..', '../outside.txt', 'nested/../../outside.txt', '/outside.txt',
    '//server/share/file', '\\\\server\\share\\file', 'C:/outside.txt', 'C:outside.txt',
    'source.txt:secret', 'nested\\source.txt', 'nested//source.txt', './source.txt',
    'nested/./source.txt', 'source.txt/', 'source.txt.', 'source.txt ', 'NUL', 'CON.txt',
    'com1.json', 'LPT²', 'nested/PRN', 'a\u0000b', 'a\nb', 'a?b', 'a*b', 'a|b', 'a<b'])('rejects non-portable or escaping path %j', path => {
    const { root } = fixture();
    expect(() => createReviewArtifactReader(root)(path)).toThrow('ARTIFACT_PATH_INVALID');
  });

  it('rejects directories and intermediate regular files', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'folder'));
    const read = createReviewArtifactReader(root);
    expect(() => read('folder')).toThrow('ARTIFACT_NOT_REGULAR_FILE');
    expect(() => read('source.txt/child')).toThrow('ARTIFACT_NOT_REGULAR_FILE');
  });

  it('enforces byte limit including empty and exact-limit files', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'empty'), '');
    expect(createReviewArtifactReader(root, { maxBytes: 0 })('empty')).toHaveLength(0);
    expect(createReviewArtifactReader(root, { maxBytes: 6 })('source.txt').toString()).toBe('source');
    expect(() => createReviewArtifactReader(root, { maxBytes: 5 })('source.txt')).toThrow('ARTIFACT_TOO_LARGE');
    for (const maxBytes of [-1, 0.5, NaN, Infinity, 256 * 1024 * 1024 + 1]) {
      expect(() => createReviewArtifactReader(root, { maxBytes })).toThrow('ARTIFACT_BYTE_LIMIT_INVALID');
    }
  });

  it('requires an existing absolute directory and detects root replacement', () => {
    const { base, root } = fixture();
    expect(() => createReviewArtifactReader('relative')).toThrow('ARTIFACT_ROOT_MUST_BE_ABSOLUTE');
    expect(() => createReviewArtifactReader(join(root, 'source.txt'))).toThrow('ARTIFACT_ROOT_NOT_CANONICAL_DIRECTORY');
    const read = createReviewArtifactReader(root);
    renameSync(root, join(base, 'old'));
    mkdirSync(root);
    writeFileSync(join(root, 'source.txt'), 'replaced');
    expect(() => read('source.txt')).toThrow('ARTIFACT_ROOT_CHANGED');
  });

  it('rejects intermediate directory links/junctions both inside and outside root', () => {
    const { base, root } = fixture();
    mkdirSync(join(root, 'actual'));
    writeFileSync(join(root, 'actual', 'data'), 'inside');
    // Windows junction creation does not require Developer Mode/admin rights.
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(join(root, 'actual'), join(root, 'inside-link'), type);
    symlinkSync(base, join(root, 'escape-link'), type);
    const read = createReviewArtifactReader(root);
    expect(() => read('inside-link/data')).toThrow('ARTIFACT_LINK_REJECTED');
    expect(() => read('escape-link/outside.txt')).toThrow('ARTIFACT_LINK_REJECTED');
    expect(() => createReviewArtifactReader(join(root, 'inside-link'))).toThrow('ARTIFACT_ROOT_NOT_CANONICAL_DIRECTORY');
    expect(() => createReviewArtifactReader(join(root, 'escape-link', 'artifacts'))).toThrow('ARTIFACT_ROOT_NOT_CANONICAL_DIRECTORY');
  });

  it('rejects file symlinks when the OS permits creating them', context => {
    const { base, root } = fixture();
    try {
      symlinkSync(join(base, 'outside.txt'), join(root, 'linked.txt'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip(); return;
      }
      throw error;
    }
    expect(() => createReviewArtifactReader(root)('linked.txt')).toThrow('ARTIFACT_LINK_REJECTED');
  });
});
