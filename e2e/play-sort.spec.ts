import { test } from '@playwright/test';

/**
 * Třídění na telefonu i na desktopu (P66 T8). Kostra z T2: řádek v `playwright.config.ts` (`chromium`,
 * `pixel7-touch`) je hotový; hru z ručního specu `e2e/fixtures/p66-sort-spec.json`, klepnutí do front i klávesy
 * a kartu výhry nebo prohry napíše úloha žánru.
 */
test.skip('sort: the game opens, plays to a win or a loss by taps and keys (P66 T8)', () => {});
