/**
 * Rozhodovací logika důkazu z `scripts/prove-fallback-isolation.mjs`.
 *
 * Celá hermetická sekvence (studený build, spuštění artefaktu, smoke) je jeden
 * příkaz — `npm run prove:fallback` — a trvá minuty. Sem patří to, na čem ten
 * příkaz stojí a co jde zlomit tiše: výpočet tranzitivního obalu jádra, čtení
 * skutečného reportu bundlu a hranice, o kterou se ta logika snadno pořeže.
 *
 * Poslední blok je jiné povahy než ostatní: neběží nad syntetickými daty, ale
 * nad skutečným stromem repozitáře, a tvrdí to samé, co dokazuje build —
 * jenom levněji a bez záruky, kterou dává jen sestavený artefakt.
 *
 * **Dvě věci se sem nesmí napsat doslova**, jinak si test sám podřízne větev:
 *  - cesty do jádra — `router.test.ts` z T202 skenuje `src/fallback/**` na ně
 *    jako na řetězce, takže se skládají přes `SRC` za běhu, stejně jako to ten
 *    sken dělá sám na sobě;
 *  - skutečná jména globálů a existující cesty v importech ve fixturách —
 *    `importSpecifiers` i `expandByAmbientGlobals` čtou text, takže by tenhle
 *    soubor spadl do vlastní karantény.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CORE_DIRS,
  PROTECTED_DIRS,
  analyzerModules,
  buildImportGraph,
  coreModulesIn,
  coreReachSet,
  expandByAmbientGlobals,
  fallbackBytes,
  globalMembers,
  importSpecifiers,
  isLocalConnect,
  isUnder,
  listFiles,
  missingAfterRestore,
  mixedChunks,
  moduleTail,
  quarantineAll,
  resolveSpecifier,
  restoreAll,
  scrubbedEnv,
  testId,
} from '../../../scripts/prove-fallback-isolation.mjs';

const SOURCE_EXT = ['.ts', '.tsx', '.mts'];

const SRC = 'src';

describe('importSpecifiers', () => {
  it('bere hodnotové, typové i dynamické importy a reexport', () => {
    const source = [
      "import { a } from './a';",
      "import type { B } from '../b';",
      "import '@/side-effect';",
      "export { c } from './c';",
      "const d = await import('./d');",
    ].join('\n');

    expect(importSpecifiers(source).sort()).toEqual([
      '../b',
      './a',
      './c',
      './d',
      '@/side-effect',
    ]);
  });

  it('typový import se nepřeskakuje — chybějící soubor rozbije typovou kontrolu stejně', () => {
    expect(importSpecifiers("import type { X } from '@/nowhere/__fixture__';")).toEqual([
      '@/nowhere/__fixture__',
    ]);
  });

  /**
   * Čtení je textové, ne přes parser, takže specifikátor uvnitř řetězcového
   * literálu se počítá jako import. Je to konzervativní směr — v nejhorším se
   * do karantény dostane nevinný soubor a skript se hlasitě zastaví — ale je
   * potřeba to vědět dopředu, jinak to vypadá jako záhada.
   */
  it('specifikátor v řetězci se počítá taky — čtení je textové', () => {
    expect(importSpecifiers('const sample = "import x from \'@/nowhere/__fixture__\'";')).toEqual([
      '@/nowhere/__fixture__',
    ]);
  });
});

describe('resolveSpecifier', () => {
  const universe = new Set([
    `${SRC}/ir/worlddoc.ts`,
    `${SRC}/kit/index.ts`,
    `${SRC}/kit/layouts/index.ts`,
    `${SRC}/kit/layouts/kiln-court.json`,
  ]);

  it('mapuje alias @/ na src/', () => {
    expect(resolveSpecifier(`${SRC}/app/page.tsx`, '@/ir/worlddoc', universe)).toBe(
      `${SRC}/ir/worlddoc.ts`,
    );
  });

  it('řeší relativní cestu vůči adresáři souboru', () => {
    expect(resolveSpecifier(`${SRC}/fallback/hud.tsx`, '../kit', universe)).toBe(
      `${SRC}/kit/index.ts`,
    );
  });

  it('dohledá index i JSON', () => {
    expect(resolveSpecifier(`${SRC}/kit/index.ts`, './layouts', universe)).toBe(
      `${SRC}/kit/layouts/index.ts`,
    );
    expect(resolveSpecifier(`${SRC}/kit/layouts/index.ts`, './kiln-court.json', universe)).toBe(
      `${SRC}/kit/layouts/kiln-court.json`,
    );
  });

  it('balíček z node_modules není cesta v repozitáři', () => {
    expect(resolveSpecifier(`${SRC}/fallback/loop.ts`, 'pure-rand/generator', universe)).toBeNull();
    expect(resolveSpecifier(`${SRC}/kit/index.ts`, 'three', universe)).toBeNull();
  });
});

describe('isUnder', () => {
  it('hranice je celý segment, ne prefix řetězce', () => {
    expect(isUnder(`${SRC}/ir/build.ts`, CORE_DIRS)).toBe(true);
    expect(isUnder(`${SRC}/ir`, CORE_DIRS)).toBe(true);
    // Adresář `irrelevant` začíná stejnými dvěma písmeny jako `ir` a jádro to
    // není. Prefixové porovnání by ho odstavilo a nikdo by si toho nevšiml.
    expect(isUnder(`${SRC}/irrelevant/thing.ts`, CORE_DIRS)).toBe(false);
    expect(isUnder(`${SRC}/simulation-notes.ts`, CORE_DIRS)).toBe(false);
  });
});

describe('coreReachSet', () => {
  it('je tranzitivní — nepřímou závislost přes třetí modul najde', () => {
    // `c` nesahá na jádro přímo; grep importů v něm by nevrátil nic.
    const graph = new Map([
      [`${SRC}/ir/build.ts`, []],
      [`${SRC}/lib/bridge.ts`, [`${SRC}/ir/build.ts`]],
      [`${SRC}/app/c.tsx`, [`${SRC}/lib/bridge.ts`]],
      [`${SRC}/fallback/router.ts`, []],
    ]);

    const reached = coreReachSet(graph, [`${SRC}/ir/build.ts`]);

    expect(reached.has(`${SRC}/lib/bridge.ts`)).toBe(true);
    expect(reached.has(`${SRC}/app/c.tsx`)).toBe(true);
    expect(reached.has(`${SRC}/fallback/router.ts`)).toBe(false);
  });

  it('nezáleží na pořadí, ve kterém graf přijde', () => {
    const edges: [string, string[]][] = [
      [`${SRC}/app/d.tsx`, [`${SRC}/app/c.tsx`]],
      [`${SRC}/app/c.tsx`, [`${SRC}/lib/bridge.ts`]],
      [`${SRC}/lib/bridge.ts`, [`${SRC}/sim/interpreter.ts`]],
      [`${SRC}/sim/interpreter.ts`, []],
    ];

    const forward = coreReachSet(new Map(edges), [`${SRC}/sim/interpreter.ts`]);
    const backward = coreReachSet(new Map([...edges].reverse()), [`${SRC}/sim/interpreter.ts`]);

    expect([...forward].sort()).toEqual([...backward].sort());
    expect(forward.has(`${SRC}/app/d.tsx`)).toBe(true);
  });
});

describe('globální deklarace', () => {
  const stage = [
    'declare global {',
    '  interface Window {',
    '    __probeHook?: {',
    '      webgl2: boolean;',
    '      renderer: string;',
    '    };',
    '  }',
    '}',
  ].join('\n');

  it('bere jen první úroveň augmentovaného rozhraní', () => {
    // `renderer` a `webgl2` jsou tvar té hodnoty, ne globální jméno. Kdyby se
    // braly, odstavil by se každý soubor, který to slovo někde napíše — a
    // `renderer` stojí i v komentáři souboru, který zůstat musí.
    expect(globalMembers(stage)).toEqual(['__probeHook']);
  });

  it('soubor bez declare global nemá co přidat', () => {
    expect(globalMembers('export const x = 1; // { a: 1 }')).toEqual([]);
  });

  it('odstaví soubor, který na odstavené globální jméno sahá bez importu', () => {
    const sources: Record<string, string> = {
      [`${SRC}/core/stage.tsx`]: stage,
      'e2e/reaches.spec.ts': 'await page.waitForFunction(() => window.__probeHook !== undefined);',
      'e2e/independent.spec.ts': 'await page.waitForFunction(() => window.__otherHook?.ready);',
    };

    const expanded = expandByAmbientGlobals(
      new Set([`${SRC}/core/stage.tsx`]),
      Object.keys(sources),
      (file) => sources[file],
    );

    expect(expanded.has('e2e/reaches.spec.ts')).toBe(true);
    expect(expanded.has('e2e/independent.spec.ts')).toBe(false);
  });
});

describe('analyzerModules', () => {
  const report = [
    {
      label: 'static/chunks/app/fallback/play/page.js',
      groups: [
        {
          label: 'src',
          groups: [
            {
              label: 'fallback',
              // `parsedSize: 0` je přesně to, co analyzer vypisuje u slepených
              // modulů. Nesmí vyhrát nad `statSize`, jinak se naměří skoro nula
              // a bude to vypadat jako výsledek.
              groups: [{ path: `./${SRC}/fallback/router.ts`, statSize: 4000, parsedSize: 0 }],
            },
            { path: `./${SRC}/kit/index.ts`, statSize: 1500, parsedSize: 0 },
          ],
        },
        { path: './node_modules/three/build/three.module.js', statSize: 600000 },
      ],
    },
  ];

  it('sestoupí až k listům, ne jen k první úrovni', () => {
    expect(analyzerModules(report).map((module) => module.path)).toEqual([
      `${SRC}/fallback/router.ts`,
      `${SRC}/kit/index.ts`,
      'node_modules/three/build/three.module.js',
    ]);
  });

  it('nese chunk, ve kterém modul leží', () => {
    expect(analyzerModules(report)[0].chunk).toBe('static/chunks/app/fallback/play/page.js');
  });

  it('modul jádra v bundlu se pozná', () => {
    const contaminated = analyzerModules([
      { label: 'chunk.js', groups: [{ path: `./${SRC}/verify/witness.ts`, statSize: 900 }] },
    ]);
    expect(coreModulesIn(contaminated)).toHaveLength(1);
    expect(coreModulesIn(analyzerModules(report))).toEqual([]);
  });

  it('modul jádra schovaný ve slepenci se pozná taky', () => {
    // Scope hoisting slepí moduly a vypíše je pod cestou toho prvního. Cesta
    // pak začíná fallbackem a končí jádrem — a rozhoduje ten konec.
    const hoisted = analyzerModules([
      {
        label: 'chunk.js',
        groups: [
          {
            path: `./${SRC}/kit/index.ts + 17 modules (concatenated)/${SRC}/ir/worlddoc.ts`,
            statSize: 900,
          },
        ],
      },
    ]);
    expect(coreModulesIn(hoisted).map((module) => module.path)).toEqual([
      `${SRC}/ir/worlddoc.ts`,
    ]);
  });

  it('cesta ze slepence se zkrátí na skutečný modul', () => {
    expect(
      moduleTail(`${SRC}/kit/index.ts + 17 modules (concatenated)/${SRC}/kit/palettes.ts`),
    ).toBe(`${SRC}/kit/palettes.ts`);
    expect(moduleTail(`${SRC}/fallback/router.ts`)).toBe(`${SRC}/fallback/router.ts`);
  });

  it('sdílený chunk fallbacku a jádra se pozná', () => {
    // Kontrola nad úplným buildem: tam jádro existuje, takže tohle je jediná
    // část analýzy, která umí selhat. Nad izolovaným buildem je pravdivá
    // konstrukcí, protože jádro se před ním smazalo.
    const shared = analyzerModules([
      {
        label: 'chunk-shared.js',
        groups: [
          { path: `./${SRC}/kit/index.ts`, statSize: 10 },
          { path: `./${SRC}/sim/interpreter.ts`, statSize: 20 },
        ],
      },
      { label: 'chunk-clean.js', groups: [{ path: `./${SRC}/fallback/loop.ts`, statSize: 30 }] },
      { label: 'chunk-core.js', groups: [{ path: `./${SRC}/ir/build.ts`, statSize: 40 }] },
    ]);

    expect(mixedChunks(shared)).toEqual([
      { chunk: 'chunk-shared.js', core: [`${SRC}/sim/interpreter.ts`] },
    ]);
    expect(mixedChunks(analyzerModules(report))).toEqual([]);
  });

  it('měří jen fallback a kit, ne celý chunk', () => {
    expect(fallbackBytes(analyzerModules(report))).toEqual({
      moduleCount: 2,
      statBytes: 5500,
      totalStatBytes: 605500,
    });
  });
});

describe('scrubbedEnv', () => {
  it('propustí jen to, co je na seznamu', () => {
    const scrubbed = scrubbedEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-live',
      HTTPS_PROXY: 'http://corp',
      NODE_ENV: 'production',
    });

    expect(Object.keys(scrubbed).sort()).toEqual(['NEXT_TELEMETRY_DISABLED', 'NODE_ENV', 'PATH']);
  });

  it('zadrží i jména, na která žádný vzor typu key|token|secret nesedí', () => {
    // Tohle je důvod, proč je to allowlist. Blocklist propustil všech pět a
    // test nad ním se nedal napsat tak, aby uměl selhat — krmil se jmény, která
    // ten vzor už obsahoval.
    const scrubbed = scrubbedEnv({
      AWS_ACCESS_KEY_ID: 'AKIA',
      DATABASE_URL: 'postgres://user:pw@host/db',
      SENTRY_DSN: 'https://x@sentry.io/1',
      KUBECONFIG: '/home/x/.kube/config',
      NPM_CONFIG_REGISTRY: 'https://registry.internal',
    });

    expect(Object.keys(scrubbed)).toEqual(['NEXT_TELEMETRY_DISABLED']);
  });

  it('jméno proměnné je na Windows case-insensitive', () => {
    expect(scrubbedEnv({ Path: '/usr/bin' }).Path).toBe('/usr/bin');
  });
});

/**
 * Guard se do běžícího artefaktu vkládá zdrojem téhle funkce, takže co projde
 * tady, projde i tam. Naivní verze **nechytala nic** a vypadala při běhu
 * identicky: žádný smoke případ ven nesahá, takže by prošla bez povšimnutí.
 */
describe('isLocalConnect', () => {
  it('normalizované pole je to, co Socket.prototype.connect doopravdy dostane', () => {
    // `net.connect({host, port})` i `net.createConnection(port, host)` volají
    // connect s polem, ne s options. Čtení `args[0].host` na něm dá `undefined`
    // a naivní verze to přečetla jako localhost — tudy chodí `fetch` z undici.
    expect(isLocalConnect([[{ host: 'example.com', port: 80 }]])).toBe(false);
    expect(isLocalConnect([[{ host: '127.0.0.1', port: 3000 }]])).toBe(true);
  });

  it('options objektem i pozičně', () => {
    expect(isLocalConnect([{ host: 'example.com', port: 443 }])).toBe(false);
    expect(isLocalConnect([80, 'example.com'])).toBe(false);
    expect(isLocalConnect([80, '127.0.0.1'])).toBe(true);
  });

  it('chybějící host je localhost, ne neznámo kam', () => {
    expect(isLocalConnect([[{ port: 3000 }]])).toBe(true);
  });

  it('path je unixový socket jen bez portu — HTTP klient si nese cestu URL', () => {
    expect(isLocalConnect([[{ path: '/var/run/x.sock' }]])).toBe(true);
    expect(isLocalConnect([[{ host: 'example.com', port: 80, path: '/' }]])).toBe(false);
  });
});

describe('testId', () => {
  it('přečte hodnotu i přes komentářové uzly Reactu', () => {
    const html = '<b data-testid="route-kind">arche<!-- -->type</b>';
    expect(testId(html, 'route-kind')).toBe('archetype');
  });

  it('chybějící značka není prázdný řetězec', () => {
    expect(testId('<b data-testid="jine">x</b>', 'route-kind')).toBeNull();
  });
});

/**
 * Destruktivní půlka skriptu, nad skutečnými soubory v dočasném adresáři.
 * Odstavené soubory nemají jinou kopii, takže „obnova proběhla" nesmí být
 * tvrzení, které nikdo neměřil.
 */
describe('karanténa a obnova', () => {
  const scratch = () => {
    const root = mkdtempSync(join(tmpdir(), 'isolation-test-'));
    mkdirSync(join(root, 'tree', 'nested'), { recursive: true });
    writeFileSync(join(root, 'tree', 'a.ts'), 'a', 'utf-8');
    writeFileSync(join(root, 'tree', 'nested', 'b.ts'), 'b', 'utf-8');
    return { root: join(root, 'tree'), quarantine: join(root, 'quarantine') };
  };

  it('vrátí soubory i z podadresářů', () => {
    const { root, quarantine } = scratch();
    const moved: string[] = [];

    quarantineAll(root, quarantine, ['a.ts', 'nested/b.ts'], moved);
    expect(existsSync(join(root, 'a.ts'))).toBe(false);
    expect(existsSync(join(root, 'nested/b.ts'))).toBe(false);

    restoreAll(root, quarantine, moved);
    expect(missingAfterRestore(root, moved)).toEqual([]);
    expect(readFileSync(join(root, 'nested/b.ts'), 'utf-8')).toBe('b');
  });

  it('když přesun spadne uprostřed, volající drží přesně to, co je odstavené', () => {
    const { root, quarantine } = scratch();
    const moved: string[] = [];

    // Prostřední soubor neexistuje — `renameSync` na něm hodí ENOENT přesně
    // tak, jako by na Windows hodil EPERM nad souborem drženým editorem.
    expect(() =>
      quarantineAll(root, quarantine, ['a.ts', 'chybi.ts', 'nested/b.ts'], moved),
    ).toThrow();
    expect(moved).toEqual(['a.ts']);

    restoreAll(root, quarantine, moved);
    expect(missingAfterRestore(root, moved)).toEqual([]);
    // A ten, na který smyčka nedošla, zůstal na místě netknutý.
    expect(existsSync(join(root, 'nested/b.ts'))).toBe(true);
  });

  it('neobnovený soubor se ohlásí, i když ho git nikdy neviděl', () => {
    const { root, quarantine } = scratch();
    const moved: string[] = [];

    quarantineAll(root, quarantine, ['a.ts', 'nested/b.ts'], moved);
    restoreAll(root, quarantine, ['a.ts']);

    expect(missingAfterRestore(root, moved)).toEqual(['nested/b.ts']);
  });
});

describe('skutečný strom repozitáře', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8');
  const universe = new Set(listFiles(''));
  const sourceFiles = [...universe].filter((file) => SOURCE_EXT.some((ext) => file.endsWith(ext)));
  const graph = buildImportGraph(sourceFiles, universe, read);
  const reach = expandByAmbientGlobals(
    coreReachSet(
      graph,
      [...universe].filter((file) => isUnder(file, CORE_DIRS)),
    ),
    sourceFiles,
    read,
  );

  it('obal jádra je netriviální — jinak by test neměřil nic', () => {
    expect(reach.has(`${SRC}/components/Stage.tsx`)).toBe(true);
    expect(reach.has(`${SRC}/app/api/emit/route.ts`)).toBe(true);
    // Nepřímý případ: stránka studia na jádro nesahá, sahá na `Stage.tsx`
    // (od P25B T7 bydlí na `/studio`, kořen jen přesměruje na `/play`).
    expect(reach.has(`${SRC}/app/studio/page.tsx`)).toBe(true);
    // A případ, na který import graf sám nestačí: `smoke.spec.ts` z jádra
    // neimportuje nic, sahá na globál, který deklaruje `Stage.tsx`. Jméno toho
    // globálu se sem napsat nesmí — viz poznámka v hlavičce.
    expect(reach.has('e2e/smoke.spec.ts')).toBe(true);
  });

  it('fallback ani kit v obalu jádra nejsou', () => {
    expect([...reach].filter((file) => isUnder(file, PROTECTED_DIRS))).toEqual([]);
  });

  it('routa, která fallback vystavuje, existuje a v obalu jádra není', () => {
    expect(universe.has(`${SRC}/app/fallback/play/page.tsx`)).toBe(true);
    expect(reach.has(`${SRC}/app/fallback/play/page.tsx`)).toBe(false);
    expect(reach.has(`${SRC}/app/fallback/play/PlayView.tsx`)).toBe(false);
  });
});
