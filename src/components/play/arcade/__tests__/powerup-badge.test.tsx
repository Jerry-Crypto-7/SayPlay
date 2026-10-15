/**
 * Odznak power-upu a násobič komba v HUD (P46C T5): prstenec opravdu ubývá se
 * zbylými tiky a ×1 násobič schová. Stav se čte z počítadel simulace
 * (`POWERUP_SLOTS`, kombo jako `nextMultiplier`), proto test píše přímo do pole stavu.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BODY, COMBO, COUNTER, HEADER, POWERUP_SLOTS, POWERUP_TICKS, bodyBase, powerupCode } from '@/play/arcade/contract';

import { PowerupBadge, RING_LENGTH, readBoosts } from '../PowerupBadge';

const KEEPER = 3;
const COMBO_KEEPER = 4;

function stateWith(left: number, tick = 100): Int32Array {
  const state = new Int32Array(bodyBase(COMBO_KEEPER + 1));
  state[HEADER.tick] = tick;
  state[HEADER.counters + COUNTER.health] = 3;
  state[bodyBase(KEEPER) + POWERUP_SLOTS.kind] = powerupCode('magnet');
  state[bodyBase(KEEPER) + POWERUP_SLOTS.left] = left;
  return state;
}

function comboAt(state: Int32Array, multiplier: number, pickedAt: number): Int32Array {
  const base = bodyBase(COMBO_KEEPER);
  state[base + BODY.aux0] = multiplier;
  state[base + BODY.aux1] = pickedAt + 1;
  state[base + BODY.x] = 3;
  return state;
}

/** Viditelný oblouk prstence: první číslo `stroke-dasharray`. */
const arc = (markup: string): number => Number(/stroke-dasharray="([^" ]+)/.exec(markup)?.[1]);

describe('PowerupBadge', () => {
  it('drains the ring as the remaining ticks drop', () => {
    const full = POWERUP_TICKS.magnet;
    const readings = [full, Math.round(full / 2), 1].map((left) => readBoosts(stateWith(left), { powerup: KEEPER }));
    const fractions = readings.map((reading) => reading.fraction);
    expect(fractions[0]).toBe(1);
    expect(fractions[1]).toBeLessThan(fractions[0]!);
    expect(fractions[2]).toBeLessThan(fractions[1]!);
    expect(fractions[2]).toBeGreaterThan(0);
    // Prstenec v markupu: oblouk se zkracuje se zbytkem.
    const arcs = readings.map((reading) => arc(renderToStaticMarkup(<PowerupBadge {...reading} />)));
    expect(arcs[0]).toBeCloseTo(RING_LENGTH);
    expect(arcs[1]).toBeLessThan(arcs[0]!);
    expect(arcs[2]).toBeLessThan(arcs[1]!);
    expect(arcs[2]).toBeGreaterThan(0);
    expect(renderToStaticMarkup(<PowerupBadge {...readings[0]!} />)).toContain('data-power="magnet"');
  });

  it('shows nothing once the power-up has run out', () => {
    const reading = readBoosts(stateWith(0), { powerup: KEEPER });
    expect(reading.power).toBeNull();
    expect(renderToStaticMarkup(<PowerupBadge {...reading} />)).toBe('');
  });

  it('hides a ×1 multiplier and shows ×2 and up while the combo runs', () => {
    const one = readBoosts(comboAt(stateWith(0), 1, 95), { combo: COMBO_KEEPER });
    expect(one.multiplier).toBe(1);
    expect(renderToStaticMarkup(<PowerupBadge {...one} />)).not.toContain('hud-counter-combo');

    const three = readBoosts(comboAt(stateWith(0), 3, 95), { combo: COMBO_KEEPER });
    expect(three.multiplier).toBe(3);
    const markup = renderToStaticMarkup(<PowerupBadge {...three} />);
    expect(markup).toContain('data-testid="hud-counter-combo"');
    expect(markup).toContain('×3');
  });

  it('drops the multiplier once the combo window has passed or a life was lost', () => {
    const late = readBoosts(comboAt(stateWith(0, 95 + COMBO.window + 1), 4, 95), { combo: COMBO_KEEPER });
    expect(late.multiplier).toBe(1);
    const hurt = comboAt(stateWith(0), 4, 95);
    hurt[HEADER.counters + COUNTER.health] = 2;
    expect(readBoosts(hurt, { combo: COMBO_KEEPER }).multiplier).toBe(1);
  });
});
