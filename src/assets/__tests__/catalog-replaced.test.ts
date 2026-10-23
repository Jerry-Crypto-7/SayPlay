import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReplaced } from '../../../scripts/p37d/promote-batch.mjs';
import catalog from '../catalog.json';

/**
 * Modely vyměněné pod stejným id (P57, `promote-batch.mjs --replace`): soubor na místě,
 * `bounds` podle souboru, licence výroby v katalogu i v disclosure. Hlídá i opětovné
 * spuštění `register-disclosure.mjs`, které by vyměněnému originálu vrátilo starý záznam.
 */
describe('replaced catalog models (P57 T5)', () => {
  it('every replaced model has its files, bounds that match them and a generated-model disclosure', async () => {
    const disclosure = JSON.parse(readFileSync('disclosure.json', 'utf8'));
    expect(await checkReplaced({ catalog, disclosure })).toEqual([]);
  }, 60_000);
});
