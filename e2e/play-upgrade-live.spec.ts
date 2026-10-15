import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * AI verze naživo (P46E T6). Otevře tři AI verze, které na běžícím demu vyrobil `evals/play/p46e/live.mjs`
 * (králík o01, první hotové auto z o03/o04, křeček o05): tlačítka akcí jsou vidět, konzole je bez chyb a ve hře,
 * která bosse umí (běžec, řízení, skákačka), se boss objeví do konce hry – robot hraje „rukou“ jako v
 * `play-segments.spec.ts` a hra se zastaví na banneru bosse kvůli snímku. Snímky jdou do `evals/play/p46e/live/`.
 *
 * Běží jen proti demu, které `live.json` naplnilo (`FALLBACK_SMOKE_URL=http://127.0.0.1:<port>`): AI verze
 * žijí v úložišti toho serveru. Bez `live.json` se přeskočí.
 */

const LIVE = join(__dirname, '..', 'evals', 'play', 'p46e', 'live.json');
const SHOTS = join(__dirname, '..', 'evals', 'play', 'p46e', 'live');
const BOSS_CONTROLS = new Set(['runner', 'steer', 'platformer']);
/** Hláška rekordéru klipu, ne hry – stejná výjimka jako `play-segments.spec.ts`. */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';
const PER_FRAME = 3;

interface LiveRow {
  readonly id: string;
  readonly sentence: string;
  readonly status: string;
  readonly aiUrl?: string;
}

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
}

interface ControlPiece {
  readonly id?: string;
  readonly params?: { readonly base?: ControlPiece; readonly abilities?: { readonly ids?: readonly string[] } };
}

/** Akce hrdiny z obalů ovládání (`addon_control.params.abilities.ids`) po celé cestě k základnímu ovládání. */
const abilitiesOf = (piece: ControlPiece | undefined): string[] =>
  piece === undefined ? [] : [...(piece.params?.abilities?.ids ?? []), ...abilitiesOf(piece.params?.base)];

const rows: readonly LiveRow[] = existsSync(LIVE) ? (JSON.parse(readFileSync(LIVE, 'utf8')) as { rows: LiveRow[] }).rows : [];
const ready = (ids: readonly string[]): LiveRow | undefined => ids.map((id) => rows.find((row) => row.id === id)).find((row) => row?.status === 'ready');

const GAMES = [
  { name: 'rabbit', ids: ['o01'] },
  { name: 'car', ids: ['o03', 'o04'] },
  { name: 'hamster', ids: ['o05'] },
] as const;

/** Robot hraje, dokud se neobjeví banner bosse nebo hra neskončí; pak hru podrží (snímek bosse). */
function playUntilBoss(page: Page): Promise<{ readonly runState: string; readonly beats: readonly string[]; readonly boss: string | null }> {
  return page.evaluate(
    (perFrame) =>
      new Promise((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        const beats: string[] = [];
        let boss: string | null = null;
        let last: Element | null = null;
        const observer = new MutationObserver(() => {
          const banner = document.querySelector('[data-testid="play-pacing-banner"]');
          if (banner === null || banner === last) return;
          last = banner;
          const beat = banner.getAttribute('data-beat') ?? '';
          beats.push(beat);
          if (beat === 'boss') boss = banner.textContent ?? '';
        });
        observer.observe(document.body, { childList: true, subtree: true });
        shell.start();
        shell.byHand(true);
        const frame = () => {
          let now = { runState: 'running', tick: 0 };
          for (let k = 0; k < perFrame && now.runState === 'running' && boss === null; k += 1) {
            const wants = shell.botWants();
            if (wants !== null) {
              shell.hold(wants.axis);
              shell.press(wants.buttons);
            }
            now = shell.tickByHand();
          }
          if (now.runState === 'running' && boss === null && now.tick < 9000) {
            requestAnimationFrame(frame);
            return;
          }
          setTimeout(() => {
            observer.disconnect();
            resolve({ runState: now.runState, beats, boss });
          }, 150);
        };
        requestAnimationFrame(frame);
      }),
    PER_FRAME,
  );
}

test.describe('/play/[id] – AI versions made live by the director (P46E T6)', () => {
  test.skip(rows.length === 0, 'no evals/play/p46e/live.json – run evals/play/p46e/live.mjs against the demo first');

  for (const game of GAMES) {
    test(`${game.name}: action buttons visible, no console errors, boss where the game has one`, async ({ page }) => {
      test.setTimeout(240_000);
      const row = ready(game.ids);
      expect(row, `${game.ids.join('/')} has a ready AI version in live.json`).toBeDefined();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`);
      });

      await page.goto(row!.aiUrl!);
      const stage = page.getByTestId('arcade-stage');
      await expect(stage).toBeVisible({ timeout: 60_000 });
      await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
      const control = (await stage.getAttribute('data-control')) ?? '';
      // Každá akce hrdiny, kterou uložený svět nese, má vidět své tlačítko. Hra bez akcí (křeček „escapes“ je jen
      // běžec) tlačítko mít nemusí – rozhoduje svět ze serveru, ne odhad z věty.
      const saved = (await (await page.request.get(`/api/play/games/${row!.aiUrl!.split('/').at(-1)!}`)).json()) as { arcade: { control: ControlPiece } };
      for (const ability of abilitiesOf(saved.arcade.control)) await expect(page.getByTestId(`arcade-ability-${ability}`)).toBeVisible({ timeout: 30_000 });
      // Střelba (`arcade-fire`), akce věty (`arcade-<action>`) i akce hrdiny (`arcade-ability-*`) nesou `.play-fire`.
      const actions = page.locator('.play-fire');
      const labels = await actions.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-testid') ?? ''));
      await page.screenshot({ path: join(SHOTS, `${game.name}-start.png`) });

      const run = await playUntilBoss(page);
      await page.screenshot({ path: join(SHOTS, `${game.name}-${run.boss === null ? 'end' : 'boss'}.png`) });
      const line = `${row!.id} "${row!.sentence}" ${control}: actions ${labels.join(',')}; beats ${run.beats.join(',') || '-'}; boss ${run.boss ?? '-'}; ${run.runState}`;
      test.info().annotations.push({ type: 'live', description: line });
      console.log(line);

      if (BOSS_CONTROLS.has(control)) expect(run.boss, `${control} game shows its boss before the end`).not.toBeNull();
      expect(errors.filter((error) => !error.startsWith(CLIP_RESOLUTION_WARNING))).toEqual([]);
    });
  }
});
