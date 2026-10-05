/**
 * Chování brány `submission-check.mjs` nad skutečným stromem.
 *
 * Každý případ kazí v zeleném stromu **právě jednu věc** a tvrdí dvě věci
 * současně: **cílová kontrola selhala** a **žádná jiná ne**. Bez té druhé
 * poloviny by prošla i brána, která hlásí `FAIL` na všechno — a taková brána
 * neměří nic.
 *
 * **Síť se podvrhuje kontextu, ne procesu.** `runChecks()` bere `fetchImpl` jako
 * parametr; skript sám žádnou proměnnou prostředí, kterou by šlo síť zfalšovat,
 * nečte. Seam, kterým jde bráně podstrčit odpověď, je seam, kterým jde bránu
 * obejít, takže v produkční cestě žádný není.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COLLECTION_ITEMS_LIMIT,
  COVERAGE_UNTIL,
  DESCRIPTION_MIN_CHARS,
  LITERAL_BYTES_LIMIT,
  MONITOR_MAX_INTERVAL_SECONDS,
  VIDEO_LIMIT_SECONDS,
  buildContext,
  runChecks,
} from '../submission-check.mjs';
import { renderDisclosure, type DisclosureEntry } from '../license-gate.mjs';
import {
  BACKEND_URL,
  DEMO_URL,
  GREEN_WIRE,
  GUARANTEE,
  NOW,
  REPO_URL,
  SCRIPT,
  type Wire,
  buildTemplate,
  cleanup,
  description,
  fakeFetch,
  freshRepo,
  heartbeat,
  mp4,
  patchManifest,
  patchMonitoring,
  readRegistry,
  stage,
  write,
  writeRegistry,
} from './submission-fixture';

interface Result {
  id: number;
  detail: string | null;
  skipped: boolean;
}

let template = '';

beforeAll(() => {
  template = buildTemplate();
}, 60_000);

afterAll(cleanup);

function repo(): string {
  return freshRepo(template);
}

async function check(dir: string, wire: Wire = GREEN_WIRE): Promise<Result[]> {
  return runChecks(buildContext({ repo: dir, fetchImpl: fakeFetch(wire), now: NOW })) as Promise<Result[]>;
}

/** Čísla kontrol, které selhaly. */
function failed(results: Result[]): number[] {
  return results.filter((result) => !result.skipped && result.detail).map((result) => result.id);
}

function detailOf(results: Result[], id: number): string {
  return results.find((result) => result.id === id)?.detail ?? '';
}

function rewriteDescription(dir: string, text: string): void {
  write(dir, 'docs/submission/description.md', text);
}

/**
 * Adresa repozitáře se mění **v manifestu i v hlídači zároveň**. Kontrola 7
 * hlídá, že hlídač sleduje všechny tři adresy z manifestu, takže změna jen na
 * jedné straně je vada dvě — a případ by přestal měřit jednu věc.
 */
function setRepositoryUrl(dir: string, url: string): void {
  patchManifest(dir, { repositoryUrl: url });
  patchMonitoring(dir, {
    targets: [
      { name: 'repository', url },
      { name: 'demo', url: DEMO_URL },
      { name: 'backend', url: BACKEND_URL },
    ],
  });
  write(dir, 'ops/monitoring/heartbeat.jsonl', `${JSON.stringify({
      at: new Date(NOW - 60_000).toISOString(),
      targets: [{ url }, { url: DEMO_URL }, { url: BACKEND_URL }],
    })}\n`);
}

describe('zelený výchozí stav', () => {
  it('projde všech osm kontrol nad stromem, kde nic nechybí', async () => {
    const results = await check(repo());
    expect(failed(results)).toEqual([]);
    expect(results).toHaveLength(8);
  });
});

describe('[1] veřejný repozitář', () => {
  it('selže, když adresa není vyplněná', async () => {
    const dir = repo();
    setRepositoryUrl(dir, 'TODO: doplnit po P0 T100');
    expect(failed(await check(dir))).toEqual([1]);
  });

  it('selže, když adresa míří na localhost místo na veřejný hosting', async () => {
    const dir = repo();
    setRepositoryUrl(dir, 'http://localhost:8080/repo');
    const results = await check(dir);
    expect(failed(results)).toEqual([1]);
    expect(detailOf(results, 1)).toContain('localhost');
  });

  it('selže, když repozitář odpoví 404 — soukromé repo vypadá takhle', async () => {
    const results = await check(repo(), { ...GREEN_WIRE, [REPO_URL]: { status: 404, contentType: 'text/html' } });
    expect(failed(results)).toEqual([1]);
    expect(detailOf(results, 1)).toContain('404');
  });

  it('selže, když adresa vůbec neodpoví', async () => {
    expect(failed(await check(repo(), { ...GREEN_WIRE, [REPO_URL]: 'throw' }))).toEqual([1]);
  });
});

describe('[2] hostovaný demo link', () => {
  it('selže, když demo vrací JSON místo stránky', async () => {
    // `RULES.md` §3 chce demo plně v prohlížeči. Odpověď 200 s JSONem je živý
    // endpoint, ne demo, které si hodnotitel otevře.
    const results = await check(repo(), { ...GREEN_WIRE, [DEMO_URL]: { status: 200, contentType: 'application/json' } });
    expect(failed(results)).toEqual([2]);
    expect(detailOf(results, 2)).toContain('text/html');
  });

  it('selže, když demo neodpoví', async () => {
    expect(failed(await check(repo(), { ...GREEN_WIRE, [DEMO_URL]: 'throw' }))).toEqual([2]);
  });
});

describe('[3] demo video pod 3:00', () => {
  it('selže, když soubor chybí', async () => {
    const dir = repo();
    rmSync(join(dir, 'video/final.mp4'));
    expect(failed(await check(dir))).toEqual([3]);
  });

  it('selže o vteřinu nad tvrdým limitem', async () => {
    const dir = repo();
    write(dir, 'video/final.mp4', mp4(VIDEO_LIMIT_SECONDS + 1));
    const results = await check(dir);
    expect(failed(results)).toEqual([3]);
    expect(detailOf(results, 3)).toContain(String(VIDEO_LIMIT_SECONDS));
  });

  it('projde přesně na limitu', async () => {
    const dir = repo();
    write(dir, 'video/final.mp4', mp4(VIDEO_LIMIT_SECONDS));
    expect(failed(await check(dir))).toEqual([]);
  });

  it('selže, když délka nejde přečíst — nečitelné není krátké', async () => {
    const dir = repo();
    write(dir, 'video/final.mp4', Buffer.from('tohle není mp4'));
    const results = await check(dir);
    expect(failed(results)).toEqual([3]);
    expect(detailOf(results, 3)).toContain('mvhd');
  });
});

describe('[4] písemný popis', () => {
  it('selže, když popis chybí', async () => {
    const dir = repo();
    rmSync(join(dir, 'docs/submission/description.md'));
    // Kontrola 5 čte kategorii z téhož souboru, takže padnou obě — a je to
    // správně: bez popisu není ani kategorie.
    expect(failed(await check(dir))).toEqual([4, 5]);
  });

  it('selže nad zástupným popisem o třech větách', async () => {
    const dir = repo();
    rewriteDescription(dir, `# Worldsmith\n\n**Focus kategorie:** Games\n\nDoplním.\n\n> **${GUARANTEE}**\n\n2/27\n`);
    const results = await check(dir);
    expect(failed(results)).toEqual([4]);
    expect(detailOf(results, 4)).toContain(String(DESCRIPTION_MIN_CHARS));
  });

  it('selže bez sémantického omezení i s úplnou legacy garancí', async () => {
    const dir = repo();
    rewriteDescription(dir, description().replace('A robot win does not prove that the game matches the sentence.', GUARANTEE));
    const results = await check(dir);
    expect(failed(results)).toEqual([4]);
    expect(detailOf(results, 4)).toContain('semantic-limit');
  });
  // Slovní draft bez AI verze je to, co porotce uvidí při výpadku modelu, a
  // zároveň to, co se dá z popisu nejsnáz vynechat: popis bez té věty čte líp
  // a tvrdí něco, co produkt neumí. Proto má vlastní případ.
  it('selže, když popis zamlčí, že bez AI zůstane hra slovním draftem', async () => {
    const dir = repo();
    rewriteDescription(dir, description().replace(
      'The first version is a word draft. When the AI director is unavailable the game stays the draft and the page says so.',
      'Every game is designed by the AI.',
    ));
    const results = await check(dir);
    expect(failed(results)).toEqual([4]);
    expect(detailOf(results, 4)).toContain('draft-fallback');
  });

  it('selže, když popis zamlčí, jak často vizuální porota hru poznala', async () => {
    const dir = repo();
    rewriteDescription(dir, description().replace('A vision judge recognised the hero in some screenshots.', ''));
    const results = await check(dir);
    expect(failed(results)).toEqual([4]);
    expect(detailOf(results, 4)).toContain('recognisability');
  });

  it('současný popis nevyžaduje legacy DESIGN-BOOK', async () => {
    const dir = repo();
    rmSync(join(dir, 'DESIGN-BOOK.md'));
    expect(failed(await check(dir))).toEqual([]);
  });

  it('selže, když popis neuvádí jediné číslo z reportu', async () => {
    const dir = repo();
    rewriteDescription(dir, description().replace('2/27', 'většina'));
    const results = await check(dir);
    expect(failed(results)).toEqual([4]);
    expect(detailOf(results, 4)).toContain('neuvádí jediné číslo');
  });

  it('selže, když manifest ukazuje na report, který neexistuje', async () => {
    const dir = repo();
    patchManifest(dir, { measurementReports: ['evals/gates/neexistuje.md'] });
    expect(failed(await check(dir))).toEqual([4]);
  });
  it('selže, když uvedený report neobsahuje žádné měření', async () => {
    const dir = repo();
    write(dir, 'evals/gates/report.md', 'Measurement remains pending.');
    const results = await check(dir);
    expect(failed(results)).toEqual([4]);
    expect(detailOf(results, 4)).toContain('neobsahují ověřitelné naměřené číslo');
  });

  it('selže, když manifest neuvádí jediný report — pak nejde nic ověřit', async () => {
    const dir = repo();
    patchManifest(dir, { measurementReports: [] });
    expect(failed(await check(dir))).toEqual([4]);
  });
});

describe('[5] focus kategorie', () => {
  it('selže, když se popis a registrace rozcházejí', async () => {
    const dir = repo();
    rewriteDescription(dir, description().replace('**Focus kategorie:** Games', '**Focus kategorie:** Education'));
    const results = await check(dir);
    expect(failed(results)).toEqual([5]);
    expect(detailOf(results, 5)).toContain('rozpor s přihláškou');
  });

  it('selže, dokud registrace kategorii nedoplnila', async () => {
    const dir = repo();
    write(dir, 'plans/P8-odevzdani.md', '# P8\n\n<!-- registrace: focus-kategorie = TODO: T107 -->\n');
    const results = await check(dir);
    expect(failed(results)).toEqual([5]);
    expect(detailOf(results, 5)).toContain('ještě není doplněná');
  });

  it('selže, když plán registrační značku vůbec nemá', async () => {
    const dir = repo();
    write(dir, 'plans/P8-odevzdani.md', '# P8\n\nBez značky.\n');
    expect(failed(await check(dir))).toEqual([5]);
  });

  it('selže, když popis kategorii neuvádí', async () => {
    const dir = repo();
    rewriteDescription(dir, description().replace('**Focus kategorie:** Games\n', ''));
    expect(failed(await check(dir))).toEqual([5]);
  });
});

describe('[6] disclosure napříč pěti třídami', () => {
  it('propíše selhání license-gate, místo aby ho opisovalo', async () => {
    const dir = repo();
    const registry = readRegistry(dir);
    // Vyhozená položka `api` = host v kódu bez disclosure. To umí license-gate
    // a tenhle skript ho spouští; kdyby kontrolu opisoval, nález by se ztratil.
    registry.entries = registry.entries.filter((entry) => entry.kind !== 'api');
    writeRegistry(dir, registry);
    // Stagenout je nutné: license-gate certifikuje index, ne disk.
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('license-gate');
  });

  it('selže na identifikátoru modelu mimo deklarované tabulky', async () => {
    const dir = repo();
    write(dir, 'src/other.ts', "export const fallback = 'claude-opus-5';\n");
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('mimo tabulky');
  });

  /**
   * Tahle trojice drží tvar, který kontrola dostala 24. 8. 2026 v T28.
   *
   * Do té doby se ptala **jenom na umístění** a proti registru měřila výhradně
   * identifikátory uvnitř tabulky — takže model jmenovaný v testu se hlásil
   * jako nepořádek, ale jestli je v disclosure se nikdo neptal. Naměřeno na
   * skutečném stromě: 7 nálezů, z toho 0 nezveřejněných třetích stran.
   */
  it('neregistrovaný model v TESTU je nález, i když se test nikam nenasazuje', async () => {
    const dir = repo();
    write(dir, 'src/thing.test.ts', "export const used = 'mistral-42-large';\n");
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('mistral-42-large');
  });

  it('registrovaný model v testu projde — fixtura smí stát mimo tabulku', async () => {
    const dir = repo();
    write(dir, 'src/thing.test.ts', "export const used = 'claude-opus-5';\n");
    stage(dir);
    expect(failed(await check(dir))).toEqual([]);
  });

  /**
   * Trojice drží rozhodnutí z 18. 9. 2026: pravidlo o **umístění** literálu
   * platí na produkt, nástroj je z něj vyjmutý podle role, a registrační
   * půlka pravidla se tím nehne ani o kus.
   *
   * Naměřeno před rozhodnutím: 15 nálezů, z toho 0 nezveřejněných modelů —
   * samé měřicí harnesy a provozní skripty. Zamítnutá alternativa byla
   * dopsat těch 15 cest do `modelTablePaths`, čímž by pravidlo přestalo
   * cokoli znamenat.
   */
  it('registrovaný model v provozním skriptu projde — nástroj není produkt', async () => {
    const dir = repo();
    write(dir, 'scripts/host-preflight.mjs', "export const expected = 'claude-opus-5';");
    stage(dir);
    expect(failed(await check(dir))).toEqual([]);
  });

  it('měřicí harness projde i uvnitř src — o výjimce rozhoduje role, ne adresář', async () => {
    const dir = repo();
    write(dir, 'src/latency.measure.ts', "export const model = 'claude-opus-5';");
    stage(dir);
    expect(failed(await check(dir))).toEqual([]);
  });

  it('NEregistrovaný model v provozním skriptu je pořád nález', async () => {
    const dir = repo();
    write(dir, 'scripts/host-preflight.mjs', "export const expected = 'mistral-42-large';");
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('mistral-42-large');
  });

  it('položka první strany registraci splní — a nic víc po ní chtít nejde', async () => {
    const dir = repo();
    // Vymyšlený identifikátor ve fixtuře. Přejmenovat ho nejde (existuje proto,
    // aby ho registr neznal) a zapsat ho jako třetí stranu by byla nepravda —
    // proto `firstParty`, a proto bez licence a atribuce.
    write(dir, 'src/thing.test.ts', "export const absent = 'gpt-neexistuje';\n");
    const registry = readRegistry(dir);
    registry.entries.push({
      name: 'gpt-neexistuje',
      kind: 'model',
      firstParty: true,
      reason: 'vymyšlený identifikátor ve fixtuře, žádný takový model neexistuje',
    });
    writeRegistry(dir, registry);
    // Výpis se musí přegenerovat spolu s registrem — license-gate kontrola 6
    // hlídá, že se ty dva soubory nerozejdou, a je to ta půlka, která brání
    // tichému vyškrtnutí z veřejného dokumentu.
    const rendered = renderDisclosure(registry.entries as unknown as readonly DisclosureEntry[]);
    write(dir, 'DISCLOSURE.md', rendered);
    stage(dir);
    expect(failed(await check(dir))).toEqual([]);
    // A první strana se do výpisu dostane — svojí sekcí, ne mezi třetí strany.
    expect(rendered).toContain('Vlastní, ne třetí strana');
    expect(rendered).toContain('gpt-neexistuje');
  });

  it('selže, když model v tabulce není v registru', async () => {
    const dir = repo();
    write(dir, 'src/model/prompt.ts', "export const EMISSION_MODEL = 'gemini-9-pro';\n");
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('gemini-9-pro');
  });

  it('selže, když manifest tabulku modelů neurčuje', async () => {
    const dir = repo();
    patchManifest(dir, { modelTablePath: 'TODO: určit tabulku' });
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('modelTablePath');
  });

  it('selže, když tabulka modelů není sledovaný soubor', async () => {
    const dir = repo();
    patchManifest(dir, { modelTablePath: 'src/neexistuje.ts' });
    expect(failed(await check(dir))).toEqual([6]);
  });

  /**
   * Dvojice drží **množné číslo** klíče `modelTablePaths`, kvůli kterému se
   * manifest 24. 8. 2026 měnil: produkt má tabulku `src/model/prompt.ts`,
   * měřicí řetězec vlastní (`evals/harness/preflight.ts`) a jedna společná
   * neexistuje. Dokud se četl jen jeden klíč, hlásila kontrola tu druhou jako
   * nález — přestože všechny její identifikátory v registru byly.
   *
   * Testy jsou dva schválně: první ukazuje, že druhá tabulka projde, druhý nad
   * TÝMŽ stromem ukazuje, že bez ní je to nález. Bez té druhé půlky by první
   * prošel i bráně, která na umístění rezignovala úplně.
   */
  it('druhá deklarovaná tabulka modelů projde', async () => {
    const dir = repo();
    write(dir, 'src/second-table.ts', "export const LIVE = 'claude-opus-5';\n");
    patchManifest(dir, { modelTablePath: undefined, modelTablePaths: ['src/model/prompt.ts', 'src/second-table.ts'] });
    stage(dir);
    expect(failed(await check(dir))).toEqual([]);
  });

  it('nedeklarovaná druhá tabulka je nález — allowlist platí jen na to, co v manifestu stojí', async () => {
    const dir = repo();
    write(dir, 'src/second-table.ts', "export const LIVE = 'claude-opus-5';\n");
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('src/second-table.ts');
  });

  it('selže na souboru v datovém adresáři, který žádný dataset nepokrývá', async () => {
    const dir = repo();
    write(dir, 'data/extra/kody.jsonl', '{"a":1}\n');
    const registry = readRegistry(dir);
    for (const entry of registry.entries) if (entry.kind === 'dataset') entry.paths = ['data/corpus.jsonl'];
    writeRegistry(dir, registry);
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('kody.jsonl');
  });

  it('selže, když manifest neuvádí jediný datový adresář', async () => {
    const dir = repo();
    patchManifest(dir, { dataDirs: [] });
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('dataDirs');
  });

  it('selže na modulu, do kterého někdo vložil dataset jako řetězec', async () => {
    const dir = repo();
    // Serializovaný JSON v jednom řetězci: pod prahem mířeným na pole a objekty
    // by prošel celý, proto se počítají bajty všech literálů.
    write(dir, 'src/embedded.ts', `export const data = '${'a'.repeat(LITERAL_BYTES_LIMIT + 1)}';\n`);
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('src/embedded.ts');
  });

  it('selže na dlouhé kolekci, i když je v ní málo bajtů', async () => {
    const dir = repo();
    const items = Array.from({ length: COLLECTION_ITEMS_LIMIT + 1 }, (_, index) => index).join(',');
    write(dir, 'src/codes.ts', `export const codes = [${items}];\n`);
    stage(dir);
    const results = await check(dir);
    expect(failed(results)).toEqual([6]);
    expect(detailOf(results, 6)).toContain('src/codes.ts');
  });

  it('registrovaný modul projde — registrace je ta jediná úniková cesta', async () => {
    const dir = repo();
    write(dir, 'src/embedded.ts', `export const data = '${'a'.repeat(LITERAL_BYTES_LIMIT + 1)}';\n`);
    const registry = readRegistry(dir);
    for (const entry of registry.entries) if (entry.kind === 'dataset') entry.paths = ['data', 'src/embedded.ts'];
    writeRegistry(dir, registry);
    stage(dir);
    expect(failed(await check(dir))).toEqual([]);
  });

  it('netrackovaný soubor kontrolu nezajímá — publikuje se index, ne disk', async () => {
    const dir = repo();
    write(dir, 'src/scratch.ts', `export const data = '${'a'.repeat(LITERAL_BYTES_LIMIT + 1)}';\n`);
    expect(failed(await check(dir))).toEqual([]);
  });
});

describe('[7] backend a průběžné hlídání', () => {
  it('selže, když backend neodpoví', async () => {
    expect(failed(await check(repo(), { ...GREEN_WIRE, [BACKEND_URL]: 'throw' }))).toEqual([7]);
  });

  it('selže, když backend odpoví, ale nikdo nehlídá dál', async () => {
    const dir = repo();
    rmSync(join(dir, 'ops/monitoring/uptime.json'));
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('nikdo nehlídá');
  });

  it('selže, když hlídač nesleduje všechny tři adresy', async () => {
    const dir = repo();
    patchMonitoring(dir, { targets: [{ name: 'backend', url: BACKEND_URL }] });
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('repositoryUrl');
  });

  it('selže, když je interval delší než strop', async () => {
    const dir = repo();
    patchMonitoring(dir, { intervalSeconds: MONITOR_MAX_INTERVAL_SECONDS + 1 });
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('intervalSeconds');
  });

  it('selže, když hlídání končí před 25. 11.', async () => {
    const dir = repo();
    patchMonitoring(dir, { coverageUntil: '2026-11-12' });
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain(COVERAGE_UNTIL);
  });

  it('selže, když alert nemá adresáta', async () => {
    const dir = repo();
    patchMonitoring(dir, { alert: { channel: 'email', destination: '' } });
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('alert');
  });

  it('selže, když hlídač nikdy neběžel', async () => {
    const dir = repo();
    rmSync(join(dir, 'ops/monitoring/heartbeat.jsonl'));
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('nikdy neběžel');
  });

  it('selže, když poslední záznam hlídače je starý — konfigurace není hlídání', async () => {
    const dir = repo();
    write(dir, 'ops/monitoring/heartbeat.jsonl', heartbeat(new Date(NOW - 3 * 3600_000).toISOString()));
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('hlídač neběží');
  });

  it('selže, když poslední záznam některou adresu neměřil', async () => {
    const dir = repo();
    write(dir, 'ops/monitoring/heartbeat.jsonl', `${JSON.stringify({ at: new Date(NOW - 60_000).toISOString(), targets: [{ url: BACKEND_URL }] })}\n`);
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain(DEMO_URL);
  });
});

describe('[8] blind-check', () => {
  it('propíše selhání blind-checku do výsledku', async () => {
    const dir = repo();
    // Trackovaný config je nález blind-checku: nese jména, která se nesmí nahrát.
    write(dir, '.gitignore', 'node_modules/\n');
    stage(dir);
    execFileSync('git', ['--no-replace-objects', 'commit', '-m', 'leak'], { cwd: dir, stdio: 'ignore' });
    expect(failed(await check(dir))).toEqual([8]);
  });
});

describe('kontrola, která spadne, není splněná kontrola', () => {
  it('výjimka uvnitř kontroly se hlásí jako selhání, ne jako ticho', async () => {
    const dir = repo();
    write(dir, 'ops/monitoring/uptime.json', '{ tohle není JSON');
    const results = await check(dir);
    expect(failed(results)).toEqual([7]);
    expect(detailOf(results, 7)).toContain('kontrola spadla');
  });
});

describe('návratové kódy — to čte člověk i T804', () => {
  function run(dir: string, args: string[] = []): { code: number; out: string } {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  }

  it('--offline vrací 2, ne 0 — přeskočená kontrola není splněná', () => {
    const { code, out } = run(repo(), ['--offline']);
    expect(code).toBe(2);
    expect(out).not.toMatch(/^FAIL/m);
    expect(out).toMatch(/^SKIP {2}\[1]/m);
    expect(out).toContain('NENÍ splněná');
  });

  it('vrací 1, když kterákoli kontrola selže — i v offline běhu', () => {
    const dir = repo();
    rmSync(join(dir, 'video/final.mp4'));
    const { code, out } = run(dir, ['--offline']);
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL {2}\[3]/m);
  });

  it('bez manifestu selže hned, místo aby hlásil sedm zelených kontrol', () => {
    const dir = repo();
    rmSync(join(dir, 'docs/submission/submission.json'));
    const { code, out } = run(dir, ['--offline']);
    expect(code).toBe(1);
    expect(out).toContain('neexistuje');
  });

  it('--help vrací 0 a nic neměří', () => {
    const { code, out } = run(repo(), ['--help']);
    expect(code).toBe(0);
    expect(out).toContain('RULES.md §2');
    expect(out).not.toMatch(/^(PASS|FAIL|SKIP)/m);
  });
});
