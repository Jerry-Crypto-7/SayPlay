import { expect, test, type Page } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * Oracle úlohy T18 — **model napíše postavě povahu, interpret ji odchodí**.
 *
 * Test se neptá, co model napsal, ani co panel vypíše. Ptá se na jedinou věc,
 * kterou o mysli jde poznat zvenčí: **kudy postava za sto tiků chodila**. Zóny
 * se čtou z běhu v prohlížeči přes `window.__timeline.visited`, tedy z týchž
 * odvozených faktů (`inZone`), na kterých stojí pravidla — ne z pozice pixelů
 * a ne z čísla, které by si stránka mohla napsat sama.
 *
 * ## Proč zrovna tyhle dvě věty
 *
 * Liší se **jedním přídavným jménem**. Kdyby se lišily světem — jiná místnost,
 * jiné zastávky — byl by rozdíl v trasách vysvětlitelný geografií a o povaze by
 * nedokazoval nic. Takhle je svět bajt po bajtu týž a mění se jediný symbol
 * v paměti postavy.
 *
 * Ani jedna věta **není ve zmrazeném korpusu**, a to je záměr: offline generátor
 * hledá doslovnou shodu, takže obě skončí `NO_SOURCE` a obslouží je
 * deterministický rozpoznávač tvarů z T7 běžící v prohlížeči. Testuje se tím
 * cesta, kterou pojede porotce s vlastní větou, ne cesta přes zaznamenanou
 * odpověď.
 *
 * ## Proč každá věta ve vlastním načtení stránky
 *
 * Druhá věta staví druhý svět a `window.__timeline` se přepisuje až v efektu po
 * překreslení. Číst obojí v jednom načtení znamená závodit s Reactem o to, který
 * běh zrovna visí na `window` — a prohrát ten závod vypadá jako „obě povahy
 * chodí stejně", tedy přesně jako nález, který test hledá.
 */

/** Kolik tiků se pozoruje. Táž mez, jakou měří `src/sim/__tests__/agents.test.ts`. */
const HORIZON = 100;

/** Postava, které rozpoznávač píše mysl. Jméno je v `shapes.ts`, ne vymyšlené tady. */
const CHARACTER = 'watcher';

const BOLD = 'a bold guard who patrols the whole corridor without stopping';
const WARY = 'a wary guard who never strays far from his post';

async function routeOf(page: Page, sentence: string): Promise<readonly string[]> {
  await page.goto('/classic');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // **Bez tohohle je `window.__timeline` navždy `undefined`.** Publikuje ho
  // panel `Timeline`, a ten od P13 vlny 0 T1 ve výchozím DOM nestojí — zavřená
  // zásuvka ho doopravdy odpojí. Sada tím ležela červená a nikdo si toho
  // nevšiml, protože T1 se ověřovala jinými soubory; je to podruhé, co přestavba
  // rozvržení potichu shodila sadu, která na panel sahá.
  //
  // Otevírá se **před** napsáním věty, ne po ní: `e2e/inspect.ts` to u
  // `window.__pipeline` vysvětluje týmž důvodem a pro `__timeline` platí totéž.
  await openInspect(page);

  await page.getByTestId('prompt-input').fill(sentence);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__timeline !== undefined, undefined, { timeout: 60_000 });

  return page.evaluate(
    ({ entity, ticks }) => window.__timeline!.visited(entity, ticks),
    { entity: CHARACTER, ticks: HORIZON },
  );
}

test('dvě věty o téže hlídce dají dvě různé trasy', async ({ page }) => {
  test.setTimeout(180_000);

  const bold = await routeOf(page, BOLD);
  const wary = await routeOf(page, WARY);

  // Obě postavy se doopravdy hýbou. Bez tohohle by prošly i dvě nehybné sochy,
  // pokud by se náhodou lišila výchozí zóna.
  expect(bold.length).toBeGreaterThan(1);
  expect(wary.length).toBeGreaterThan(1);

  // Jádro AC: jiná povaha, jiné navštívené zóny.
  expect(bold).not.toEqual(wary);

  // A rozdíl je ten, který povaha slibuje — `bold` projde trasu celou, `wary` se
  // drží u své první zastávky. Kdyby se testovala jen nerovnost, prošla by ji
  // i implementace, která povahu čte a chová se podle ní náhodně.
  expect(bold).toContain('alcove');
  expect(wary).not.toContain('alcove');
  expect(wary).toContain('post');
});

test('mysl neběží na dynamicky vyhodnoceném kódu — svět se postaví z deklarace', async ({ page }) => {
  test.setTimeout(120_000);

  // **CSP si nasazuje tenhle test, produkce žádné nemá** — naměřeno 30. 8. 2026
  // jako nález `T1-cspclaim`: `next.config.mjs` nemá `headers()`, `middleware.ts`
  // v repu není a `vercel.json` nese jen framework a region. Do té doby tady
  // stála věta „stránka běží pod produkčním CSP bez `unsafe-eval`", což pravda
  // nebyla — takže druhá polovina té věty („spadlo by to sem") nehlídala nic:
  // `pageerror` chytá pády, ale `eval` nikdo nezakazoval.
  //
  // Hlavička se proto vkládá do odpovědi na dokument. Tvrzení tím není
  // „produkce běží pod CSP" (neběží), ale to slabší a pravdivé: **mysl by pod
  // CSP bez `unsafe-eval` fungovala dál**. Rozhodnutí, jestli se CSP nasadí, je
  // součást deploye a patří uživateli; až padne, tenhle blok se smaže a bude
  // platit ta silnější věta.
  //
  // `unsafe-inline` zůstává povolený schválně: Next posílá hydratační data
  // inline skriptem, takže bez něj by stránka nevznikla vůbec a test by padal
  // na Nextu, ne na mysli. Zakázané je právě a jenom dynamické vyhodnocení.
  //
  // **Zachytává se jen dokument.** `route.fallback()` pustí zbytek beze změny;
  // původní verze protahovala přes `route.fetch()` každý požadavek a padala na
  // `Fetch response has been disposed`, jakmile něco dojelo po konci testu.
  await page.route('**/*', async (route, request) => {
    if (request.resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
      },
    });
  });

  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(String(error)));

  // Druhá síť: porušení CSP se neohlásí jako `pageerror`, ale jako zpráva
  // konzole. **Zabíjí ale ta první** — naměřeno mutací níž.
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('Content Security Policy')) violations.push(text);
  });

  // ## Jak se ověřilo, že tahle brána doopravdy kouše (30. 8. 2026)
  //
  // **`new Function('return 1')` vložené do `expandAgentMinds`** — tedy do
  // cesty, kterou tenhle test jede — sadu **zčervenalo**: svět se nepostavil
  // a čekání na entity vypršelo. **Kontrola k tomu:** týž mutant pod testem
  // „dvě věty o téže hlídce", který CSP nevkládá, **prošel**. Rozdíl mezi
  // těmi dvěma běhy je jen ta hlavička, takže zabíjí ona, ne mutant sám.
  //
  // **Co naopak nezkoušet, protože je to změřené a nefunguje to:** `eval`
  // vložený přes `page.addInitScript` nebo `page.evaluate`. Naměřeno — vrátí
  // `2` a CSP se neozve, protože kód vstříknutý Playwrightem přes CDP
  // politice stránky nepodléhá. Tuhle bránu umí zkoušet jen kód aplikace.

  const route = await routeOf(page, BOLD);

  expect(violations).toEqual([]);
  expect(failures).toEqual([]);
  expect(route.length).toBeGreaterThan(1);
});
