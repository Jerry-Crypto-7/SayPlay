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
  descriptionContractProblems,
  isDeployedUrl,
  isPlaceholder,
  literalWeight,
  mp4DurationSeconds,
  productionDirector,
  proseOf,
} from '../submission-check.mjs';
import { modelIdsIn, registeredModelNames } from '../license-gate.mjs';
import { box, mp4, description, FIXTURE_DIRECTOR, GUARANTEE } from './submission-fixture';

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
  // Každý řádek smí rozbít **právě jedno** omezení – proto se proti fixtuře
  // nahrazuje věta, kterou vymáhá jediná položka kontraktu. Když se kontrakt
  // přepíše a tenhle seznam ne, nahrazení přestane cokoli měnit a popis zůstane
  // vyhovující: výsledek je `[]` místo jednoho `id`, a případ zčervená.
  it.each([
    ['sentence-scope', 'becomes a short 3D game', 'becomes a short video'],
    ['gamespec-only', 'never writes code', 'writes the game code'],
    ['draft-fallback', 'is unavailable', 'is busy'],
    ['recognisability', 'A vision judge recognised', 'A reviewer liked'],
    ['semantic-limit', 'does not prove that the game matches', 'proves that the game matches'],
    ['hosted-cost', 'behind a spend cap', 'on a flat fee'],
    ['independent-review', 'there is no human playtest yet', 'players love it'],
  ])('rejects missing %s even when a legacy guarantee is present', (id, original, replacement) => {
    expect(descriptionContractProblems(`${description().replace(original, replacement)}\n${GUARANTEE}`)).toEqual([
      expect.stringContaining(id),
    ]);
  });
  // P71A: jméno režiséra v hosted-cost se bere z produkčního vzoru, ne napevno gpt-oss.
  it('wants the director the production example runs, not a hard-coded model', () => {
    const stale = description().replace(FIXTURE_DIRECTOR, 'gpt-oss-20b');
    expect(descriptionContractProblems(stale, FIXTURE_DIRECTOR)).toEqual([expect.stringContaining('hosted-cost')]);
    expect(descriptionContractProblems(stale, 'gpt-oss-20b')).toEqual([]);
    expect(descriptionContractProblems(description().replace(FIXTURE_DIRECTOR, `${FIXTURE_DIRECTOR}-mini`), FIXTURE_DIRECTOR)).toEqual([expect.stringContaining('hosted-cost')]);
    expect(descriptionContractProblems(description(), null)).toEqual([expect.stringContaining('hosted-cost')]);
  });
  it('reads the director of this repository from scripts/cloud/env.production.example', () => {
    expect(productionDirector(process.cwd())).toBe(FIXTURE_DIRECTOR);
  });
  it('accepts wording and markdown changes instead of requiring an exact quote', () => {
    const text = description().replace('a short 3D game', 'a short **3D** game')
      .replace('does not prove that the game matches', 'cannot guarantee that the game matches');
    expect(descriptionContractProblems(text)).toEqual([]);
  });
  it('does not count disclosure hidden inside comments or code', () => {
    // Počet se čte z kontraktu, ne z ruky: nad prázdným textem chybí všechno.
    // Připíchnuté číslo by se po každém přepsání kontraktu rozešlo s realitou,
    // což je přesně to, co se 16. 9. stalo. Nula na pravé straně by znamenala,
    // že komentář prošel jako disclosure.
    const all = descriptionContractProblems('').length;
    expect(all).toBeGreaterThan(0);
    expect(descriptionContractProblems(`<!-- ${description()} -->`)).toHaveLength(all);
    expect(descriptionContractProblems(`\x60\x60\x60text\n${description()}\n\x60\x60\x60`)).toHaveLength(all);
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

  it('kategorii z popisu přečte z jeho vlastní značky', () => {
    expect(focusCategoryInDescription('# X\n\n**Focus kategorie:** Games\n')).toBe('Games');
  });

  it('registrovaná kategorie stojí ve sledovaném manifestu a sedí na skutečný popis', () => {
    // Kontrola 5 ji dřív četla z `plans/P8-odevzdani.md`, který je gitignorovaný
    // a v čistém klonu ani v hlavní složce není — brána tak padala na chybějícím
    // souboru, ne na rozporu s přihláškou.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'docs/submission/submission.json'), 'utf8'));
    const text = readFileSync(join(process.cwd(), 'docs/submission/description.md'), 'utf8');
    expect(isPlaceholder(manifest.focusCategory)).toBe(false);
    expect(focusCategoryInDescription(text)).toBe(manifest.focusCategory);
  });
});

describe('modelIdsIn: jméno modelu, ne jméno nástroje ani souboru', () => {
  // Jména modelů se skládají za běhu: literál v tomhle souboru by sám byl
  // nález kontroly 6 a potřeboval by vymyšlenou položku v registru.
  const id = (...parts: string[]) => parts.join('-');

  it('binárky llama.cpp nejsou model Llama — skutečný model Llama ano', () => {
    expect([...modelIdsIn("run('llama-server'); run('llama-bench');")]).toEqual([]);
    // Výjimka je výčet binárek, ne prefix: kdyby spolkla `llama-*`, zmizel by
    // z kontroly každý model rodiny Llama.
    for (const model of [id('llama', '3.1', '8b'), id('llama', 'server', '70b')]) {
      expect([...modelIdsIn(`const m = '${model}';`)]).toEqual([model]);
    }
  });

  it('soubor pojmenovaný po modelu jmenuje ten model, přípona k jménu nepatří', () => {
    expect([...modelIdsIn("read('audit-12.gpt-oss-20b.json')")]).toEqual(['gpt-oss-20b']);
    expect([...modelIdsIn("join(dir, 'gpt-oss-20b-MXFP4.gguf')")]).toEqual(['gpt-oss-20b-mxfp4']);
  });
});

describe('registeredModelNames: jména a aliasy položek kind: model', () => {
  it('započítá alias modelu, alias jiné třídy ne', () => {
    const names = registeredModelNames([
      { kind: 'model', name: 'gpt-oss-20b', aliases: ['gpt-oss', 'GPT-OSS-20B-MXFP4'] },
      { kind: 'api', name: 'Groq API', aliases: ['mistral-42-large'] },
    ]);
    expect([...names].sort()).toEqual(['gpt-oss', 'gpt-oss-20b', 'gpt-oss-20b-mxfp4']);
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
