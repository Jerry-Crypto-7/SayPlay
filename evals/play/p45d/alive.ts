/**
 * Měřidlo „je postava živá“ (P45D T3).
 *
 * `scripts/p45d/alive-clip.mjs` nahraje šest snímků hry hrané robotem po 150 ms,
 * ořízne je kolem hrdiny a složí do jednoho listu 3 × 2. Slepý soudce (Codex na
 * předplatné, `ask` ze `scripts/p37d/judge-sheet.mjs`: jen `sheet.png` v prázdném
 * dočasném adresáři) odpoví jedním voláním na dvě otázky – co je ta postava a co
 * dělá, a jestli se její tělo hýbe tak, jak by se to, co jmenoval, hýbalo.
 *
 * Druhá otázka jméno hrdiny z věty neříká: jedno volání na větu (rozpočet ≤ 30)
 * a první odpověď tak zůstane slepá. `alive` = ano na druhou otázku, `likeNoun` =
 * první odpověď sedí na hrdinu věty (shoda `matches` jako u listů modelů).
 */

import { basename } from 'node:path';

import { ask, blindQuestion, matches } from '../../../scripts/p37d/judge-sheet.mjs';

/** Jedna řádka, žádné slovo, které by prozradilo, co se měří nebo jak se hra jmenuje. */
export const ALIVE_QUESTION =
  'The attached image is a contact sheet of 6 frames from a 3D game while it is being played, in reading order (left to right, then top to bottom), taken 0.15 s apart, each frame cropped so that one character stays in the middle: its travel across the scene does not show and the background may shift. Reply only with the JSON the schema asks for: character = what the character is, the most likely common English noun (1-3 words); doing = what it is doing, at most 8 words; alive = true only if the body of the character itself visibly moves between the frames the way such a thing would move (legs stepping, hopping, wings flapping, tail or body swaying, leaning, squashing, bouncing on its wheels), false if it only slides across the picture, stands stiff like a statue, or nothing changes.';

export const ALIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['character', 'doing', 'alive'],
  properties: {
    character: { type: 'string' },
    doing: { type: 'string' },
    alive: { type: 'boolean' },
  },
} as const;

export interface AliveAnswer {
  readonly character: string;
  readonly doing: string;
  readonly alive: boolean;
}

interface ChecklistItem {
  readonly item: string;
  readonly slot: string;
  readonly match?: readonly string[];
}

export interface PanelSentence {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly checklist?: readonly ChecklistItem[];
}

/** Hrdina věty z kontrolního seznamu a všechna jména, která porota uzná. */
export function heroOf(sentence: PanelSentence): { readonly noun: string; readonly names: readonly string[] } | null {
  const hero = sentence.checklist?.find((entry) => entry.slot === 'hero');
  return hero === undefined ? null : { noun: hero.item, names: [hero.item, ...(hero.match ?? [])] };
}

/** Zapečetěné sady (P30 test, P43, P44E, P45A) se nečtou – podle jména souboru i podle pečeti v obsahu. */
export function assertOpenSet(file: string, sentences: readonly PanelSentence[]): void {
  if (/sealed|test-200/i.test(basename(file))) throw new Error(`${file}: sealed set – the alive judge never reads it`);
  const sealed = sentences.find((sentence) => sentence.source === 'test' || /^sealed/i.test(sentence.source ?? ''));
  if (sealed !== undefined) throw new Error(`${file}: ${sealed.id} carries the seal "${sealed.source}" – the alive judge never reads it`);
}

/**
 * Začátek okna šesti snímků: první vzorek, kde se hrdina pohnul, a za ním dost
 * vzorků na celé okno; bez pohybu první vzorek (měří se i stojící hrdina).
 */
export function windowStart(moved: readonly boolean[], size = 6): number {
  for (let index = 0; index + size <= moved.length; index += 1) if (moved[index]) return index;
  return 0;
}

/** Promítnutý obdélník hrdiny v souřadnicích obrazu −1 … 1, +y nahoru (`__playFrame().hero`). */
export interface HeroBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly behind?: boolean;
}

export interface Crop {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Výřez každého snímku (px): čtverec stejný pro celé okno, vystředěný na hrdinu v tom snímku.
 * Přesun hrdiny scénou (i skok jádra) tak z listu zmizí a zůstane jen pohyb jeho těla –
 * se společným výřezem soudce bral posun po obraze za živost (T15: `--toy off` jen o 21,7
 * bodu níž, P45D T24). Snímek bez hrdiny dostane průměrný střed; bez hrdiny celý obraz.
 */
export function stableCropsOf(boxes: readonly (HeroBox | null)[], width: number, height: number): Crop[] {
  const seen = boxes.filter((box): box is HeroBox => box !== null && box.behind !== true);
  if (seen.length === 0) return boxes.map(() => ({ left: 0, top: 0, width, height }));
  const px = (x: number) => ((x + 1) / 2) * width;
  const py = (y: number) => ((1 - y) / 2) * height;
  const centre = (box: HeroBox) => ({ x: (px(box.minX) + px(box.maxX)) / 2, y: (py(box.minY) + py(box.maxY)) / 2 });
  const largest = Math.max(...seen.map((box) => Math.max(px(box.maxX) - px(box.minX), py(box.minY) - py(box.maxY))));
  const side = Math.round(Math.min(largest * 1.6 + 40, width, height));
  const mean = { x: seen.reduce((sum, box) => sum + centre(box).x, 0) / seen.length, y: seen.reduce((sum, box) => sum + centre(box).y, 0) / seen.length };
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, 0), max));
  return boxes.map((box) => {
    const at = box !== null && box.behind !== true ? centre(box) : mean;
    return { left: clamp(at.x - side / 2, width - side), top: clamp(at.y - side / 2, height - side), width: side, height: side };
  });
}

/** Argumenty a pracovní adresář soudce nad listem: jen `sheet.png` a schéma v prázdném adresáři. */
export const aliveArgs = (sheet: string, schemaFile: string) => blindQuestion(sheet, schemaFile, ALIVE_QUESTION);

/** Jedno volání soudce; odpověď zapíše do `answerFile`, když ji codex vydal. */
export const askAlive = (sheet: string, schemaFile: string, answerFile: string) => ask(sheet, schemaFile, answerFile, ALIVE_QUESTION);

export interface AliveRow {
  readonly id: string;
  readonly noun: string;
  /** Hrdina se v okně snímků pohnul (podle promítnutého obdélníku). */
  readonly moving: boolean;
  readonly frames: number;
  readonly answer: AliveAnswer | null;
  readonly alive: boolean | null;
  readonly likeNoun: boolean | null;
}

export function rowOf(sentence: PanelSentence, capture: { readonly moving: boolean; readonly frames: number }, answer: AliveAnswer | null): AliveRow {
  const hero = heroOf(sentence);
  if (hero === null) throw new Error(`${sentence.id}: no hero in the checklist`);
  return {
    id: sentence.id,
    noun: hero.noun,
    moving: capture.moving,
    frames: capture.frames,
    answer,
    alive: answer === null ? null : answer.alive,
    likeNoun: answer === null ? null : hero.names.some((name) => matches(name, answer.character)),
  };
}

const shareOf = (hit: number, of: number) => ({ hit, of, share: of === 0 ? 0 : Math.round((hit / of) * 1000) / 1000 });

/** Souhrn běhu: jmenovatel jsou věty, na které soudce odpověděl. */
export function summary(rows: readonly AliveRow[]) {
  const judged = rows.filter((row) => row.answer !== null);
  return {
    sentences: rows.length,
    judged: judged.length,
    alive: shareOf(judged.filter((row) => row.alive === true).length, judged.length),
    likeNoun: shareOf(judged.filter((row) => row.likeNoun === true).length, judged.length),
    moving: shareOf(rows.filter((row) => row.moving).length, rows.length),
  };
}
