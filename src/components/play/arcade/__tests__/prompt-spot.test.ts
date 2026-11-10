/**
 * Úvodní karta (`PromptSpot`) se měří každý snímek čekání na první vstup. Zápis
 * stejné hodnoty stylu by prohlížeči zneplatnil rozvržení a další měření ho musí
 * přepočítat (P37B T7: čaroděj na úvodní kartě ~6 % CPU telefonu). Na obrazovce
 * se to nepozná – proto pin.
 */

import { describe, expect, it, vi } from 'vitest';

import { hudBars, promptPlacement, setStyleVar } from '../ArcadeStage';

function host() {
  const values = new Map<string, string>();
  const style = {
    getPropertyValue: (name: string) => values.get(name) ?? '',
    setProperty: vi.fn((name: string, value: string) => values.set(name, value)),
  };
  return { element: { style } as unknown as HTMLElement, setProperty: style.setProperty };
}

describe('prompt spot style writes', () => {
  it('writes a CSS variable only when its value changes', () => {
    const { element, setProperty } = host();
    setStyleVar(element, '--_hero-top', '40.0%');
    setStyleVar(element, '--_hero-top', '40.0%');
    setStyleVar(element, '--_hero-top', '40.0%');
    expect(setProperty).toHaveBeenCalledTimes(1);
    setStyleVar(element, '--_hero-top', '41.0%');
    expect(setProperty).toHaveBeenCalledTimes(2);
  });
});

// P58C T6: rytíř souboje vzal na desktopu přes půl výšky a karta „Tap to start“ se mezi něj a lišty HUD
// vešla jen v 0,3 – klávesy nešly přečíst (T5, 3/3 soudci). Karta vypadá jako karta i zmenšená, proto pin.
describe('prompt placement', () => {
  const card = { width: 420, height: 230 };

  it('puts the card beside a tall hero on a wide desktop stage, full size', () => {
    const knight = { top: 0.33, bottom: 0.7, left: 0.22, right: 0.49 };
    expect(promptPlacement(knight, { width: 1280, height: 720 }, { top: 115, bottom: 600 }, card)).toEqual({ at: 'right', scale: 1 });
    expect(promptPlacement({ ...knight, left: 0.51, right: 0.78 }, { width: 1280, height: 720 }, { top: 115, bottom: 600 }, card)).toEqual({ at: 'left', scale: 1 });
  });

  it('keeps the card above or below the hero when it fits there', () => {
    expect(promptPlacement({ top: 0.55, bottom: 0.8, left: 0.4, right: 0.6 }, { width: 1280, height: 720 }, { top: 115, bottom: 600 }, card)).toEqual({ at: 'above', scale: 1 });
  });

  it('shrinks the card above or below on a desktop stage where beside is narrower still', () => {
    const placed = promptPlacement({ top: 0.35, bottom: 0.7, left: 0.3, right: 0.7 }, { width: 640, height: 844 }, { top: 140, bottom: 740 }, { width: 340, height: 200 });
    expect(placed.at).toBe('above');
    expect(placed.scale).toBeCloseTo((0.35 * 844 - 140 - 32) / 200, 3);
  });

  // P83A T5: na 390 px rytíř kartu stáhl na 0,21 (písmo 2,7 px) a zmenšená karta se nečte, i když vypadá jako karta.
  describe('on a phone the card never shrinks to fit beside the hero', () => {
    const phone = { width: 390, height: 844 };
    const bars = { top: 170, bottom: 690 };
    const card = { width: 358, height: 320 };

    it('stays above the hero when it fits there at full size', () => {
      expect(promptPlacement({ top: 0.65, bottom: 0.8, left: 0.3, right: 0.7 }, phone, bars, card)).toEqual({ at: 'above', scale: 1 });
    });

    it('docks under the top HUD bars at full size where above and below are too short (the knight)', () => {
      expect(promptPlacement({ top: 0.32, bottom: 0.95, left: 0.2, right: 0.8 }, phone, bars, card)).toEqual({ at: 'top', scale: 1 });
    });

    it('shrinks only when the card is taller than the whole band between the bars', () => {
      expect(promptPlacement({ top: 0.32, bottom: 0.95, left: 0.2, right: 0.8 }, phone, bars, { ...card, height: 600 })).toEqual({ at: 'top', scale: (690 - 170 - 32) / 600 });
    });
  });
});

// P64 T6 posadil na telefonu na výšku stav AI verze pod řádek cíle. Jako podlaha zavřel pás karty (souboj: „Tap to
// start“ přes přepínač) i `playRect` kamer u horního okraje – karta i záběr vypadají jen jinak, ne rozbitě, proto pin.
describe('HUD bars', () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100 }) as DOMRect;
  const stageOn = (tops: readonly DOMRect[], floors: readonly DOMRect[]) => {
    const shell = { querySelectorAll: (selector: string) => (selector.includes('.play-hud-goal') ? tops : floors).map((r) => ({ getBoundingClientRect: () => r })) };
    return { parentElement: shell } as unknown as HTMLElement;
  };
  const stage = rect(0, 839);

  it('closes the band at a floor piece in the lower half, as on desktop', () => {
    expect(hudBars(stageOn([rect(12, 120)], [rect(700, 760), rect(780, 830)]), stage)).toEqual({ top: 120, bottom: 700 });
  });

  it('counts a floor piece wholly in the upper half to the top band (the AI-version switch under the goal)', () => {
    expect(hudBars(stageOn([rect(12, 120)], [rect(128, 172), rect(780, 830)]), stage)).toEqual({ top: 172, bottom: 780 });
  });

  it('keeps a floor piece reaching into the lower half (a full-height touch zone) a floor', () => {
    expect(hudBars(stageOn([rect(12, 120)], [rect(300, 839)]), stage)).toEqual({ top: 120, bottom: 300 });
  });
});
