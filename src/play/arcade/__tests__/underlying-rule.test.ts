import { describe, expect, it } from 'vitest';

import { underlyingRule } from '../addons';
import type { PieceRef } from '../contract';

const gate = (trigger: string, base: PieceRef): PieceRef => ({ id: `assembly_gate_${trigger}`, params: { parts: [], base } });

describe('underlyingRule', () => {
  const native: PieceRef = { id: 'time_limit', params: { seconds: 40 } };

  it('unwraps nested gates down to the native rule', () => {
    expect(underlyingRule(gate('tick', native))).toBe(native);
    expect(underlyingRule(gate('tick', gate('contact', native)))).toBe(native);
  });

  it('passes an unwrapped rule through unchanged', () => {
    expect(underlyingRule(native)).toBe(native);
  });
});
