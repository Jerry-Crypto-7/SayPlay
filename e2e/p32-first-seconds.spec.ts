/**
 * Žádná černá obrazovka v prvních sekundách hry (P32D T6).
 *
 * Do prvního snímku plátna je vidět to, co leží pod ním: dřív tmavé pozadí
 * stránky (`--play-bg`, #0f172a), takže nová hra nejdřív „zčernala“. Test
 * otevře hru každé věty offline sady a zachytí:
 * - **pozadí pod plátnem** – první neprůhledné pozadí od `arcade-stage`
 *   nahoru; u arkády musí být obloha sady (`LOOKS[data-look].sky`);
 * - **úplně první snímek plátna** – hned po prvním volání kreslení, ještě
 *   před složením stránky, přes pozadí pod ním; nesmí mít > 90 % černých
 *   pixelů.
 *
 * Snímek obrazovky na tohle nestačí: vznikne o několik snímků později a
 * první snímek by neviděl.
 */

import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { LOOKS } from '../src/play/arcade/look';

const SET = (JSON.parse(readFileSync('evals/play/p32/baseline-sentences.json', 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;

/** Nejvýš tolik pixelů prvního snímku smí být černých (AC T6). */
const MAX_BLACK = 0.9;

interface FirstFrame {
  readonly stage: string;
  readonly look: string | null;
  readonly black: number;
  readonly backdrop: readonly [number, number, number];
}

declare global {
  interface Window {
    __p32FirstFrame?: FirstFrame;
  }
}

/** Běží v prohlížeči před dokumentem: první kreslení na plátně hry změří v mikroúloze po snímku. */
function captureFirstFrame(): void {
  const STAGES = '[data-testid="arcade-stage"], [data-testid="play-grid-stage"]';
  // Černá = žádný kanál nad 48 (#0f172a pozadí stránky sem patří).
  const DARK = 48;
  const backdropOf = (from: Element | null): [number, number, number] => {
    for (let at = from; at !== null; at = at.parentElement) {
      const parts = getComputedStyle(at).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
      if (parts.length >= 3 && (parts[3] ?? 1) > 0) return [parts[0]!, parts[1]!, parts[2]!];
    }
    return [255, 255, 255];
  };
  const measure = (canvas: HTMLCanvasElement): void => {
    const stage = canvas.closest(STAGES)!;
    const backdrop = backdropOf(canvas.parentElement);
    const probe = document.createElement('canvas');
    probe.width = 48;
    probe.height = 27;
    const context = probe.getContext('2d')!;
    context.fillStyle = `rgb(${backdrop.join(',')})`;
    context.fillRect(0, 0, probe.width, probe.height);
    // Kreslicí buffer WebGL je do složení stránky ještě celý – mikroúloha běží hned po snímku.
    context.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < DARK) black += 1;
    window.__p32FirstFrame = { stage: stage.getAttribute('data-testid')!, look: stage.getAttribute('data-look'), black: black / (probe.width * probe.height), backdrop };
  };
  let seen = false;
  for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype] as const) {
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'] as const) {
      const original = (proto as unknown as Record<string, unknown>)[name];
      if (typeof original !== 'function') continue;
      (proto as unknown as Record<string, unknown>)[name] = function (this: WebGLRenderingContext, ...args: unknown[]) {
        const canvas = this.canvas;
        if (!seen && canvas instanceof HTMLCanvasElement && canvas.closest(STAGES) !== null) {
          seen = true;
          queueMicrotask(() => measure(canvas));
        }
        return (original as (...rest: unknown[]) => unknown).apply(this, args);
      };
    }
  }
}

const hex = (rgb: readonly number[]): string => `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`;

for (const sentence of SET) {
  test(`${sentence.id}: the first seconds show the look's sky, never a black screen`, async ({ page, request }) => {
    const published = await request.post('/api/play/games', { data: { sentence: sentence.text } });
    expect(published.status(), await published.text()).toBeLessThan(300);
    const { url } = (await published.json()) as { url: string };
    await page.addInitScript(captureFirstFrame);
    await page.goto(url);
    await page.waitForFunction(() => window.__p32FirstFrame !== undefined, undefined, { timeout: 60_000 });
    const first = (await page.evaluate(() => window.__p32FirstFrame))!;
    test.info().annotations.push({ type: 'first-frame', description: `${first.stage} look=${String(first.look)} backdrop=${hex(first.backdrop)} black=${first.black.toFixed(2)}` });
    expect(first.black, `first frame of ${sentence.id} over ${hex(first.backdrop)}`).toBeLessThanOrEqual(MAX_BLACK);
    if (first.stage === 'arcade-stage') {
      const look = LOOKS[first.look as keyof typeof LOOKS];
      expect(look, `unknown look ${String(first.look)}`).toBeDefined();
      expect(hex(first.backdrop), 'what shows under the canvas before its first frame').toBe(look.sky);
    }
  });
}
