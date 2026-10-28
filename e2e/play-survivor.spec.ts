import { test } from '@playwright/test';

/**
 * Přežití ve vlnách na telefonu i na desktopu (P66 T5). Kostra z T2: řádek v `playwright.config.ts` (`chromium`,
 * `pixel7-touch`) je hotový; hru z ručního specu `e2e/fixtures/p66-survivor-spec.json`, gesta i klávesnici,
 * výběr vylepšení a kartu výhry nebo prohry napíše úloha žánru.
 */
test.skip('survivor: the game opens, plays to a win or a loss by touch and keys (P66 T5)', () => {});
