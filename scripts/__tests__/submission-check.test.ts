/**
 * Čisté funkce, na kterých `submission-check.mjs` stojí. Chování brány nad
 * stromem měří `submission-check-gate.test.ts`; tady jde o to, aby jednotlivé
 * odpovědi byly správné dřív, než je někdo poskládá.
 *
 * Nejdůležitější případy v tomhle souboru jsou ty **negativní**: nečitelná
 * délka videa nesmí vyjít jako nula, sourozenec adresáře nesmí projít jako jeho
 * obsah a komentář nesmí vážit jako dataset. Všechny tři jsou ticho, které by se
 * jinak četlo jako „v pořádku".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COLLECTION_ITEMS_LIMIT,
  LITERAL_BYTES_LIMIT,
  coveredByPaths,
  datasetPaths,
  distinctiveNumbers,
  focusCategoryInDescription,
  focusCategoryInRegistration,
  descriptionContractProblems,
  isDeployedUrl,
  isPlaceholder,
  literalWeight,
  mp4DurationSeconds,
  proseOf,
} from '../submission-check.mjs';
import { box, mp4, description, GUARANTEE } from './submission-fixture';

describe('isDeployedUrl: nasazená adresa, ne localhost', () => {
  it('pustí veřejné jméno přes https', () => {
    expect(isDeployedUrl('https://worldsmith.example.io/')).toBeNull();
  });

  it.each([
    ['http://localhost:3000/', 'localhost'],
    ['http://127.0.0.1:3000/', 'loopback'],
    ['http://192.168.1.10/', 'privátní'],
    ['http://10.0.0.5/', 'privátní'],
    ['http://172.16.0.9/', 'privátní'],
    ['http://demo.local/', 'dokumentaci'],
    ['https://example.com/', 'dokumentaci'],
  ])('odmítne %s', (url, reason) => {
    expect(isDeployedUrl(url)).toContain(reason);
  });

  it('odmítne jiný protokol než http(s)', () => {
    expect(isDeployedUrl('file:///C:/build/index.html')).toContain('protokol');
  });

  it('odmítne jméno bez tečky — intranetový host není veřejná adresa', () => {
    expect(isDeployedUrl('https://demo/')).toContain('plně kvalifikované');
  });

  it('odmítne text, který není URL', () => {
    expect(isDeployedUrl('doplním později')).toBe('není platná URL');
  });
});

describe('mp4DurationSeconds: délka ze skutečných metadat', () => {
  it('přečte délku z mvhd verze 0', () => {
    expect(mp4DurationSeconds(mp4(95))).toBeCloseTo(95, 3);
  });

  it('přečte délku z mvhd verze 1, kde jsou časy 64bitové', () => {
    expect(mp4DurationSeconds(mp4(200, 1))).toBeCloseTo(200, 3);
  });

  it('vrátí null, když v souboru žádný moov není', () => {
    // Null, ne nula. Nula by prošla limitem tří minut, takže soubor, jehož délku
    // nikdo nepřečetl, by se vydával za krátké video.
    expect(mp4DurationSeconds(Buffer.from('not an mp4 at all'))).toBeNull();
  });

  it('vrátí null, když box lže o velikosti a přetéká přes konec souboru', () => {
    const broken = box('moov', Buffer.alloc(16));
    broken.writeUInt32BE(9999, 0);
    expect(mp4DurationSeconds(broken)).toBeNull();
  });

  it('vrátí null při nulovém timescale místo dělení nulou', () => {
    expect(mp4DurationSeconds(box('moov', box('mvhd', Buffer.alloc(100))))).toBeNull();
  });
});

describe('current source submission disclosure contract, not semantic certification', () => {
  it('accepts current project copy without demanding the superseded guarantee', () => {
    const current = readFileSync(join(process.cwd(), 'docs/submission/description.md'), 'utf8');
    expect(descriptionContractProblems(current)).toEqual([]);
    expect(descriptionContractProblems(description())).toEqual([]);
  });
  it.each([
    ['source-scope', 'one timer intervention', 'unlimited interventions'],
    ['parameter-review', 'missing or conflicting support blocks acceptance', 'every proposal is accepted'],
    ['semantic-limit', 'This acknowledgement does not certify semantic correctness. A structurally valid citation is not a semantic guarantee.', 'Semantic correctness is guaranteed.'],
    ['geometry-limit', 'Geometry is schematic.', 'Geometry is physically exact.'],
    ['latency-provenance', 'CLI timings include process and transport overhead.', 'CLI timings are provider compute time.'],
    ['independent-review', 'independent semantic review', 'automated validation'],
  ])('rejects missing %s even when a legacy guarantee is present', (id, original, replacement) => {
    expect(descriptionContractProblems(`${description().replace(original, replacement)}\n${GUARANTEE}`)).toEqual([
      expect.stringContaining(id),
    ]);
  });
  it('accepts wording and markdown changes instead of requiring an exact quote', () => {
    const text = description().replace('one timer intervention', '**single** timer intervention')
      .replace('does not certify semantic correctness', 'cannot guarantee semantic accuracy');
    expect(descriptionContractProblems(text)).toEqual([]);
  });
  it('does not count disclosure hidden inside comments or code', () => {
    expect(descriptionContractProblems(`<!-- ${description()} -->`)).toHaveLength(6);
    expect(descriptionContractProblems(`\x60\x60\x60text\n${description()}\n\x60\x60\x60`)).toHaveLength(6);
  });
});

describe('distinctiveNumbers: zlomky a desetinná čísla, ne holá celá', () => {
  it('vezme zlomek i desetinné číslo', () => {
    expect([...distinctiveNumbers('prošlo 2/27, tedy 7,4 %')]).toEqual(['2/27', '7,4']);
  });

  it('holé celé číslo nebere — „3" nedokazuje citaci měření', () => {
    expect([...distinctiveNumbers('máme 3 hry a 12 archetypů')]).toEqual([]);
  });
});

describe('proseOf: próza, ne markdown', () => {
  it('zahodí nadpisy, odrážky a odkazy, obsah nechá', () => {
    const prose = proseOf('# Nadpis\n\n- [odkaz](https://x.io) v odrážce\n\n> citace\n');
    expect(prose).toBe('Nadpis odkaz v odrážce citace');
  });

  it('zahodí i blok kódu — ukázka není popis projektu', () => {
    expect(proseOf('Text.\n\n```js\nconst a = 1;\n```\n')).toBe('Text.');
  });
});

describe('literalWeight: váha dat, ne komentářů', () => {
  it('sečte bajty řetězcových literálů', () => {
    expect(literalWeight('x.ts', `const a = '${'x'.repeat(50)}';\n`).bytes).toBe(50);
  });

  it('započítá i šablonový literál — serializovaný dataset bývá právě v něm', () => {
    expect(literalWeight('x.ts', `const a = \`${'y'.repeat(40)}\`;\n`).bytes).toBe(40);
  });

  it('komentář o velikosti datasetu se nepočítá', () => {
    // Jinak by práh trestal psaní komentářů, a tenhle repozitář jich má hodně.
    expect(literalWeight('x.ts', `/* ${'z'.repeat(9000)} */\nexport const a = 1;\n`).bytes).toBeLessThan(
      LITERAL_BYTES_LIMIT,
    );
  });

  it('změří nejdelší kolekci', () => {
    const items = Array.from({ length: COLLECTION_ITEMS_LIMIT + 1 }, (_, index) => index).join(',');
    expect(literalWeight('x.ts', `export const a = [${items}];\n`).items).toBe(COLLECTION_ITEMS_LIMIT + 1);
  });

  it('umí i .mjs, ne jen TypeScript', () => {
    expect(literalWeight('x.mjs', `export const a = '${'q'.repeat(30)}';\n`).bytes).toBe(30);
  });
});

describe('coveredByPaths: prefix adresáře, ne prefix řetězce', () => {
  it('pokryje přesnou shodu i soubor v adresáři', () => {
    expect(coveredByPaths('data/a.json', ['data'])).toBe(true);
    expect(coveredByPaths('data', ['data'])).toBe(true);
  });

  it('nepokryje sourozence, jehož jméno začíná stejně', () => {
    // `data2/` není `data/`. Prefix na holém řetězci by ho pokryl a registrace
    // jednoho adresáře by tiše legalizovala druhý.
    expect(coveredByPaths('data2/a.json', ['data'])).toBe(false);
  });

  it('nepokryje nic, když registrovaných cest není žádná', () => {
    expect(coveredByPaths('data/a.json', [])).toBe(false);
  });
});

describe('isPlaceholder a čtení kategorií', () => {
  it('nevyplněné pole pozná podle prefixu i podle prázdnoty', () => {
    expect(isPlaceholder('TODO: doplní T107')).toBe(true);
    expect(isPlaceholder('   ')).toBe(true);
    expect(isPlaceholder(undefined)).toBe(true);
    expect(isPlaceholder('Games')).toBe(false);
  });

  it('kategorii z popisu i z registrace přečte z jejich vlastních značek', () => {
    expect(focusCategoryInDescription('# X\n\n**Focus kategorie:** Games\n')).toBe('Games');
    expect(focusCategoryInRegistration('<!-- registrace: focus-kategorie = Games -->')).toBe('Games');
  });

  it('registrační značka ve skutečném plánu P8 existuje', () => {
    // Bez ní by kontrola 5 neměla proti čemu měřit. Že je zatím `TODO:`, drží
    // bránu červenou — a to je správný stav, dokud registrace neproběhne.
    const plan = readFileSync(join(process.cwd(), 'plans', 'P8-odevzdani.md'), 'utf8');
    expect(focusCategoryInRegistration(plan)).not.toBeNull();
  });
});

describe('datasetPaths', () => {
  it('sesbírá cesty jen z položek kind: dataset', () => {
    const registry = {
      entries: [
        { kind: 'dataset', paths: ['data', 'corpus.jsonl'] },
        { kind: 'library', paths: ['node_modules/x'] },
        { kind: 'dataset' },
      ],
    };
    expect(datasetPaths(registry)).toEqual(['data', 'corpus.jsonl']);
  });
});
