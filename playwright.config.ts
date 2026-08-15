import { defineConfig, devices } from '@playwright/test';

/**
 * Testuje se PRODUKČNÍ build, ne `next dev`. AC úlohy T4 mluví o `npm run build`
 * a o živém WebGL2 kontextu; dev server má jiný modulový graf a jiné chování
 * dynamic importů, takže by ověřoval něco jiného, než co se nasadí.
 *
 * SwiftShader je tu vědomý kompromis: headless Chromium nemá GPU, ale
 * `WebGL2RenderingContext` přes ANGLE/SwiftShader je pořád skutečný WebGL2
 * kontext. TOOLING.md §1 na to upozorňuje u screenshot diffů — proto se tady
 * NEporovnává obraz, jen se ptá runtimu, co doopravdy dostal.
 */
/**
 * Cíl smoke testu uzamčeného fallbacku (P2 T205a/T205b).
 *
 * Když je nastavený, běží se proti **už běžícímu** artefaktu — lokálnímu, který
 * postavil `scripts/build-from-tag.mjs`, nebo v T205b proti nasazené URL. V obou
 * případech by `webServer` níž postavil a spustil něco jiného, tedy přesně toho
 * druhého artefakta, o kterém se nemá nic tvrdit.
 */
const target = process.env.FALLBACK_SMOKE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: target ?? 'http://127.0.0.1:3100',
    trace: 'off',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: target
    ? undefined
    : {
        // **Build je součást příkazu, ne předpoklad.** `next start` sám servíruje
        // to, co zrovna leží v `.next/`, takže bez tohohle uměl zelený e2E běh
        // certifikovat bundle z dřívějšího commitu — a oracle by pak měřil jiný kód,
        // než jaký se právě commituje. Deklarované prostředí úloh je `next build &&
        // next start`; tady se to vynucuje, ne jen popisuje.
        command: 'npm run build && npx next start --port 3100 --hostname 127.0.0.1',
        url: 'http://127.0.0.1:3100',
        reuseExistingServer: false,
        // Build je teď uvnitř příkazu, takže strop musí pokrýt build i start.
        timeout: 240_000,
      },
});
