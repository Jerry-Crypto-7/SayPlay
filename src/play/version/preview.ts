/**
 * Skript náhledu robota pro feed (P54A T2). Počítá se jednou při publikaci
 * z běhu, který `verifyArcade` stejně pouští – v prohlížeči by `runBot` stál
 * 21–685 ms hlavního vlákna (naměřeno 19. 10. nad vestavěnými hrami).
 *
 * Okno začíná sekundu před prvním výstřelem pravidla (tam se ve hře něco
 * děje) a trvá nejvýš 4 s; když robot vyhraje dřív, okno se posune zpět, ať
 * má aspoň 2 s. Hash v `endTick` je z přehrání robotových vstupů, ne
 * z dekódovaného skriptu – rozejde-li se kódování s během, test to pozná.
 *
 * **Vstupy jsou řetězec, ne pole.** Klient potřebuje i vstupy před oknem
 * (tichý dopočet od tiku 0) a analogové řízení mění osu skoro každý tik:
 * `steer` má před oknem 717 záznamů, jako pole `[tick, buttons, axis, n]`
 * 10,5 KB. Záznam je `[mezera~]osa[b tlačítka][x tiků]`, záznamy odděluje
 * čárka; mezera = tiky bez vstupu od konce předchozího záznamu, výchozí
 * hodnoty (mezera 0, tlačítka 0, 1 tik) se nepíšou. Příklad: `10~500x4,6~0b1`
 * = osa 500 v ticích 10–13, tlačítko 1 v tiku 20.
 */

import type { ArcadeWorld, InputEvent } from '../arcade/contract';
import { replay } from '../arcade/kernel';
import { ARCADE_LIBRARY } from '../arcade/library';
import type { BotRun } from '../arcade/verify';

import type { FeedPreview } from './version';

/** Sekunda před prvním výstřelem pravidla, 60 Hz. */
const LEAD_TICKS = 60;
const MIN_TICKS = 120;
const MAX_TICKS = 240;
const RECORD = /^(?:(\d+)~)?(-?\d+)(?:b(\d+))?(?:x(\d+))?$/;

/** Řídký záznam vstupů (seřazený podle tiku) → run-length řetězec. */
export function encodeInputs(inputs: readonly InputEvent[]): string {
  const records: { tick: number; buttons: number; axis: number; ticks: number }[] = [];
  for (const input of inputs) {
    const last = records[records.length - 1];
    if (last !== undefined && last.tick + last.ticks === input.tick && last.buttons === input.buttons && last.axis === input.axis) last.ticks += 1;
    else records.push({ tick: input.tick, buttons: input.buttons, axis: input.axis, ticks: 1 });
  }
  let end = 0;
  return records
    .map((record) => {
      const gap = record.tick - end;
      end = record.tick + record.ticks;
      return `${gap > 0 ? `${String(gap)}~` : ''}${String(record.axis)}${record.buttons !== 0 ? `b${String(record.buttons)}` : ''}${record.ticks > 1 ? `x${String(record.ticks)}` : ''}`;
    })
    .join(',');
}

export function decodeInputs(encoded: string): InputEvent[] {
  const inputs: InputEvent[] = [];
  let tick = 0;
  for (const record of encoded === '' ? [] : encoded.split(',')) {
    const match = RECORD.exec(record);
    if (match === null) throw new Error(`preview: bad input record "${record}"`);
    tick += Number(match[1] ?? 0);
    const axis = Number(match[2]);
    const buttons = Number(match[3] ?? 0);
    const ticks = Number(match[4] ?? 1);
    for (let i = 0; i < ticks; i += 1) inputs.push({ tick: tick + i, buttons, axis });
    tick += ticks;
  }
  return inputs;
}

export function previewOf(world: ArcadeWorld, bot: Pick<BotRun, 'inputs' | 'tick' | 'firstFired'>): FeedPreview {
  const fired = bot.firstFired.filter((tick) => tick >= 0);
  const first = fired.length === 0 ? null : Math.min(...fired);
  const startTick = first === null ? 0 : Math.max(0, Math.min(first - LEAD_TICKS, bot.tick - MIN_TICKS));
  const endTick = Math.min(bot.tick, startTick + MAX_TICKS);
  const window = bot.inputs.filter((input) => input.tick < endTick);
  return { startTick, endTick, inputs: encodeInputs(window), hash: replay(world, window, ARCADE_LIBRARY, endTick).hash };
}

export function decodePreview(preview: FeedPreview): { readonly startTick: number; readonly endTick: number; readonly hash: string; readonly inputs: InputEvent[] } {
  return { startTick: preview.startTick, endTick: preview.endTick, hash: preview.hash, inputs: decodeInputs(preview.inputs) };
}
