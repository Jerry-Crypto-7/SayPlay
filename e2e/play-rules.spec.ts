/**
 * Co pravidla dělají, je vidět (P29A T6, pravidlo P26): robot přehraje ruční
 * hru pravidel a sonda scény čte ze skupin, které plátno opravdu kreslí –
 * nesený klíč nad zemí u hrdiny, dveře, které po přepnutí zmizí, kámen v letu.
 *
 * Server musí běžet s `PLAY_LAB=1` (stránka laboratoře je jinak v produkci 404).
 */

import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, fixture: string) {
  await page.goto(`/play/lab/rules?f=${fixture}`);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'move_free', { timeout: 60_000 });
  await page.waitForFunction(() => window.__playRender !== undefined, undefined, { timeout: 60_000 });
  await expect(stage).toHaveAttribute('data-things', /\S/, { timeout: 30_000 });
  return stage;
}

test.describe.configure({ timeout: 120_000 });

const countOf = (things: string | null, id: string): number => Number(new RegExp(`(?:^| )${id}:(\\d+)`).exec(things ?? '')?.[1] ?? 0);

test('carry key: the held key rides on the hero and the toggled door disappears', async ({ page }) => {
  const stage = await open(page, 'carry-key');
  const doorsBefore = countOf(await stage.getAttribute('data-things'), 'door');
  expect(doorsBefore).toBe(1);
  await expect(stage).toHaveAttribute('data-held', 'key', { timeout: 30_000 });
  expect((await page.evaluate(() => window.__playRender!())).calls).toBeGreaterThan(0);
  await expect.poll(async () => countOf(await stage.getAttribute('data-things'), 'door'), { timeout: 30_000 }).toBe(doorsBefore - 1);
});

test('throw rock: the rock flies above the ground', async ({ page }) => {
  const stage = await open(page, 'throw-rock');
  await expect(stage).toHaveAttribute('data-held', 'rock', { timeout: 30_000 });
  await expect(stage).toHaveAttribute('data-airborne', /(?:^| )rock(?: |$)/, { timeout: 30_000 });
});
