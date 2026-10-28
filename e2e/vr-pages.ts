import { type Page, expect, test as base } from '@playwright/test';

/**
 * Stránky VR e2e, které se po testu zavřou (P65 T6c). `browser.newPage()` dává každé stránce vlastní kontext a ten
 * po testu nikdo nezavře: stránka s relací IWER dál kreslí obě oči. Naměřeno 28. 10. v jednom běhu `play-movements`
 * + `vr-*` (jeden worker): po každém testu dioramy a VR-nativních žánrů zůstal další renderer, který dál bral
 * ~25 % jádra (12 → 23 procesů), a o procesor i GPU se s ním dělily všechny další testy. Stránka z `openPage()`
 * se zavře na konci testu, i když test spadne.
 */
export const test = base.extend<{ openPage: () => Promise<Page> }>({
  openPage: async ({ browser }, use) => {
    const pages: Page[] = [];
    await use(async () => {
      const page = await browser.newPage();
      pages.push(page);
      return page;
    });
    await Promise.all(pages.map((page) => page.close()));
  },
});

export { expect };
