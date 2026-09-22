/** Register generated, first-party artifacts without changing library entries. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const file = new URL('disclosure.json', root);
const disclosure = JSON.parse(await readFile(file, 'utf8'));

const ORIGINALS = {
  reason: 'Original Worldsmith model, generated preview or provenance document; authored locally from scripts/assets/originals.mjs without third-party geometry or textures.',
  source: 'scripts/assets/originals.mjs; scripts/assets/normalize.mjs',
  authorOrProvider: 'Worldsmith project — Codex-assisted original geometry',
  requiredNotices: ['No third-party asset notice; original project geometry. See public/assets/worldstream/PROVENANCE.md.'],
  attribution: 'Original Worldsmith starter models and generated previews, 2026-09-17.',
};
const GAME = {
  reason: 'Original Worldsmith game model, Blender preview or provenance document; assembled in Blender from primitive solids by scripts/assets/blender/game_models.py without third-party geometry, textures or generative 3D models.',
  source: 'scripts/assets/blender/game_models.py; scripts/assets/game-models.mjs',
  authorOrProvider: 'Worldsmith project — AI-assisted original geometry (Blender)',
  requiredNotices: ['No third-party asset notice; original project geometry. See public/assets/worldstream/game/PROVENANCE.md.'],
  attribution: 'Original Worldsmith game models and Blender previews, 2026-09-22.',
};

async function register(dir, origin) {
  for (const entry of await readdir(new URL(`public/${dir}/`, root), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fullName = `public/${dir}/${entry.name}`;
    const record = { name: fullName, kind: 'asset', firstParty: true, reason: origin.reason, source: origin.source,
      authorOrProvider: origin.authorOrProvider, license: 'LicenseRef-Worldsmith-Original', requiredNotices: origin.requiredNotices,
      attribution: origin.attribution,
      reviewNote: 'First-party, reproducible original geometry; no downloaded model or texture. No new license grant is asserted.', scope: 'prod' };
    const index = disclosure.entries.findIndex((e) => e.kind === 'asset' && e.name === fullName);
    if (index < 0) disclosure.entries.push(record); else disclosure.entries[index] = record;
  }
}

await register('assets/worldstream', ORIGINALS);
await register('assets/worldstream/game', GAME);
await writeFile(file, `${JSON.stringify(disclosure, null, 2)}\n`);
