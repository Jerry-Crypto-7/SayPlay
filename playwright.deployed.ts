import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test proti **skutečné veřejné adrese** (P11 T26).
 *
 * Oddělená konfigurace, ne přepínač v té hlavní, a je to schválně: hlavní
 * `playwright.config.ts` si při chybějícím cíli postaví a spustí lokální server.
 * To je u ní správně, ale tady by to byla nejhorší možná vada — běh by tiše
 * certifikoval `localhost` místo nasazení a nikdo by se nedozvěděl, že se na
 * veřejnou adresu vůbec nešáhlo.
 *
 * Proto se tu **nestartuje žádný server** a chybějící adresa je tvrdá chyba, ne
 * výchozí hodnota. Táž doktrína jako u rozbitého vypínače stropu: vadné
 * nastavení nikdy neznamená tichý průchod.
 */
const target = process.env.WORLDSMITH_DEPLOYED_URL;

if (target === undefined || target.length === 0)
  throw new Error(
    'WORLDSMITH_DEPLOYED_URL není nastavená. Tahle konfigurace testuje nasazenou adresu a ' +
      'nemá se na co ptát — lokální server si schválně nestartuje, aby nemohla projít ' +
      'proti localhostu. Použij `npx playwright test --config=playwright.config.ts` pro lokální běh.',
  );

export default defineConfig({
  testDir: './e2e',
  testMatch: /deployed-smoke\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Nasazení je za sítí, ne na téhle mašině. Jedno zopakování pokryje výpadek
  // spojení, aniž by zakrylo skutečně rozbité nasazení — to spadne i podruhé.
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: target,
    trace: 'off',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
