import { expect, test } from '@playwright/test';
import { loadRapier } from '../src/play/arcade/physics/world';
import { compose } from '../src/play/compose/compose';
import { extractIntent } from '../src/play/intent/extract';
import { honestyForSpec } from '../src/play/draft/unsupported';
import { bindRoles } from '../src/play/arcade/witness';
import { verifyArcade } from '../src/play/arcade/verify';
import type { PublishedGame } from '../src/play/version';
import { scoreTriples } from '../evals/play/p41/score';
import { capture, openNative, replayState } from './play-native-input';

const examples = [
  'a monster truck racing other trucks and firing missiles',
  'a seal swimming under the ice, catching fish and avoiding orcas',
  'a goat jumping up a mountain while rocks fall',
  'a samurai duels a bear and then escapes the burning village',
];
test.beforeAll(async () => { await loadRapier(); });
for (const sentence of examples) test(`P42 publishes, renders and replays: ${sentence}`, async ({ page, request }, info) => {
  test.setTimeout(120000);
  const composition = compose(extractIntent(sentence), 1);
  expect(composition.unmet).toEqual([]);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { stage, world } = await openNative(page, request, 'live', composition.spec, sentence);
  await expect(stage.locator('canvas')).toBeVisible();
  if (sentence.includes('samurai')) await expect(page.getByTestId('arcade-attack')).toBeVisible();
  await page.screenshot({ path: info.outputPath('start.png') });
  const end = await page.evaluate(() => {
    const probe = window.__playShell as unknown as { start(): void; handPlay(until: 'end'): { runState: string } };
    probe.start(); return probe.handPlay('end');
  });
  expect(end.runState).toBe('won');
  await replayState(world, await capture(page));
  expect(errors).toEqual([]);
});

for (const [sentence, actor, verb, object] of [
  ['hockey on a frozen lake against robots', 'robot', 'rival', 'hero'],
  ['a boxer punches to the beat and defeats a robot', 'boxer', 'duel', 'robot'],
  ['drive a boat, race and fire', 'boat', 'shoot', null],
  ['a boat race with a cannon', 'boat', 'shoot', null],
  ['a helicopter race with a machine gun', 'helicopter', 'shoot', null],
  ['never stop flapping as a parrot above the jungle', 'parrot', 'flap', null],
  ['bake a loaf of bread for a hungry giant', 'hero', 'bake', 'bread'],
  ['a race with dune buggies', 'buggy', 'drive', null],
  ['a race with dune buggies', 'buggy', 'race', null],
  ['make a game about a goat jumping on a snowy mountain', 'goat', 'jump', null],
  ['let an otter swim along the river', 'otter', 'glide', null],
  ['a bear knits scarves inside a cabin', 'bear', 'knit', 'scarf'],
  ['a dog repairs clocks in a shop', 'dog', 'repair', 'clock'],
  ['make a game about a jeep driving through a canyon while firing rockets at drones', 'jeep', 'shoot', 'rocket'],
  ['in the bay, shrimp are what the swimming seahorse must catch', 'seahorse', 'catch', 'shrimp'],
  ['let a mechanic lubricate gears in a garage', 'mechanic', 'lubricate', 'gear'],
] as const) test(`P42 admits unplayed ${verb} in the published UI: ${sentence}`, async ({ page, request }) => {
  test.setTimeout(120000);
  await page.goto('/play');
  await page.getByLabel('Say it in one sentence').fill(sentence);
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 60000 });
  const response = await request.get(`/api/play/games/${new URL(page.url()).pathname.split('/').at(-1)}`);
  expect(response.status()).toBe(200);
  const game = await response.json() as PublishedGame;
  if (!game.arcade) throw new Error('Expected a published arcade world');
  const verdict = verifyArcade(game.arcade, undefined, bindRoles(game.spec, game.arcade));
  expect(verdict.publishEligible).toBe(true);
  const honesty = await honestyForSpec(sentence, game.spec, game.version.seed, game.arcade);
  expect(scoreTriples([{ actor, verb, object }], verdict.witnesses, honesty?.unmet ?? []).silent).toEqual([]);
  if (honesty) await expect(page.getByTestId('play-honest-reason')).toContainText(honesty.reason);
  await expect(page.getByTestId('arcade-stage').locator('canvas')).toBeVisible();
});
