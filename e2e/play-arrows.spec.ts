import { test } from '@playwright/test';

/**
 * Šipky na telefonu i na desktopu (P66 T9). Kostra z T2: řádek v `playwright.config.ts` (`chromium`,
 * `pixel7-touch`) je hotový; hru z ručního specu `e2e/fixtures/p66-arrows-spec.json`, ťuk do buňky
 * (`data-lane-cells`) i klávesy a kartu výhry nebo prohry napíše úloha žánru.
 */
test.skip('arrows: the game opens, plays to a win or a loss by taps and keys (P66 T9)', () => {});
