import { test } from '@playwright/test';

/**
 * Kresli a zachraň na telefonu i na desktopu (P68, kategorie `stavba`, volitelná). Kostra z P68-I T1: řádky v
 * `playwright.config.ts` (`chromium`, `pixel7-touch`, `iphone-touch`) jsou hotové; hru z ručního specu
 * `e2e/fixtures/p68-drawsave-spec.json`, tah prstem (`DrawsaveTouch`) i myší a kartu výhry nebo prohry napíše kategorie.
 */
test.skip('drawsave: the game opens, plays to a win or a loss by touch and keys (P68)', () => {});
