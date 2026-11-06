/**
 * Kroky režie pod id fronty práce (P73C T2): volba, kterou napsal model a dveře u věty by ji odmítly, hráč neuvidí.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { __resetSteps, stepsOf } from '@/play/director/progress';

import { recordDirectorStep } from '../_director';

afterEach(() => __resetSteps());

describe('recordDirectorStep', () => {
  it('zapíše fáze i volby, odmítnutou volbu vynechá', () => {
    recordDirectorStep('upgrade:a', { kind: 'reading' });
    recordDirectorStep('upgrade:a', { kind: 'hero', value: 'hamster' });
    recordDirectorStep('upgrade:a', { kind: 'place', value: 'a lab where you make a bomb' });
    recordDirectorStep('upgrade:a', { kind: 'checking' });
    expect(stepsOf('upgrade:a')).toEqual(['Reading your idea…', 'Hero: hamster', 'Checking it can be won…']);
  });
});
