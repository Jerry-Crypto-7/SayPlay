import { expect, test, type Page } from '@playwright/test';

import { buildRuntimeWorld } from '../src/ir/build';
import { hashHex } from '../src/sim/hash';
import { createRuntime, type Runtime, type WorldDocRuntime } from '../src/sim/interpreter';
import { rebranchAt } from '../src/sim/rebranch';
import { advance, createTimeline } from '../src/sim/timeline';
import { DEMO_BLUEPRINT } from '../src/app/dev/demo-world';

/**
 * Oracle úlohy T24 — **osa přetočí simulaci a nechá plátno na pokoji**.
 *
 * Sada běží nad `/dev/time`, tedy nad celou skořápkou `WorldstreamApp` se
 * skutečnou simulací a skutečnými reprezentacemi; scriptovaná je jediná věc,
 * druhá věta. Proč vlastní adresa a co je na ní harness, říká komentář té
 * stránky.
 *
 * ## Tři tvrzení a jak se každé z nich dá zfalšovat
 *
 * 1. **Přetočení mění simulaci.** Měří se hash zabaleného stavu, ne nápis
 *    v panelu — týž `hashHex`, jakým hashuje ověřovač.
 * 2. **Přetočení nemění reprezentace.** Měří se, co renderer doopravdy drží
 *    (`memory()`), a k tomu `frames()`: bez něj by „nic se nezměnilo" mohlo
 *    platit prostě proto, že se mezitím nic nevykreslilo.
 * 3. **Odbočka větev přidá, nepřepíše.** Původní budoucnost musí po odbočce
 *    pořád existovat, dát se na ni přepnout a dát tentýž hash jako předtím.
 *
 * ## Proč se hashe počítají i v Node
 *
 * Kdyby sada porovnávala jen prohlížeč se sebou samým, prošel by i běh, který
 * se s ověřovačem rozešel — a to je přesně ta vada, kterou determinismus má
 * vylučovat. Referenční čísla se proto počítají **tady**, tímtéž kódem, a proti
 * prohlížeči se staví jako nezávislá odpověď.
 */

const HORIZON = 200;
const CAPACITY = 64;
const BRANCH_TICK = 20;
const SILENCED = 'calmHive';

function referenceWorld(): WorldDocRuntime {
  const built = buildRuntimeWorld((DEMO_BLUEPRINT.world as { sim: unknown }).sim);
  if (!built.ok) throw new Error(`demo world does not lower: ${built.issues[0]}`);
  return built.world;
}

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

function runTo(runtime: Runtime, axis: ReturnType<typeof createTimeline>, doc: WorldDocRuntime, target: number) {
  while (runtime.tick < target && runtime.runState === 'running') {
    advance(axis, runtime, inputsAt(doc, runtime.tick));
  }
}

/** Obě budoucnosti spočítané v Node — nezávislá odpověď proti prohlížeči. */
function reference() {
  const doc = referenceWorld();
  const runtime = createRuntime(doc);
  const axis = createTimeline(runtime, CAPACITY);
  runTo(runtime, axis, doc, HORIZON);
  const origin = { tick: runtime.tick, hash: hashHex(runtime.state), outcome: runtime.runState };

  const changed: WorldDocRuntime = {
    ...doc,
    ir: { ...doc.ir, rules: doc.ir.rules.filter((rule) => rule.ruleId !== SILENCED) },
  };
  const result = rebranchAt(axis, runtime, BRANCH_TICK, changed);
  if (result.verdict !== 'REBRANCHED') throw new Error(`reference branch was refused: ${result.reason}`);
  const atBranch = hashHex(result.runtime.state);
  runTo(result.runtime, result.timeline, changed, HORIZON);

  return {
    origin,
    atBranch,
    branch: { tick: result.runtime.tick, hash: hashHex(result.runtime.state), outcome: result.runtime.runState },
  };
}

/** Co scéna doopravdy drží — jediný oracle „meshe se nehnuly", jaký z prohlížeče je. */
async function stageState(page: Page) {
  return page.evaluate(() => {
    const stage = window.__worldstreamStage!;
    return {
      memory: stage.memory(),
      frames: stage.frames(),
      builds: stage.builds(),
      slots: stage.slots().map((slot) => ({ id: slot.stableId, hash: slot.contentHash, triangles: slot.triangles })),
    };
  });
}

async function openTimeHarness(page: Page) {
  await page.goto('/dev/time');
  await expect(page.getByTestId('time-status')).toContainText('slots —', { timeout: 60_000 });
  await page.waitForFunction(() => window.__timeAxis !== undefined && window.__worldstreamStage?.ready() === true, undefined, {
    timeout: 60_000,
  });
}

test('osa je jeden prvek se dvěma funkcemi — fáze materializace i čas', async ({ page }) => {
  test.setTimeout(120_000);
  await openTimeHarness(page);

  const axis = page.getByTestId('time-axis');
  await expect(axis).toBeVisible();
  for (const phase of ['intent', 'world', 'detail', 'change']) {
    await expect(page.getByTestId(`axis-phase-${phase}`)).toHaveAttribute('data-reached', 'true');
  }

  // Táž stopa je zároveň přetáčení. Kdyby to byly dva prvky, tenhle nebude uvnitř osy.
  await expect(axis.getByTestId('axis-scrub')).toBeEnabled();
});

test('tažení po ose přetočí simulaci a reprezentací se nedotkne', async ({ page }) => {
  test.setTimeout(120_000);
  const expected = reference();

  await openTimeHarness(page);
  const axis = page.getByTestId('time-axis');

  await expect(axis).toHaveAttribute('data-tick', String(expected.origin.tick));
  const atHorizon = await page.evaluate(() => window.__timeAxis!.hash());
  expect(atHorizon).toBe(expected.origin.hash);

  const before = await stageState(page);

  // Tažení, ne volání API: měří se ovladač, který má porotce pod rukou.
  await page.getByTestId('axis-scrub').fill(String(BRANCH_TICK));
  await expect(axis).toHaveAttribute('data-tick', String(BRANCH_TICK));

  const rewound = await page.evaluate(() => window.__timeAxis!.hash());
  expect(rewound).toBe(expected.atBranch);
  expect(rewound).not.toBe(atHorizon);

  // Tohle je ta aserce, na které to celé stojí, a proto stojí první: `memory`
  // ani `slots` po přestavbě scény nic nenamítnou — stará se odloží, nová
  // vznikne a čísla vyjdou stejně. Naměřeno mutací 3. 9. 2026.
  const rebuilt = await stageState(page);
  expect(rebuilt.builds).toBe(before.builds);

  // Plátno mezitím kreslilo dál — jinak by „nic se nezměnilo" platilo triviálně.
  await expect
    .poll(async () => (await stageState(page)).frames, { timeout: 15_000 })
    .toBeGreaterThan(before.frames);

  const after = await stageState(page);
  expect(after.builds).toBe(before.builds);
  expect(after.memory).toEqual(before.memory);
  expect(after.slots).toEqual(before.slots);
});

test('změna zákona v přetočeném stavu založí druhou budoucnost, nepřepíše první', async ({ page }) => {
  test.setTimeout(120_000);
  const expected = reference();

  await openTimeHarness(page);
  const axis = page.getByTestId('time-axis');
  const chips = page.getByTestId('axis-branch');

  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute('data-hash', expected.origin.hash);
  await expect(chips.first()).toHaveAttribute('data-outcome', expected.origin.outcome);

  await page.getByTestId('axis-scrub').fill(String(BRANCH_TICK));
  await expect(axis).toHaveAttribute('data-tick', String(BRANCH_TICK));
  await page.getByTestId('axis-branch-here').click();

  // Dvě budoucnosti vedle sebe: ta původní zůstala, nová přibyla.
  await expect(chips).toHaveCount(2);
  await expect(axis).toHaveAttribute('data-branch', 'branch-1');

  const measured = await page.evaluate(() => window.__timeAxis!.branches());
  expect(measured).toHaveLength(2);
  expect(measured[0]).toMatchObject({
    id: 'origin',
    parentId: null,
    ruleId: null,
    endTick: expected.origin.tick,
    endHash: expected.origin.hash,
    outcome: expected.origin.outcome,
  });
  expect(measured[1]).toMatchObject({
    id: 'branch-1',
    parentId: 'origin',
    fromTick: BRANCH_TICK,
    ruleId: SILENCED,
    endTick: expected.branch.tick,
    endHash: expected.branch.hash,
    outcome: expected.branch.outcome,
  });

  // Obě jdou porovnat, a je co porovnávat.
  expect(measured[1].endHash).not.toBe(measured[0].endHash);

  // Přepnutí zpátky vrátí tutéž budoucnost, ne přepočítanou náhodu.
  await chips.first().click();
  await expect(axis).toHaveAttribute('data-branch', 'origin');
  const back = await page.evaluate(() => {
    const api = window.__timeAxis!;
    api.runTo(api.horizon);
    return { tick: api.tick(), hash: api.hash() };
  });
  expect(back).toEqual({ tick: expected.origin.tick, hash: expected.origin.hash });
});
