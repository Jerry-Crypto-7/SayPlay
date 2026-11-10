/**
 * P83E T4: věta „věci na pult a součet“ jde do obchodu a bere si z věty počet, jednotku a cíl. Špatné směrování vypadá
 * jako úspěch (hra se postaví a dá se dohrát) – sbírání mincí, třídění, krádež nebo stavba obchodu by se tiše staly
 * obchodem se součtem, a obchod s „exactly 30 kilos“ by počítal dolary. Proto čísla nad sadou T1 a nad 200 větami p30.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { ROUTE_PENDING, classifyGenre } from '../classify';
import { readShop, shopItemOf, shopPlaceOf } from '../shop';

const json = <T>(...path: string[]): T => JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', ...path), 'utf8')) as T;
// `sealed` je od brány T5 spálená (P83E T7 na ní smí ladit); `sealed2` test nečte – otevře ji až druhá brána.
const SET = json<{ dev: string[]; sealed: string[]; mustNot: string[] }>('p83', 'e-sentences.json');
const P30 = json<{ sentences: { id: string; text: string }[] }>('p30', 'test-200.json').sentences;
const top = (sentence: string): string => {
  const best = classifyGenre(sentence, null).ranked[0]!;
  return `${best.genre}.${best.mode}`;
};

interface Tuning { readonly items: number; readonly unit: string; readonly target?: number; readonly spot?: string; readonly name?: string }
const tuningOf = (sentence: string): Tuning => {
  const meta = draftGameSpecWithMeta(sentence, 1);
  expect(meta.spec.control, sentence).toBe('shop');
  return (meta.spec.controlParams as { tuning: Tuning }).tuning;
};

describe('pick-place-count sentences route to shop (P83E T4)', () => {
  it('the shop is live for the classifier', () => {
    expect(ROUTE_PENDING.has('shop')).toBe(false);
  });

  it('sends at least 16 of the 20 dev sentences to shop and none of the 10 must-nots', () => {
    const routed = SET.dev.filter((text) => top(text) === 'shop.default');
    expect(routed.length, SET.dev.filter((text) => !routed.includes(text)).join('\n')).toBeGreaterThanOrEqual(16);
    expect(SET.mustNot.filter((text) => top(text) === 'shop.default')).toEqual([]);
  });

  it('moves at most 3 of the 200 held-out p30 sentences into shop', () => {
    const moved = P30.filter((sentence) => top(sentence.text) === 'shop.default').map((sentence) => `${sentence.id} ${sentence.text}`);
    expect(moved.length, moved.join('\n')).toBeLessThanOrEqual(3);
  });

  it('takes the count, the unit and the target from the sentence', () => {
    expect(tuningOf(SET.dev[0]!)).toMatchObject({ items: 3, unit: 'price' });
    expect(tuningOf(SET.dev[0]!).target).toBeUndefined();
    expect(tuningOf(SET.dev[4]!)).toMatchObject({ items: 3, unit: 'weight' });
    expect(tuningOf(SET.dev[3]!)).toMatchObject({ unit: 'price', target: 12 });
    expect(tuningOf(SET.dev[15]!)).toMatchObject({ unit: 'weight', target: 30 });
    expect(tuningOf(SET.dev[5]!)).toMatchObject({ unit: 'plain', target: 20 });
  });

  it('shelves the things the sentence carries, not the default bear', () => {
    expect(shopItemOf(SET.dev[3]!)).toBe('cakes');
    expect(shopItemOf(SET.dev[2]!)).toBe('toys');
    expect(shopItemOf(SET.dev[7]!)).toBe('potion ingredients');
    expect(shopItemOf(SET.dev[0]!)).toBeUndefined();
    const meta = draftGameSpecWithMeta(SET.dev[15]!, 1);
    expect(meta.spec.roles?.find((role) => role.id === 'item')?.label).toBe('pumpkin');
  });

  it('reads the unit word: price, weight or a plain number', () => {
    expect(readShop('see what I have to pay at the till').unit).toBe(0);
    expect(readShop('put parcels on the scale and add up the weight').unit).toBe(1);
    expect(readShop('weigh fruit on the scale').unit).toBe(1);
    expect(readShop('put five books on the cart and count the total pages').unit).toBe(2);
    expect(readShop('until the total is exactly 99 dollars').target).toBe(50);
  });
});

/**
 * P83E T7 – co první brána našla (`evals/play/p83/e-gate.md`). Každé z nich hra „projde“: postaví se, robot vyhraje,
 * součet sedí – a přitom hraje jinou hru, než věta řekla. Oko to na snímku přehlédne, soudce ne.
 */
describe('the first gate findings stay fixed (P83E T7)', () => {
  it('keeps the count of a vague noun: four items are four, not the default three', () => {
    expect(tuningOf(SET.sealed[0]!).items).toBe(4);
    expect(tuningOf(SET.dev[1]!).items).toBe(5);
    expect(tuningOf(SET.dev[13]!).items).toBe(6);
    expect(tuningOf('a gift shop where I carry seven things to the till and see the total').items).toBe(7);
  });

  it('counts money when the sentence names a value or a price, even on a scale', () => {
    expect(tuningOf(SET.sealed[8]!).unit).toBe('price');
    expect(readShop('weigh the gold on the scale and see its value').unit).toBe(0);
    expect(readShop('a post office where I put parcels on the scale and the total weight decides the stamp').unit).toBe(1);
    expect(readShop('a market where I put apples on the scale until it shows exactly 4 kilos').unit).toBe(1);
  });

  it('routes "see the price" and a basket with a cost to shop, a basket without money stays out', () => {
    expect(top(SET.sealed[5]!)).toBe('shop.default');
    expect(top(SET.sealed[7]!)).toBe('shop.default');
    expect(top('catch the falling apples in a basket before they hit the ground')).not.toBe('shop.default');
    expect(top('catch eggs in a basket and add up the total score')).not.toBe('shop.default');
  });

  it('draws the drop spot and the place the sentence names, and shelves food rather than bears', () => {
    expect(tuningOf(SET.sealed[1]!).spot).toBe('bowl');
    expect(tuningOf(SET.sealed[9]!)).toMatchObject({ spot: 'tray', name: 'food' });
    expect(tuningOf(SET.sealed[7]!).spot).toBe('basket');
    expect(tuningOf(SET.dev[0]!).spot).toBeUndefined();
    expect(shopPlaceOf(SET.sealed[0]!)).toBe('corner shop');
    expect(draftGameSpecWithMeta(SET.sealed[4]!, 1).spec.theme.setting).toBe('post office');
    expect(draftGameSpecWithMeta(SET.sealed[0]!, 1).spec.theme.setting).toBe('corner shop');
  });
});
