/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bundler je webpack. TOOLING.md past #4: serwist má pro každý z těch dvou
  // bundlerů jinou cestu a rozhodnout se musí PŘED prvním commitem, ne v týdnu 8.
  // Webpack drží `withSerwist` z @serwist/next, což je ta jednodušší z nich.
  // AC úlohy T4 to hlídá grepem, takže se ten druhý název v tomhle souboru
  // nesmí objevit ani v komentáři — a při prvním psaní se objevil.
  transpilePackages: ['three'],
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
