import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

interface Provenance {
  sources: { path: string; sha256: string }[];
  externals: string[];
}
interface Graph {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): { code: string | null };
}
const helperUrl = pathToFileURL(join(process.cwd(), 'scripts/p41/base-drafts.mjs')).href;
const { frozenSourcePath, frozenGraphGuard } = await import(helperUrl) as {
  frozenSourcePath(id: string, tree: string, entry: string): string;
  frozenGraphGuard(tree: string, entry: string, provenance: Provenance): { buildEnd(this: Graph, error?: unknown): void };
};
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});
function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'p41-provenance-'));
  directories.push(temporary);
  const tree = join(temporary, 'frozen');
  mkdirSync(join(tree, 'src/play/draft'), { recursive: true });
  const entry = join(tree, 'entry.ts');
  const draft = join(tree, 'src/play/draft/draft.ts');
  const honesty = join(tree, 'src/play/draft/unsupported.ts');
  const outside = join(temporary, 'current.ts');
  for (const file of [entry, draft, honesty, outside]) writeFileSync(file, 'export const value = 1;');
  return { tree, entry, draft, honesty, outside };
}
it('accepts only real frozen source paths and rejects current-tree contamination', () => {
  const files = fixture();
  expect(frozenSourcePath(files.draft, files.tree, files.entry)).toBe('src/play/draft/draft.ts');
  expect(frozenSourcePath(files.entry, files.tree, files.entry)).toBe('<synthetic-entry>');
  expect(() => frozenSourcePath(files.outside, files.tree, files.entry)).toThrow('Source escaped frozen tree');
});
it('records source hashes and allows external package modules with Rolldown code=null', () => {
  const files = fixture();
  const provenance: Provenance = { sources: [], externals: [] };
  const guard = frozenGraphGuard(files.tree, files.entry, provenance);
  guard.buildEnd.call({
    getModuleIds: () => [files.entry, files.draft, files.honesty, 'zod'],
    getModuleInfo: id => ({ code: id === 'zod' ? null : 'export const value = 1;' }),
  });
  expect(provenance.sources).toHaveLength(3);
  expect(provenance.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
  expect(provenance.externals).toEqual(['zod']);
});
it('cannot bypass the source guard by externalizing a current absolute source', () => {
  const files = fixture();
  const guard = frozenGraphGuard(files.tree, files.entry, { sources: [], externals: [] });
  expect(() => guard.buildEnd.call({ getModuleIds: () => [files.outside], getModuleInfo: () => ({ code: null }) }))
    .toThrow('Source was externalized outside the frozen bundle');
});
