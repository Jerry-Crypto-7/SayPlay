import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

import { buildRuntimeWorld } from '../src/ir/build';
import { createRuntimeController } from '../src/worldstream/runtime-controller';
import { STORM_BELL_PROMPT, stormBellAnswers, stormBellWorld } from './fixtures/storm-bell';
import { fakeUpstream, freePort, startLiveServer } from './live-server';

/**
 * Oracle úlohy P22 T12 – **pravidlo světa přepne oblohu a počasí, a hash
 * zůstane týž jako bez rendereru**.
 *
 * Dvě vady, které tenhle soubor hlídá, vypadají obě jako hotová práce:
 *
 * 1. Vazba, která projde schématem i routou a na plátně **nic neudělá** –
 *    tween zapojený naprázdno. Měří se proto průměrný jas pixelů plátna před
 *    zazvoněním a po usazení tweenu; bouře ho musí posunout aspoň o 12 %.
 * 2. Vazba, která by hodnotu z tweenu **četla zpátky do stavu** – vypadala by
 *    jako hezčí bouře a rozbila by replay. Drží to rovnost hashe: tentýž
 *    svět s týmiž vstupy se přehraje v Node bez rendereru a musí dojít
 *    k témuž hashi na témže tiku.
 *
 * Fixtura jde **skutečnou routou** `POST /api/worldstream/sessions` přes
 * falešného poskytovatele a druhý `next start` (`live-server.ts`) – žádná
 * záplata na schématu ani na routě, takže `lookBindings` prošly týmiž branami,
 * jakými by prošla odpověď modelu.
 *
 * `window.__viewer.pixels()` na hlavní cestě není (patří `/embed`); pixely
 * se čtou ze screenshotu plátna, stejně jako v `door-binding.spec.ts`.
 */

/** Průměrný jas snímku 0–255. */
async function meanLuminance(png: Buffer): Promise<number> {
  const raw = await sharp(png).removeAlpha().raw().toBuffer();
  let sum = 0;
  for (let at = 0; at < raw.length; at += 3) sum += 0.2126 * raw[at] + 0.7152 * raw[at + 1] + 0.0722 * raw[at + 2];
  return sum / (raw.length / 3);
}

async function act(page: Page, label: string): Promise<void> {
  const option = page.getByTestId('runtime-action').locator('option').filter({ hasText: label });
  await page.getByTestId('runtime-action').selectOption((await option.getAttribute('value'))!);
  await page.getByTestId('runtime-act').click();
}

test('zvon spustí bouři: plátno ztmavne o ≥ 12 % a hash po 200 ticích sedí s replayem bez rendereru', async ({ page }, info) => {
  test.setTimeout(240_000);
  const upstream = fakeUpstream(stormBellAnswers());
  const upstreamPort = await freePort();
  await new Promise<void>((resolve) => upstream.server.listen(upstreamPort, '127.0.0.1', resolve));
  const live = await startLiveServer(upstreamPort);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${live.url}/`);
    await expect(page.getByTestId('generation-mode')).toHaveValue('live');
    await page.getByTestId('prompt-input').fill(STORM_BELL_PROMPT);
    await page.getByTestId('prompt-submit').click();
    await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', { timeout: 90_000 });
    await expect(page.getByTestId('runtime-controls')).toBeVisible({ timeout: 30_000 });
    expect(upstream.calls(), 'plánovač a kompilátor, každý jednou').toBe(2);

    // Sonda existuje jen na světě s vazbami – její přítomnost už říká, že
    // `lookBindings` prošly routou až do `ProxyWorld`.
    await page.waitForFunction(() => window.__worldstreamLook?.().preset === 'day' && window.__worldstreamLook().settled, undefined, { timeout: 30_000 });
    await page.waitForTimeout(400);
    const canvas = page.getByTestId('worldstream-canvas');
    const day = await meanLuminance(await canvas.screenshot());

    await act(page, 'activate bell');
    await expect(page.getByTestId('runtime-input-result')).toContainText('ring');
    await expect(page.getByTestId('runtime-value-f:storm')).toHaveText('storm: on');
    await page.waitForFunction(() => window.__worldstreamLook?.().preset === 'storm' && window.__worldstreamLook().settled, undefined, { timeout: 15_000 });
    await page.waitForTimeout(200);
    const storm = await meanLuminance(await canvas.screenshot());
    await page.screenshot({ path: info.outputPath('storm-bell.png') });

    const change = Math.abs(storm - day) / day;
    console.log(`[look-binding] průměrný jas den ${day.toFixed(1)} → bouře ${storm.toFixed(1)}, změna ${(change * 100).toFixed(1)} %`);
    expect(storm, 'bouře má plátno ztmavit, ne rozsvítit').toBeLessThan(day);
    expect(change, 'tween zapojený naprázdno: obloha se po zazvonění nezměnila').toBeGreaterThanOrEqual(0.12);

    // Hash: tentýž běh bez rendereru. Tik, hash i vstupy se čtou jedním
    // voláním, takže patří k témuž stavu.
    await page.waitForFunction(() => (window.__worldstreamLook?.().tick ?? 0) >= 200, undefined, { timeout: 30_000 });
    const observed = await page.evaluate(() => window.__worldstreamLook!());
    expect(observed.tick).toBeGreaterThanOrEqual(200);
    expect(observed.inputs.map((input) => input.actionId)).toEqual(['activate']);

    const built = buildRuntimeWorld(stormBellWorld().world.sim);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const replay = createRuntimeController({ ...built.world, trace: [...observed.inputs] });
    replay.observeAt(observed.tick);
    const replayed = replay.getSnapshot();
    console.log(`[look-binding] tik ${String(observed.tick)}: prohlížeč ${observed.stateHash}, replay ${replayed.stateHash}`);
    expect(replayed.tick).toBe(observed.tick);
    expect(replayed.stateHash, 'hash s rendererem a bez něj se liší: něco z tweenu vteklo do stavu').toBe(observed.stateHash);

    // Týž svět zůstává dohratelný: bouře odemkla bránu a svědek jí projde.
    await act(page, 'pass gate');
    await expect(page.getByTestId('runtime-state')).toHaveText('won');
    expect(errors).toEqual([]);
  } finally {
    live.stop();
    upstream.server.close();
  }
});
