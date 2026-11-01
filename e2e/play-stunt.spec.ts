import { test } from '@playwright/test';

/**
 * Závod s triky na telefonu i na desktopu (P68, kategorie `vozidla-sport`). Kostra z P68-I T1: řádky v
 * `playwright.config.ts` (`chromium`, `pixel7-touch`, `iphone-touch`) jsou hotové; hru z ručního specu
 * `e2e/fixtures/p68-stunt-spec.json`, náklon prstem i klávesnicí a kartu výhry nebo prohry napíše kategorie.
 */
test.skip('stunt: the game opens, plays to a win or a loss by touch and keys (P68)', () => {});
