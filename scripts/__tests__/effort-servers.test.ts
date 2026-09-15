import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `ship-testgaps2`: `effort-servers.mjs` pouští `next start` s živou větví
 * `codex-cli`, takže server bez `-H 127.0.0.1` poslouchá na 0.0.0.0 a větu na
 * cizí předplatné by poslal kdokoli z LAN. Skript při importu rovnou běží
 * (`process.argv[2]`), proto se soudí zdroj: každé spuštění `next start`
 * musí nést smyčku, ne jen komentář nad sebou.
 */
describe('the effort launcher', () => {
  const source = readFileSync(join(__dirname, '..', 'effort-servers.mjs'), 'utf8');
  const starts = source.split('\n').filter((line) => /nextBin,\s*'start'/.test(line));

  it('binds every next start it spawns to the loopback address', () => {
    expect(starts.length, 'the launcher no longer spawns next start where this test looks').toBeGreaterThan(0);
    for (const line of starts) expect(line).toMatch(/'-H',\s*'127\.0\.0\.1'/);
  });
});
