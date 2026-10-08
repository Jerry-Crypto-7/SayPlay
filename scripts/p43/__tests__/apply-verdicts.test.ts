/**
 * Verdikty slepého soudu do katalogu (P43 T13). Přejmenovaný model, který se pak vybere
 * pro špatné slovo, vypadá jako oprava – proto se jméno soudce jen přidá a jen u jasné neshody: soudce
 * `nameFits` srovnává i přívlastek „(CC0, Quaternius)“ a celé dvojslovo tagu, takže kniha
 * `book-single` nazvaná „book“ u něj neprojde, a ta tu zůstat musí.
 */

import { describe, expect, it } from 'vitest';

import { applyVerdicts, fitsCatalog } from '../apply-verdicts.mjs';

const verdict = (name: string, alternatives: string[] = [], recognizable = true) => ({
  sheet: 'grid-001',
  cell: 1,
  name,
  alternatives,
  recognizable,
  nameFits: false,
  suggestedName: recognizable ? name : null,
  realSize: 1,
});

const asset = (assetId: string, label: string, tags: string[]) => ({ assetId, label, tags });

describe('fitsCatalog', () => {
  it('fits on the head word despite the pack suffix and a compound tag', () => {
    expect(fitsCatalog(asset('cc0-book-single', 'Book Single (CC0, Quaternius)', ['book-single']), verdict('book'))).toBe(true);
    expect(fitsCatalog(asset('cc0-cabinet-doors', 'Cabinet Doors (CC0, Quaternius)', ['cabinet']), verdict('Shelving unit', ['Cupboard', 'Cabinet']))).toBe(true);
  });

  it('fits when the catalog word is only a modifier in the judged name', () => {
    expect(fitsCatalog(asset('gen3d-perfume', 'perfume (generated)', ['perfume']), verdict('Perfume bottle'))).toBe(true);
  });

  it('fits through plurals and through the id when the tags are thin', () => {
    expect(fitsCatalog(asset('cc0-book-set', 'Book Set (CC0, Quaternius)', []), verdict('books'))).toBe(true);
  });

  it('misses when nothing the judge saw is a catalog name', () => {
    expect(fitsCatalog(asset('cc0-axe', 'Axe (CC0, Quaternius)', ['axe']), verdict('katana', ['sword', 'samurai sword']))).toBe(false);
    expect(fitsCatalog(asset('cc0-bush', 'Bush (CC0, Quaternius)', ['bush']), verdict('Boulder', ['Rock', 'Stone']))).toBe(false);
  });
});

describe('applyVerdicts', () => {
  const catalog = {
    version: 1,
    assets: [
      asset('cc0-axe', 'Axe (CC0, Quaternius)', ['axe']),
      asset('cc0-book-single', 'Book Single (CC0, Quaternius)', ['book-single']),
      asset('blob', 'Blob', ['blob']),
      asset('cc0-unjudged', 'Unjudged', ['unjudged']),
    ],
  };
  const verdicts = {
    'cc0-axe': verdict('Katana', ['Sword', 'samurai sword']),
    'cc0-book-single': verdict('book'),
    blob: verdict('unknown', [], false),
  };
  const { catalog: out, seen, unrecognisable } = applyVerdicts(catalog, verdicts);
  const byId = new Map(out.assets.map((entry) => [entry.assetId, entry]));

  it('adds what the judge saw beside the old name, never in place of it', () => {
    expect(byId.get('cc0-axe')).toMatchObject({ label: 'Axe (CC0, Quaternius)', tags: ['axe', 'seen:katana', 'seen:sword', 'seen:samurai sword'] });
    expect(seen).toEqual([{ assetId: 'cc0-axe', label: 'Axe (CC0, Quaternius)', seen: 'Katana' }]);
  });

  it('keeps a fitting model and a model without a verdict as they were', () => {
    expect(byId.get('cc0-book-single')).toEqual(catalog.assets[1]);
    expect(byId.get('cc0-unjudged')).toEqual(catalog.assets[3]);
  });

  it('marks an unrecognisable model and keeps its name', () => {
    expect(byId.get('blob')).toMatchObject({ label: 'Blob', tags: ['blob', 'qa:unrecognisable'] });
    expect(unrecognisable).toEqual(['blob']);
  });

  it('is idempotent – a second run changes nothing', () => {
    const again = applyVerdicts(out, verdicts);
    expect(again.catalog).toEqual(out);
    expect(again.seen).toEqual([]);
  });

  it('does not mutate the input catalog', () => {
    expect(catalog.assets[0]).toEqual(asset('cc0-axe', 'Axe (CC0, Quaternius)', ['axe']));
  });
});
