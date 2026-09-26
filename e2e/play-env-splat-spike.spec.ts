import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

// P29C T1: rozhodnutí o splatu musí sedět s napsaným pravidlem. Vykreslení
// Sparkem se měří jen tehdy, když licence projdou – dnes ne (váhy FlashWorld
// jsou CC-BY-NC-SA-4.0), takže spec hlídá, že záznam zůstane v souladu.
const record = readFileSync('evals/play/env/flashworld.md', 'utf8');
const lines = record.trim().split('\n');
const decision = lines[lines.length - 1];

test('the FlashWorld record ends with a decision', () => {
  expect(decision).toMatch(/^DECISION: (splat|panorama-only) – \S/);
});

test('a non-commercial licence in the record forces panorama-only', () => {
  const nonCommercial = /\bCC-BY-NC/.test(record);
  if (nonCommercial) expect(decision).toMatch(/^DECISION: panorama-only/);
});
