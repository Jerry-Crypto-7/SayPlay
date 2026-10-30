/**
 * Vibrace ovladačů ve VR (P67 T8): tabulka pokrývá každý druh události, který sběrnice efektů posílá – druh bez
 * záznamu by ve VR tiše nevibroval a z obrazu by to nikdo nepoznal. Na tik jde každé ruce jeden pulz, nejsilnější.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { VISUAL_EVENT_KINDS, type VisualEventKind } from '@/components/play/arcade/effects/bus';

import { XR_HAPTICS, hapticsOn, pulsesOf, setHapticsOn } from '../haptics';

const tick = (...kinds: VisualEventKind[]) => kinds.map((kind) => ({ kind }));

afterEach(() => setHapticsOn(true));

describe('the haptics table', () => {
  it.each(VISUAL_EVENT_KINDS)('%s has an entry: a pulse or an explicit null', (kind) => {
    expect(Object.hasOwn(XR_HAPTICS, kind), kind).toBe(true);
    const haptic = XR_HAPTICS[kind];
    if (haptic === null) return;
    expect(haptic.intensity).toBeGreaterThan(0);
    expect(haptic.intensity).toBeLessThanOrEqual(1);
    expect(haptic.ms).toBeGreaterThan(0);
    expect(['left', 'right', 'both']).toContain(haptic.hand);
  });

  it('has nothing the bus does not send', () => {
    expect(Object.keys(XR_HAPTICS).sort()).toEqual([...VISUAL_EVENT_KINDS].sort());
  });

  it('hit, pickup, death, win, lose, near miss, power-up, boss down and combo are felt', () => {
    for (const kind of ['hit', 'pickup', 'death', 'win', 'lose', 'nearMiss', 'powerup', 'bossDefeat', 'comboUp'] as const) expect(XR_HAPTICS[kind], kind).not.toBeNull();
  });

  it('a hit buzzes the right hand as the swing did before the table (P65 T3)', () => {
    expect(XR_HAPTICS.hit).toEqual({ intensity: 0.6, ms: 40, hand: 'right' });
  });
});

describe('pulses of one tick', () => {
  it('each hand gets its strongest entry once', () => {
    expect(pulsesOf(tick('pickup', 'hit', 'death'))).toEqual({ right: XR_HAPTICS.hit });
    expect(pulsesOf(tick('pickup', 'lose'))).toEqual({ left: XR_HAPTICS.lose, right: XR_HAPTICS.lose });
    expect(pulsesOf(tick('hit', 'nearMiss'))).toEqual({ left: XR_HAPTICS.nearMiss, right: XR_HAPTICS.hit });
  });

  it('kinds without an entry and an empty tick buzz nothing', () => {
    expect(pulsesOf(tick('land', 'spawn', 'stateChange', 'ability'))).toEqual({});
    expect(pulsesOf([])).toEqual({});
  });

  it('the comfort switch turns every pulse off; it starts on', () => {
    expect(hapticsOn()).toBe(true);
    setHapticsOn(false);
    expect(pulsesOf(tick('hit', 'win'))).toEqual({});
    setHapticsOn(true);
    expect(pulsesOf(tick('hit'))).toEqual({ right: XR_HAPTICS.hit });
  });
});
