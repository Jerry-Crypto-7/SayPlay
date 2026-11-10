import { Color } from 'three';
import { expect, it } from 'vitest';
import { sceneLook } from '../../arcade/look';
import { TODAY_STYLE } from '../../arcade/look/style';
import { draftGameSpecWithMeta } from '../../draft';

/** Lineární jas `#rrggbb`. */
const luma = (hex: string): number => {
  const { r, g, b } = new Color(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

it.each(['Drive a car to the finish', 'Swim through rings', 'Walk through a maze', 'Run to the finish'])('%s retains explicit night in the actual scene rig', sentence => {
  const game = draftGameSpecWithMeta(`${sentence} through a city at night.`);
  expect(game.spec.theme.timeOfDay).toBe('night');
  const night = sceneLook(game.spec.theme);
  const day = sceneLook({ ...game.spec.theme, timeOfDay: 'day' });
  expect(night.skyTop).not.toBe(day.skyTop);
  expect(night.horizon).not.toBe(day.horizon);
  expect(night.sun).toBeLessThan(day.sun);
  // Zem nese místo, ne noc. Profil P81 ji za jasného dne předem ochladí proti teplému slunci (odstín), jas drží
  // (`sameLuma`); bez profilu je to táž barva. Noc s toutéž přebarvenou zemí by o zaokrouhlení hexu rozbila
  // invariant čitelnosti nálad proti noci (`look.test.ts`), proto přesná barva proti `TODAY_STYLE`.
  expect(sceneLook(game.spec.theme, TODAY_STYLE).ground).toBe(sceneLook({ ...game.spec.theme, timeOfDay: 'day' }, TODAY_STYLE).ground);
  expect(luma(night.ground)).toBeCloseTo(luma(day.ground), 2);
});

it('keeps ordinary daytime lighting and supports explicit dusk', () => {
  const theme = { setting: 'forest', mood: 'adventurous' };
  expect(sceneLook(theme)).toEqual(sceneLook({ ...theme, timeOfDay: 'day' }));
  expect(sceneLook({ ...theme, setting: 'forest at dusk' }).horizon).not.toBe(sceneLook(theme).horizon);
});
