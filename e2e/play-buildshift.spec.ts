import { test } from '@playwright/test';

/**
 * Směna se stavbou obchodu na telefonu i na desktopu (P68, kategorie `stavba`). Kostra z P68-I T1: řádky v
 * `playwright.config.ts` (`chromium`, `pixel7-touch`, `iphone-touch`) jsou hotové; hru z ručního specu
 * `e2e/fixtures/p68-buildshift-spec.json`, stavbu klepnutím i klávesnicí a kartu výhry nebo prohry napíše kategorie.
 */
test.skip('buildshift: the game opens, plays to a win or a loss by touch and keys (P68)', () => {});
