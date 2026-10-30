/**
 * Klíče háčků v `tuning` (P66, nález recenze Fáze 2): generátor je nevidí nikde – v kompilaci, tempování ani remixu
 * (`generatorParams`). Přísné schéma generátoru by je jinak odmítlo: remix „harder“ by spadl na výjimce a tempování
 * časovky, rytmu a hodu by se tiše vypnulo.
 */

import { describe, expect, it } from 'vitest';

import { remixPatch } from '../../../director/remix';
import { generatorParams } from '../../pieces/pacing-parts';
import { fightSpec, fightTuned } from './harness';

describe('hook keys never reach a generator', () => {
  it('genre.v6 params drop the hook keys, older specs keep them as before', () => {
    const v6 = generatorParams(fightTuned((tuning) => ({ ...tuning, hookRarity: true })));
    expect(v6).toEqual({ enemies: 3, waves: 3 });
    expect(generatorParams(fightTuned((tuning) => tuning, 'genre.v5'))).toMatchObject({ hookRounds: 3, hookUpgrades: 'speed,fire_rate,extra_life' });
  });

  it('remix harder works on a game with hooks', () => {
    expect(() => remixPatch('harder', fightSpec())).not.toThrow();
    expect(remixPatch('harder', fightSpec()).length).toBeGreaterThan(0);
  });
});
