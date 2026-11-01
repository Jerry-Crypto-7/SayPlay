/**
 * P68I T7: placené měření smí jen do vlastní knihy útraty. Kniha s produkční předponou by měřením
 * snědla peníze, které má veřejný provoz a porota; bez kladného stropu měření běží jen jako rychlá hra.
 */

import { describe, expect, it } from 'vitest';

import { evalLedger } from '../eval-ledger.mjs';

const GOOD = { WORLDSMITH_SPEND_STORE_PREFIX: 'worldsmith:p68-eval', PLAY_EVAL_SPEND_CAP_USD: '5' } as const;

describe('evalLedger', () => {
  it('lets a paid run start on an -eval ledger with a positive cap', () => {
    expect(evalLedger(GOOD)).toEqual({ mode: 'paid', prefix: 'worldsmith:p68-eval', capUsd: 5 });
    expect(evalLedger({ ...GOOD, PLAY_EVAL_SPEND_CAP_USD: ' 0.75 ' })).toEqual({ mode: 'paid', prefix: 'worldsmith:p68-eval', capUsd: 0.75 });
  });

  it('refuses the production ledger, named or default', () => {
    expect(evalLedger({ ...GOOD, WORLDSMITH_SPEND_STORE_PREFIX: 'worldsmith:spend' }).mode).toBe('fast-only');
    expect(evalLedger({ ...GOOD, PLAY_PROD_SPEND_PREFIX: 'worldsmith:p68-eval' })).toMatchObject({ mode: 'fast-only', reason: expect.stringContaining('PLAY_PROD_SPEND_PREFIX') });
  });

  it.each([undefined, '', '   ', 'worldsmith:p68', 'worldsmith:p68-eval:x', 'worldsmith:p68-EVAL'])('refuses a ledger that is not an -eval one: %s', (prefix) => {
    expect(evalLedger({ ...GOOD, WORLDSMITH_SPEND_STORE_PREFIX: prefix })).toMatchObject({ mode: 'fast-only', reason: expect.stringContaining('WORLDSMITH_SPEND_STORE_PREFIX') });
  });

  it.each([undefined, '', '0', '0.00', '-1', 'five', '1e3', 'Infinity'])('refuses a cap that is not a positive dollar amount: %s', (cap) => {
    expect(evalLedger({ ...GOOD, PLAY_EVAL_SPEND_CAP_USD: cap })).toMatchObject({ mode: 'fast-only', reason: expect.stringContaining('PLAY_EVAL_SPEND_CAP_USD') });
  });
});
