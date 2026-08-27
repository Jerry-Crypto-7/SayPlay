import { describe, expect, it } from 'vitest';

import { buildEmissionRequest, EXAMPLE_MARKER } from '../../prompt';
import { localGrammar } from '../emit';
import { MAX_OUTPUT_TOKENS } from '../engine';

/**
 * Qwenův slovník se stahuje až s vahami a do repozitáře nepatří. Pro stabilní
 * unit test proto používáme konzervativní rozpočtovou jednotku: nejvýš tři
 * UTF-8 bajty anglického JSONu na token. Naměřený běh má poměr volnější
 * (959 tokenů na odpověď tohoto řádu), takže odhad rozpočet nepodstřelí.
 */
const BYTES_PER_BUDGET_TOKEN = 3;

function exampleFromProductionPrompt(): string {
  const system = buildEmissionRequest('anything', localGrammar()).system;
  const markerAt = system.indexOf(EXAMPLE_MARKER);
  expect(markerAt).toBeGreaterThan(-1);
  const jsonAt = system.indexOf('{', markerAt);
  expect(jsonAt).toBeGreaterThan(markerAt);
  return system.slice(jsonAt);
}

describe('output token budget', () => {
  it('fits at least two complete production examples', () => {
    const exampleBytes = new TextEncoder().encode(exampleFromProductionPrompt()).length;
    const exampleTokens = Math.ceil(exampleBytes / BYTES_PER_BUDGET_TOKEN);

    expect(exampleTokens).toBeGreaterThan(0);
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(exampleTokens * 2);
  });
});
