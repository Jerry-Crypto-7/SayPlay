/**
 * Nepřítel z věty je na telefonu čitelný (P62 T5). Soudce u rychlé hry „zombie shooter in a mall“ psal „small
 * zombie figures“, u brouků „bugs are barely visible“: model zombie scéna má (P61 T3 ho staví i na střelnici),
 * na plátně ale zabíral ~6 % výšky. Test drží dvě věci:
 * - střelnice kreslí nepřítele věty jeho modelem a jen věta bez nepřítele nechá kotouč terče (`foeTarget`);
 * - měřítko nepřítele (`foeScale`) ho z podílu, jaký by měl v měřítku 1, zvětší nad `LEGIBLE_SHARE.target`,
 *   nejvýš `LEGIBLE_CAP`, a spojitě – nepřítel, který jde k hrdinovi, se nesmí cestou skokem zmenšit.
 * Jestli tělo opravdu dosáhne podílu v obraze telefonu a desktopu, měří až `e2e/p58a-framing.spec.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../draft/draft';
import { LEGIBLE_CAP, LEGIBLE_SHARE, enemyModel, foeScale, foeTarget, propModels } from '../models';
import { loadRapier } from '../physics/world';

/** Spec rychlé hry a modely, ze kterých střelnice kreslí nepřátele a terče (`cast` v `ArcadePlay`). */
function rangeOf(sentence: string) {
  const spec = draftGameSpecWithMeta(sentence, 1).spec;
  return { spec, cast: { enemy: enemyModel(spec), props: propModels(spec) } };
}

beforeAll(async () => {
  await loadRapier();
});

describe('P62 T5: the shooter draws the sentence’s foe with its model', () => {
  it('zombie shooter: the waves and the range both draw the zombie, not the disc', () => {
    const { spec, cast } = rangeOf('zombie shooter in a mall');
    expect(spec.control).toBe('shooter');
    expect(cast.enemy).toContain('zombie');
    expect(cast.props.target).toBe(cast.enemy);
    expect(foeTarget(cast)).toBe(true);
  });

  it('a sentence that names no foe keeps the disc target, and the disc is no foe', () => {
    const { spec, cast } = rangeOf('shoot the targets');
    expect(spec.control).toBe('shooter');
    // Bez modelu z popisku kreslí scéna tělo terče primitivem `target` (kotouč).
    expect(cast.props.target).toBeUndefined();
    expect(foeTarget(cast)).toBe(false);
  });

  it('a range thing the sentence collects rather than shoots is no foe', () => {
    expect(foeTarget({ enemy: 'rigged:q-zombie', props: { target: 'coin-gold' } })).toBe(false);
  });
});

describe('P62 T5: foeScale lifts a small foe over the legible share', () => {
  it('a foe at 6 % of the canvas height grows over 10 % with room for its pose', () => {
    const scale = foeScale(0.06);
    expect(scale * 0.06).toBeGreaterThanOrEqual(LEGIBLE_SHARE.target * 1.1);
    expect(scale).toBeLessThanOrEqual(LEGIBLE_CAP);
  });

  it('never past the cap, never under 1, and 1 without a measure', () => {
    expect(foeScale(0.02)).toBe(LEGIBLE_CAP);
    expect(foeScale(0.3)).toBe(1);
    expect(foeScale(0)).toBe(1);
    expect(foeScale(Number.NaN)).toBe(1);
  });

  it('is continuous as the foe walks closer – no jump where it stops growing', () => {
    let last = foeScale(0.01);
    let shown = 0.01 * last;
    for (let share = 0.01; share <= 0.3; share += 0.0002) {
      const scale = foeScale(share);
      expect(scale).toBeLessThanOrEqual(last + 1e-9);
      expect(last - scale).toBeLessThan(0.01);
      // Na plátně se nepřítel cestou k hrdinovi nikdy nezmenší: podíl × měřítko neklesá.
      expect(share * scale).toBeGreaterThanOrEqual(shown - 1e-9);
      last = scale;
      shown = share * scale;
    }
  });
});
