/**
 * P54B T15b: stěny útesu kluzáku nesmí zakrýt scénu. Jádro (`pieces/glide.ts`) zavírá kolem každého kruhu
 * celý průřez letu 24 × 14 m čtyřmi stěnami po 20 m; neprůhledné vyplnily obraz jednou barvou (slepý soud T15).
 */
import { describe, expect, it } from 'vitest';

import { REEF_WALL_OPACITY } from '../../glide/GlideScene';

describe('glide reef walls (P54B T15b)', () => {
  it('stay visible as a hazard', () => {
    expect(REEF_WALL_OPACITY).toBeGreaterThanOrEqual(0.15);
  });

  it('leave at least half of the scene visible through the two walls in view before the fog', () => {
    expect((1 - REEF_WALL_OPACITY) ** 2).toBeGreaterThanOrEqual(0.5);
  });
});
