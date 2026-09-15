import { defineConfig, devices } from '@playwright/test';

import { deployedTarget } from './e2e/smoke-target';
import { browserRenderer } from './scripts/browser-renderer';

/**
 * Testuje se PRODUKČNÍ build, ne `next dev`. AC úlohy T4 mluví o `npm run build`
 * a o živém WebGL2 kontextu; dev server má jiný modulový graf a jiné chování
 * dynamic importů, takže by ověřoval něco jiného, než co se nasadí.
 *
 * Lokální Windows běh používá skutečné GPU přes ANGLE/D3D11. CI a explicitní
 * E2E_RENDERER=software zachovávají historický SwiftShader. Renderer se
 * ověřuje samostatným testem; časy těchto prostředí se neslučují.
 */
/**
 * Cíl smoke testu uzamčeného fallbacku (P2 T205a/T205b).
 *
 * Když je nastavený, běží se proti **už běžícímu** artefaktu — lokálnímu, který
 * postavil `scripts/build-from-tag.mjs`, nebo v T205b proti nasazené URL. V obou
 * případech by `webServer` níž postavil a spustil něco jiného, tedy přesně toho
 * druhého artefakta, o kterém se nemá nic tvrdit.
 */
// Prázdná proměnná znamená **nenastaveno** — rozhoduje o tom `deployedTarget()`,
// aby se config a spec, který se podle téhož zařizuje, nemohly rozejít.
const target = deployedTarget();

/**
 * Port, na kterém běží testovaný artefakt. **Naměřeno 21. 8. 2026:** 3100 na
 * tomhle stroji drží vývojový server jiného projektu, a celá sada se pak
 * zastaví na `http://127.0.0.1:3100 is already used` — nenulově a pravdivě, ale
 * pustit ji nejde vůbec, dokud cizí server běží. Cizí server se nezabíjí, je to
 * cizí práce; jediné, co chybělo, byl způsob, jak se mu vyhnout.
 *
 * Výchozí hodnota zůstává 3100, aby se `npm run test:e2e` ani CI nemusely měnit.
 * Port se čte na **jednom** místě a rozvádí se do adresy i do příkazu serveru:
 * dvě čísla by se rozešla a sada by pak startovala server jinde, než kam se
 * dívá — což je přesně to tiché selhání, kvůli kterému tenhle blok vznikl.
 */
const PORT = process.env.E2E_PORT ?? '3100';

const LOCAL_URL = `http://127.0.0.1:${PORT}`;

// Local Windows graphics use the real GPU. CI retains its explicit software
// renderer; E2E_RENDERER=software reproduces historical SwiftShader runs.
const { args: renderArgs } = browserRenderer();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: target ?? LOCAL_URL,
    trace: 'off',
    launchOptions: {
      args: renderArgs,
    },
  },
  projects: [
    // `webgpu-detect` sem nepatří: běží výhradně v projektu bez akcelerace níž,
    // jinak by tentýž soubor jednou tvrdil „WebGPU tu není" v prostředí, kde je.
    // `deployed-smoke` sem nepatří ze stejného důvodu jako `webgpu-detect`: běží
    // výhradně proti nasazené adrese přes `playwright.deployed.ts`. Tady by mířil
    // na lokální server a certifikoval by `localhost` místo nasazení.
    {
      name: 'chromium',
      testIgnore: /(webgpu-detect|deployed-smoke)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    /**
     * Stroj bez akcelerace (P11 T4). Nedědí `launchOptions` z `use` výš — ty
     * SwiftShader naopak zapínají — a přidává `--disable-gpu`, takže WebGPU
     * v prohlížeči není.
     *
     * Je to jediné prostředí, ve kterém jde dokázat, že se **nestáhne jediný
     * bajt vah**, když je stroj nemá čím spustit. Testy pro něj jsou omezené
     * na `webgpu-detect`, protože zbytek sady WebGL2 kontext potřebuje a tady
     * ho nedostane.
     */
    {
      name: 'no-acceleration',
      testMatch: /(webgpu-detect|model-wired)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--disable-gpu', '--disable-features=WebGPU,Vulkan'] },
      },
    },
  ],
  webServer: target
    ? undefined
    : {
        // **Build je součást příkazu, ne předpoklad.** `next start` sám servíruje
        // to, co zrovna leží v `.next/`, takže bez tohohle uměl zelený e2E běh
        // certifikovat bundle z dřívějšího commitu — a oracle by pak měřil jiný kód,
        // než jaký se právě commituje. Deklarované prostředí úloh je `next build &&
        // next start`; tady se to vynucuje, ne jen popisuje.
        command: `npm run build && npx next start --port ${PORT} --hostname 127.0.0.1`,
        url: LOCAL_URL,
        reuseExistingServer: false,
        // Build je teď uvnitř příkazu, takže strop musí pokrýt build i start.
        timeout: 240_000,
      },
});
