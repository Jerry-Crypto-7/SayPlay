import { test } from '@playwright/test';

/**
 * Díra na telefonu i na desktopu (P66 T6). Kostra z T2: řádek v `playwright.config.ts` (`chromium`,
 * `pixel7-touch`) je hotový; hru z ručního specu `e2e/fixtures/p66-hole-spec.json`, tah díry prstem i šipkami
 * a kartu výhry nebo prohry napíše úloha žánru.
 */
test.skip('hole: the game opens, plays to a win or a loss by touch and keys (P66 T6)', () => {});
