import { test } from '@playwright/test';

/**
 * Střelnice z očí na telefonu i na desktopu (P68, kategorie `prvni-osoba`). Kostra z P68-I T1: řádky v
 * `playwright.config.ts` (`chromium`, `pixel7-touch`, `iphone-touch`) jsou hotové; hru z ručního specu
 * `e2e/fixtures/p68-railfps-spec.json`, natočení a střelbu prstem (`RailfpsTouch`) i klávesnicí a kartu výhry nebo
 * prohry napíše kategorie.
 */
test.skip('railfps: the game opens, plays to a win or a loss by touch and keys (P68)', () => {});
