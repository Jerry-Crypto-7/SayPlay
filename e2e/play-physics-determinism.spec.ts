/**
 * Rapier dá v Chromiu tentýž hash jako v Node (P29A T11). Hodnota z Node je ve
 * fixtuře `src/play/arcade/physics/__fixtures__/determinism.json`, kterou hlídá
 * i vitest – když se rozejdou, fyzika by hráči ujela jinam než robotovi.
 *
 * Server musí běžet s `PLAY_LAB=1` (stránka laboratoře je jinak v produkci 404).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { baseControlOf } from '../src/play/arcade/addons';
import type { ArcadeWorld } from '../src/play/arcade/contract';
import { ARCADE_LIBRARY } from '../src/play/arcade/library';
import { replayCheckpoints } from '../src/play/arcade/physics/replay-checkpoints';
import { loadRapier } from '../src/play/arcade/physics/world';
import { runBot } from '../src/play/arcade/verify';
import { BUTTON } from '../src/play/arcade/contract';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { driveSpec } from '../src/play/compose/drive';
import { nativeSpec } from '../src/play/compose/native';

const fixture = JSON.parse(readFileSync(join(__dirname, '../src/play/arcade/physics/__fixtures__/determinism.json'), 'utf8')) as { hash: string };

test('Chromium computes the Rapier scene hash Node pinned', async ({ page }) => {
  await page.goto('/play/lab/physics');
  const lab = page.getByTestId('physics-lab');
  await expect(lab).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(lab).toHaveAttribute('data-hash', fixture.hash);
  const initMs = Number(await lab.getAttribute('data-init-ms'));
  test.info().annotations.push({ type: 'rapier-init-ms', description: String(initMs) });
  console.log(`rapier init in Chromium: ${initMs} ms`);
});

for (const goal of ['goal', 'hoop', 'hole'] as const) {
  test(`published native ${goal}: Node and Chromium replay every checkpoint exactly`, async ({ page, request }) => {
    const seed = 17;
    const spec = nativeSpec({ move: 'ball', actions: ['throw'], objective: 'score', threats: ['rival'] }, {
      genre: 'throw', mode: 'default', hero: 'robot', setting: goal === 'hoop' ? 'basketball court' : goal === 'hole' ? 'golf course' : 'football field',
      cast: [{ label: goal, does: 'throw_at' }], params: { targets: 1 },
    });
    expect(spec.controlParams).toMatchObject({ goal, keeper: true });
    const published = await request.post('/api/play/games', { data: { spec, seed } });
    expect(published.ok(), await published.text()).toBe(true);
    const { versionId } = await published.json() as { versionId: string };
    const fetched = await request.get(`/api/play/games/${versionId}`);
    expect(fetched.ok(), await fetched.text()).toBe(true);
    const game = await fetched.json() as { arcade: ArcadeWorld };
    expect(game.arcade).toBeDefined();
    // Od P51 balí ovládání `pacing_control` (a fáze `phase_control`); test míří na ovládání pod obaly.
    expect(baseControlOf(game.arcade.control).id).toBe('ball');
    expect(game.arcade.seed).toBe(seed);

    await loadRapier();
    const bot = runBot(game.arcade, ARCADE_LIBRARY, { planner: false });
    expect(bot.outcome).toBe('won');
    expect(bot.tick).toBeGreaterThan(32);
    const recording = { world: game.arcade, inputs: bot.inputs, checkpoints: [0, 1, 8, 32, bot.tick] };
    const node = await replayCheckpoints(recording);
    expect(node.at(-1)?.hash).toBe(bot.hash);
    expect(node.at(-1)?.outcome).toBe('won');
    await page.goto('/play/lab/physics');
    await expect(page.getByTestId('physics-lab')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    const chromium = await page.evaluate(async data => {
      if (!window.__physicsReplay) throw new Error('Physics lab replay probe unavailable');
      return window.__physicsReplay(data);
    }, recording);
    // Full quantized state equality catches differences hidden by rounded visuals.
    expect(chromium).toEqual(node);
    await test.info().attach(`physics-${goal}-checkpoints.json`, { body: JSON.stringify({ seed, versionId, inputs: bot.inputs, node, chromium }), contentType: 'application/json' });
  });
}

// P54C T11: slučování – koule Rapieru, sloučení podle id těles a spawn do slotů jiné velikosti; celý vítězný běh.
test('published merge cell: Node and Chromium replay every checkpoint of the winning run exactly', async ({ page, request }) => {
  test.setTimeout(240_000);
  const cell = liveCells().find((candidate) => candidate.id === 'merge.default');
  expect(cell?.status).toBe('live');
  const spec = compileRecipe(assemblyOfCell(cell!));
  const seed = 5;
  const published = await request.post('/api/play/games', { data: { spec, seed } });
  expect(published.ok(), await published.text()).toBe(true);
  const { versionId } = await published.json() as { versionId: string };
  const fetched = await request.get(`/api/play/games/${versionId}`);
  expect(fetched.ok(), await fetched.text()).toBe(true);
  const game = await fetched.json() as { arcade: ArcadeWorld };
  expect(baseControlOf(game.arcade.control).id).toBe('merge');
  expect(game.arcade.seed).toBe(seed);

  await loadRapier();
  const bot = runBot(game.arcade, ARCADE_LIBRARY, { planner: false });
  expect(bot.outcome).toBe('won');
  const recording = { world: game.arcade, inputs: bot.inputs, checkpoints: [0, 1, 60, 600, 1500, 2400, bot.tick] };
  const node = await replayCheckpoints(recording);
  expect(node.at(-1)?.hash).toBe(bot.hash);
  expect(node.at(-1)?.outcome).toBe('won');
  await page.goto('/play/lab/physics');
  await expect(page.getByTestId('physics-lab')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  const chromium = await page.evaluate(async data => {
    if (!window.__physicsReplay) throw new Error('Physics lab replay probe unavailable');
    return window.__physicsReplay(data);
  }, recording);
  expect(chromium).toEqual(node);
  await test.info().attach('physics-merge-checkpoints.json', { body: JSON.stringify({ seed, versionId, inputs: bot.inputs.length, hashes: node.map((point) => point.hash) }), contentType: 'application/json' });
});

// P54C T12: vytlačování – hrdina a soupeři jsou koule Rapieru, vystrčení soupeři se odstaví (nezmizí); celý vítězný běh.
test('published push cell: Node and Chromium replay every checkpoint of the winning run exactly', async ({ page, request }) => {
  test.setTimeout(240_000);
  const cell = liveCells().find((candidate) => candidate.id === 'push.default');
  expect(cell?.status).toBe('live');
  const spec = compileRecipe(assemblyOfCell(cell!));
  const seed = 5;
  const published = await request.post('/api/play/games', { data: { spec, seed } });
  expect(published.ok(), await published.text()).toBe(true);
  const { versionId } = await published.json() as { versionId: string };
  const fetched = await request.get(`/api/play/games/${versionId}`);
  expect(fetched.ok(), await fetched.text()).toBe(true);
  const game = await fetched.json() as { arcade: ArcadeWorld };
  expect(baseControlOf(game.arcade.control).id).toBe('push');
  expect(game.arcade.seed).toBe(seed);

  await loadRapier();
  const bot = runBot(game.arcade, ARCADE_LIBRARY, { planner: false });
  expect(bot.outcome).toBe('won');
  const recording = { world: game.arcade, inputs: bot.inputs, checkpoints: [0, 1, 60, 600, 1500, 2400, bot.tick] };
  const node = await replayCheckpoints(recording);
  expect(node.at(-1)?.hash).toBe(bot.hash);
  expect(node.at(-1)?.outcome).toBe('won');
  await page.goto('/play/lab/physics');
  await expect(page.getByTestId('physics-lab')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  const chromium = await page.evaluate(async data => {
    if (!window.__physicsReplay) throw new Error('Physics lab replay probe unavailable');
    return window.__physicsReplay(data);
  }, recording);
  expect(chromium).toEqual(node);
  await test.info().attach('physics-push-checkpoints.json', { body: JSON.stringify({ seed, versionId, inputs: bot.inputs.length, hashes: node.map((point) => point.hash) }), contentType: 'application/json' });
});

for (const grip of [4, 20]) {
  test(`bounded steer grip ${grip}: identical recorded braking input in Node and Chromium`, async ({page,request}) => {
    const spec=driveSpec({move:'drive',actions:[],objective:'reach',threats:[]},{genre:'voyage',mode:'race',hero:'car',setting:'city',params:{grip,brakeDrift:4}});
    const published=await request.post('/api/play/games',{data:{spec,seed:1}});
    expect(published.ok(),await published.text()).toBe(true);
    const {versionId}=await published.json() as {versionId:string};
    const fetched=await request.get(`/api/play/games/${versionId}`);
    expect(fetched.ok(),await fetched.text()).toBe(true);
    const {arcade:world}=await fetched.json() as {arcade:ArcadeWorld};
    expect(baseControlOf(world.control).params).toMatchObject({grip,brakeDrift:4});
    const inputs=Array.from({length:32},(_,tick)=>({tick,axis:tick<8?700:tick>=16&&tick<24?-700:0,buttons:tick>=8&&tick<16?BUTTON.DOWN:0}));
    const recording={world,inputs,checkpoints:[0,1,8,16,32]};
    const node=await replayCheckpoints(recording);
    await page.goto('/play/lab/physics');
    await expect(page.getByTestId('physics-lab')).toHaveAttribute('data-state','done',{timeout:30_000});
    const chromium=await page.evaluate(async data=>{if(!window.__physicsReplay)throw new Error('Missing lab replay');return window.__physicsReplay(data);},recording);
    expect(chromium).toEqual(node);
    await test.info().attach(`steer-grip-${grip}.json`,{body:JSON.stringify({versionId,inputs,node,chromium}),contentType:'application/json'});
  });
}
