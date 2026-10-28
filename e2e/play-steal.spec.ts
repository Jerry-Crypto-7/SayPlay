import { test } from '@playwright/test';

/**
 * Krádež na telefonu i na desktopu (P66 T7). Kostra z T2: řádek v `playwright.config.ts` (`chromium`,
 * `pixel7-touch`) je hotový; hru z ručního specu `e2e/fixtures/p66-steal-spec.json`, gesta i klávesnici
 * a kartu výhry nebo prohry napíše úloha žánru.
 */
test.skip('steal: the game opens, plays to a win or a loss by touch and keys (P66 T7)', () => {});
