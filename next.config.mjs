/**
 * Svědek kroku 2b z P2 T205a: build zapíše množinu proměnných, kterou
 * SKUTEČNĚ viděl.
 *
 * Pozorovací bod je schválně **uvnitř zapečetěného stromu**. Kdyby ho vkládala
 * pipeline zvenčí (třeba `NODE_OPTIONS --import`), tvrzení „build vidí jen
 * proměnné z allowlistu" by dokazoval kód, na který se ten allowlist nevztahuje
 * — a zároveň by to byl další vstup buildu mimo tag, tedy přesně ta třída díry,
 * kterou kolo 4 review našlo u `BUILD_VARIANT`.
 */
if (process.env.WORLDSMITH_ENV_REPORT) {
  // **Připisuje se, nepřepisuje.** `next build` si načte tenhle soubor v hlavním
  // procesu i v každém workeru a přepis by nechal vidět jen posledního z nich,
  // tedy náhodného. Otázka zní „co všechno build viděl", takže odpovědí je
  // sjednocení, ne poslední zapisovatel.
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.WORLDSMITH_ENV_REPORT, `${Object.keys(process.env).join('\n')}\n`, 'utf-8');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Hash stromu, ze kterého artefakt vznikl. Next ho přes `env` zapéká do
  // bundlu, takže `GET /api/build-id` ho vrací i bez proměnné za běhu — a to je
  // podmínka T205b: nasazuje se artefakt beze změny, ne artefakt plus nastavení.
  // Bez pipeline (běžný `next build` z pracovního stromu) je hodnota `unbuilt`,
  // což je poctivější než prázdný řetězec: nedá se splést s hashem.
  // `PLAY_MUSIC=off` při buildu vypne hudbu her (P29D T5); zvuky zůstanou.
  env: { WORLDSMITH_BUILD_TREE: process.env.WORLDSMITH_BUILD_TREE ?? 'unbuilt', PLAY_MUSIC: process.env.PLAY_MUSIC ?? 'on' },
  // Bez tohohle si Next vygeneruje náhodné `BUILD_ID` při každém buildu, takže
  // by dva buildy z téhož archivu nikdy nedaly shodný `sha256` — a krok 4
  // T205a (reprodukovatelnost) by neměřil vstupy buildu, jen náhodný řetězec.
  // Odvození z hashe stromu je zároveň to, co chce T205b: cesty ke statickým
  // assetům nesou identitu artefaktu.
  generateBuildId: () => process.env.WORLDSMITH_BUILD_TREE ?? 'unbuilt',
  // Bundler je webpack. TOOLING.md past #4: serwist má pro každý z těch dvou
  // bundlerů jinou cestu a rozhodnout se musí PŘED prvním commitem, ne v týdnu 8.
  // Webpack drží `withSerwist` z @serwist/next, což je ta jednodušší z nich.
  // AC úlohy T4 to hlídá grepem, takže se ten druhý název v tomhle souboru
  // nesmí objevit ani v komentáři — a při prvním psaní se objevil.
  transpilePackages: ['three'],
  // QuickJS (P68I T13): server ho načítá z `node_modules` (varianta si `emscripten-module.wasm` čte vedle sebe),
  // nebalí ho. Prohlížeč (jen `/play/lab/scripts`) dostane `.wasm` jako asset webpacku.
  serverExternalPackages: ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'],
  // Vlákno skriptu úrovně (P68 R4, `src/play/scripts/isolated.ts`): webpack ho zabalí jako vlastní soubor
  // `chunks/script-worker.js`, sledování souborů funkce ho ale samo nevidí (bez něj by na platformě každý skript
  // skončil chybou a AI verze vždy bez skriptu).
  outputFileTracingIncludes: { '/api/play/**': ['./.next/server/chunks/script-worker.js'] },
  webpack: (config, { isServer, nextRuntime }) => {
    // Výchozí cesta vlákna je veřejná cesta prohlížeče `/_next/`; na serveru leží vedle ostatních chunků.
    if (isServer && nextRuntime === 'nodejs') config.output.workerPublicPath = './';
    return config;
  },
};

// Analyzer je devDependency, takže se importuje jen když se opravdu analyzuje.
// Kdyby byl importovaný natvrdo, `next start` nad stromem s prořezanými
// devDependencies by spadl na chybějícím modulu — a to je přesně ten strom,
// který T205 nasazuje.
//
// `analyzerMode: 'json'` místo výchozího HTML: `scripts/prove-fallback-isolation.mjs`
// nad tím reportem tvrdí, že v žádném chunku není modul jádra, a to potřebuje
// strojově čitelný seznam modulů, ne obrázek.
let withAnalyzer = (config) => config;

if (process.env.ANALYZE === 'true') {
  const analyzer = await import('@next/bundle-analyzer');
  withAnalyzer = analyzer.default({
    enabled: true,
    analyzerMode: 'json',
    openAnalyzer: false,
    logLevel: 'warn',
  });
}

export default withAnalyzer(nextConfig);
