/**
 * Robotem ověřená hra s fyzikou dohraje v Chromiu stejně jako v Node (P29A R4).
 * Zkušební scéna v `play-physics-determinism.spec.ts` jde přes `PhysicsWorld`;
 * tady jde skutečný krok jádra přes `PhysicsSession` (4 podkroky, kinematické
 * překážky, teleport neseného kamene). Robot hraje na serveru, prohlížeč jeho
 * záznam přehraje a hash na konci musí sedět; záznam posunutý o tik ne.
 *
 * Server musí běžet s `PLAY_LAB=1` (stránka laboratoře je jinak v produkci 404).
 */

import { expect, test } from '@playwright/test';

test('a published physics game replays in Chromium to the Node hash', async ({ page }) => {
  await page.goto('/play/lab/rules?f=throw-rock-physics&replay=1');
  const lab = page.getByTestId('rules-replay');
  await expect(lab).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(lab).toHaveAttribute('data-physics', 'true');
  await expect(lab).toHaveAttribute('data-outcome', 'won');
  const nodeHash = await lab.getAttribute('data-node-hash');
  expect(nodeHash).toMatch(/^[0-9a-f]{8}$/);
  await expect(lab).toHaveAttribute('data-hash', nodeHash!);
  expect(await lab.getAttribute('data-shifted-hash')).not.toBe(nodeHash);
});
