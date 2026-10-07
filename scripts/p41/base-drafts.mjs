/** Frozen quick drafts. No model calls and no imports from the current runtime. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Fail closed even if a future resolver configuration points outside the tag. */
export function frozenSourcePath(id, tree, entry) {
  if (!isAbsolute(id)) throw new Error(`Frozen source is not an absolute file: ${id}`);
  const actual = realpathSync(id);
  const frozen = realpathSync(tree);
  const path = relative(frozen, actual);
  if (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new Error(`Source escaped frozen tree: ${id}`);
  }
  return actual === realpathSync(entry) ? '<synthetic-entry>' : path.replaceAll('\\', '/');
}

export function frozenGraphGuard(tree, entry, provenance) {
  return {
    name: 'frozen-source-provenance',
    buildEnd(error) {
      if (error) return;
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        // Rolldown ModuleInfo has no Rollup isExternal flag. At buildEnd,
        // an external's code is null; loaded own modules have source text.
        if (info?.code === null) {
          if (isAbsolute(id) || id.startsWith('.') || id.startsWith('@/')) {
            throw new Error(`Source was externalized outside the frozen bundle: ${id}`);
          }
          provenance.externals.push(id);
          continue;
        }
        const path = frozenSourcePath(id, tree, entry);
        provenance.sources.push({ path, sha256: createHash('sha256').update(readFileSync(id)).digest('hex') });
      }
      provenance.sources.sort((a, b) => a.path.localeCompare(b.path));
      provenance.externals.sort();
      for (const required of ['src/play/draft/draft.ts', 'src/play/draft/unsupported.ts']) {
        if (!provenance.sources.some(source => source.path === required)) throw new Error(`Missing frozen entry source: ${required}`);
      }
    },
  };
}

export async function baseDrafts(items, seeds = [1, 2, 3, 4, 5]) {
  const scratch = join(root, '.claude', 'scratchpads');
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(join(scratch, 'p41-base-'));
  const tree = join(temporary, 'tree');
  let added = false;
  try {
    const commit = git('rev-parse', 'p41-base^{commit}');
    git('worktree', 'add', '--detach', tree, commit);
    added = true;
    if (!readFileSync(join(tree, 'package-lock.json')).equals(readFileSync(join(root, 'package-lock.json')))) {
      throw new Error('Frozen dependency lock differs; do not silently measure with different dependencies');
    }
    // Bundle only frozen source. External packages resolve from the existing installation;
    // no node_modules junction is created, so cleanup cannot follow one into the repo.
    const bundle = join(temporary, 'draft.cjs');
    const entry = join(tree, 'p41-frozen-entry.ts');
    const provenance = { sources: [], externals: [] };
    writeFileSync(entry, 'export { draftGameSpecWithMeta } from "@/play/draft/draft"; export { unsupportedGame } from "@/play/draft/unsupported";');
    await build({
      input: entry, cwd: tree, tsconfig: join(tree, 'tsconfig.json'),
      plugins: [frozenGraphGuard(tree, entry, provenance)],
      resolve: { alias: { '@': join(tree, 'src') } },
      platform: 'node', external: id => !id.startsWith('.') && !id.startsWith('@/') && !isAbsolute(id),
      output: { format: 'cjs', file: bundle },
    });
    const { draftGameSpecWithMeta, unsupportedGame } = createRequire(import.meta.url)(bundle);
    const rows = items.flatMap(item => seeds.map(seed => {
      try {
        const start = performance.now();
        const draft = draftGameSpecWithMeta(item.sentence, seed);
        return { id: item.id, seed, spec: draft.spec, fellBack: draft.fellBack, milliseconds: performance.now() - start, honesty: unsupportedGame(item.sentence, draft.spec) };
      } catch (error) {
        return { id: item.id, seed, error: String(error) };
      }
    }));
    return {
      commit,
      provenance: {
        ...provenance,
        guard: 'passed',
        sourceCount: provenance.sources.length,
        sourceManifestSha256: createHash('sha256').update(JSON.stringify(provenance.sources)).digest('hex'),
        bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      },
      lockSha256: createHash('sha256').update(readFileSync(join(tree, 'package-lock.json'))).digest('hex'),
      seeds,
      rows,
    };
  } finally {
    // Both paths were created beneath a fresh task directory in the workspace.
    // There are no symlinks/junctions in this worktree.
    if (added) git('worktree', 'remove', '--force', tree);
    rmSync(temporary, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error('Usage: node scripts/p41/base-drafts.mjs input.json output.json');
  const items = JSON.parse(readFileSync(resolve(input), 'utf8'));
  writeFileSync(resolve(output), `${JSON.stringify(await baseDrafts(items), null, 2)}\n`);
}
