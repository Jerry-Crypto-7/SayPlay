/** Register generated, first-party artifacts without changing library entries. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const file = new URL('disclosure.json', root);
const disclosure = JSON.parse(await readFile(file, 'utf8'));
for (const name of await readdir(new URL('public/assets/worldstream/', root))) {
  const fullName = `public/assets/worldstream/${name}`;
  const entry = { name: fullName, kind: 'asset', firstParty: true,
    reason: 'Original Worldsmith model, generated preview or provenance document; authored locally from scripts/assets/originals.mjs without third-party geometry or textures.',
    source: 'scripts/assets/originals.mjs; scripts/assets/normalize.mjs',
    authorOrProvider: 'Worldsmith project — Codex-assisted original geometry',
    license: 'LicenseRef-Worldsmith-Original',
    requiredNotices: ['No third-party asset notice; original project geometry. See public/assets/worldstream/PROVENANCE.md.'],
    attribution: 'Original Worldsmith starter models and generated previews, 2026-09-17.',
    reviewNote: 'First-party, reproducible original geometry; no downloaded model or texture. No new license grant is asserted.', scope: 'prod' };
  const index = disclosure.entries.findIndex((e) => e.kind === 'asset' && e.name === fullName);
  if (index < 0) disclosure.entries.push(entry); else disclosure.entries[index] = entry;
}
await writeFile(file, `${JSON.stringify(disclosure, null, 2)}\n`);
