/**
 * P85A T1/T3: neobratný hráč v prohlížeči nad běžícím `next start`. Míří tam, kam robot ověřovače (nejbližší cíl),
 * ale každé rozhodnutí zahraje o 400 ms později a každý pátý nový vstup zkazí – drží dál starý směr a nic nestiskne,
 * dokud nepřijde další. Hraje ručními hodinami sondy `__playShell` (týž běh jako klávesnice), nejvýš 45 s. Zapíše,
 * jestli do 45 s DOM ukázal výhru (`play-outcome` s `data-outcome="won"`), jestli robot vyhrává (`playWitness`)
 * a chyby konzole. Jen pozorování; do repa nic nepíše.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p85/clumsy.ts \
 *     --port 3218 --ids s01,s03 [--runs 3] [--out D:/caches/p85a/shots]
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { ARCADE_HZ } from '@/play/arcade/contract';

export const CLUMSY = {
  /** Reakce: rozhodnutí robota se zahraje o tolik tiků později (400 ms). */
  lagTicks: Math.round(0.4 * ARCADE_HZ),
  /** Každý tolikátý nový vstup se zkazí. */
  spoilEvery: 5,
  /** Strop jednoho běhu. */
  seconds: 45,
} as const;

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

interface Probe {
  byHand(on: boolean): void;
  botWants(): { buttons: number; axis: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { runState: string; tick: number; items: number; score: number };
  playWitness(): { runState: string; tick: number };
}

interface Clumsy {
  queue: { buttons: number; axis: number }[];
  applied: { buttons: number; axis: number };
  last: { buttons: number; axis: number };
  changes: number;
}

if (process.argv[1]?.endsWith('clumsy.ts')) {
  const base = `http://127.0.0.1:${flag('--port', '3218')}`;
  const ids = flag('--ids', '').split(',').filter(Boolean);
  const runs = Number(flag('--runs', '1'));
  const out = flag('--out', 'D:/caches/p85a/shots');
  mkdirSync(out, { recursive: true });
  const { sentences } = JSON.parse(readFileSync('evals/play/p85/prompts.json', 'utf8')) as { sentences: { id: string; text: string }[] };
  const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--disable-features=OpenXR'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  let errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 160));
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 160)}`));

  for (const [index, { id, text }] of sentences.filter((entry) => ids.length === 0 || ids.includes(entry.id)).entries()) {
    errors = [];
    const created = await page.request.post(`${base}/api/play/games`, { data: { sentence: text }, headers: { 'x-forwarded-for': `198.51.100.${String(60 + index)}` } });
    if (created.status() >= 300) {
      console.log(JSON.stringify({ id, error: `${String(created.status())} ${(await created.text()).slice(0, 200)}` }));
      continue;
    }
    const { url } = (await created.json()) as { url: string };
    const path = new URL(url, base).pathname;
    const results: { run: number; won: boolean; outcome: string; seconds: number; items: number }[] = [];
    let witness: { runState: string; tick: number } | null = null;
    for (let run = 0; run < runs; run += 1) {
      await page.goto(`${base}${path}`);
      await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 90_000 });
      await page.waitForFunction(() => typeof (window as unknown as { __playShell?: Probe }).__playShell?.botWants === 'function', undefined, { timeout: 90_000 });
      await page.waitForTimeout(800);
      await page.evaluate(({ run: offset }) => {
        const probe = (window as unknown as { __playShell: Probe }).__playShell;
        probe.byHand(true);
        // Obměna běhu: zkažený je pátý, šestý… vstup podle čísla běhu, ne pokaždé týž.
        (window as unknown as { __p85: Clumsy }).__p85 = { queue: [], applied: { buttons: 0, axis: 0 }, last: { buttons: 0, axis: 0 }, changes: offset };
      }, { run });
      await page.getByTestId('arcade-stage').click({ force: true });
      let now = { runState: 'running', tick: 0, items: 0, score: 0 };
      while (now.runState === 'running' && now.tick < CLUMSY.seconds * ARCADE_HZ) {
        now = await page.evaluate(({ lag, every, before }) => {
          const probe = (window as unknown as { __playShell: Probe }).__playShell;
          const me = (window as unknown as { __p85: Clumsy }).__p85;
          // Robot se ptá před každým tikem (`BotHand.decide`), proto první tik až po první otázce.
          let state = before;
          for (let k = 0; k < 30 && state.runState === 'running'; k += 1) {
            me.queue.push(probe.botWants() ?? { buttons: 0, axis: 0 });
            const wanted = me.queue.length > lag ? me.queue.shift()! : { buttons: 0, axis: 0 };
            if (wanted.axis !== me.last.axis || wanted.buttons !== me.last.buttons) {
              me.changes += 1;
              me.last = wanted;
              // Každý pátý nový vstup zkazí: starý směr zůstane, stisk se ztratí.
              me.applied = me.changes % every === 0 ? { buttons: 0, axis: me.applied.axis } : wanted;
            }
            probe.hold(me.applied.axis);
            probe.press(me.applied.buttons);
            state = probe.tickByHand();
          }
          return state;
        }, { lag: CLUMSY.lagTicks, every: CLUMSY.spoilEvery, before: now });
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      }
      await page.evaluate(() => (window as unknown as { __playShell: Probe }).__playShell.byHand(false));
      const outcome = page.getByTestId('play-outcome');
      const shown = await outcome.waitFor({ timeout: 5000 }).then(() => outcome.getAttribute('data-outcome')).catch(() => null);
      await page.screenshot({ path: join(out, `${id}-run${String(run)}.png`) });
      results.push({ run, won: now.runState === 'won' && shown === 'won', outcome: shown ?? now.runState, seconds: Number((now.tick / ARCADE_HZ).toFixed(1)), items: now.items });
      if (run === 0) witness = await page.evaluate(() => (window as unknown as { __playShell: Probe }).__playShell.playWitness());
    }
    console.log(JSON.stringify({ id, path, results, witness: witness === null ? null : { ...witness, seconds: Number((witness.tick / ARCADE_HZ).toFixed(1)) }, errors: [...new Set(errors)] }));
  }
  await browser.close();
}
