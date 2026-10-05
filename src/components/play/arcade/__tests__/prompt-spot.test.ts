/**
 * Úvodní karta (`PromptSpot`) se měří každý snímek čekání na první vstup. Zápis
 * stejné hodnoty stylu by prohlížeči zneplatnil rozvržení a další měření ho musí
 * přepočítat (P37B T7: čaroděj na úvodní kartě ~6 % CPU telefonu). Na obrazovce
 * se to nepozná – proto pin.
 */

import { describe, expect, it, vi } from 'vitest';

import { setStyleVar } from '../ArcadeStage';

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
