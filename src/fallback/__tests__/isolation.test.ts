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

import { readFileSync } from 'node:fs';
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
  isUnder,
  listFiles,
  moduleTail,
  resolveSpecifier,
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

  it('měří jen fallback a kit, ne celý chunk', () => {
    expect(fallbackBytes(analyzerModules(report))).toEqual({
      moduleCount: 2,
      statBytes: 5500,
      totalStatBytes: 605500,
    });
  });
});

describe('scrubbedEnv', () => {
  it('vyhodí všechno, co vypadá jako přístup k vzdálenému API', () => {
    const scrubbed = scrubbedEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-live',
      GITHUB_TOKEN: 'ghp',
      MY_SECRET: 'x',
      HTTPS_PROXY: 'http://corp',
      SIGNING_KEY: 'k',
      NODE_ENV: 'production',
    });

    expect(Object.keys(scrubbed).sort()).toEqual(['NEXT_TELEMETRY_DISABLED', 'NODE_ENV', 'PATH']);
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
    // Nepřímý případ: kořenová `page.tsx` na jádro nesahá, sahá na `Stage.tsx`.
    expect(reach.has(`${SRC}/app/page.tsx`)).toBe(true);
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
