/**
 * Úvodní karta (`PromptSpot`) se měří každý snímek čekání na první vstup. Zápis
 * stejné hodnoty stylu by prohlížeči zneplatnil rozvržení a další měření ho musí
 * přepočítat (P37B T7: čaroděj na úvodní kartě ~6 % CPU telefonu). Na obrazovce
 * se to nepozná – proto pin.
 */

import { describe, expect, it, vi } from 'vitest';

import { promptPlacement, setStyleVar } from '../ArcadeStage';

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

  it('shrinks the card above or below on a narrow phone, where beside is narrower still', () => {
    const placed = promptPlacement({ top: 0.35, bottom: 0.7, left: 0.3, right: 0.7 }, { width: 390, height: 844 }, { top: 140, bottom: 740 }, { width: 340, height: 200 });
    expect(placed.at).toBe('above');
    expect(placed.scale).toBeCloseTo((0.35 * 844 - 140 - 32) / 200, 3);
  });
});
