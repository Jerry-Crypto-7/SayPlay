import { expect, it } from 'vitest';
import { sceneLook } from '../../arcade/look';
import { draftGameSpecWithMeta } from '../../draft';

it.each(['Drive a car to the finish', 'Swim through rings', 'Walk through a maze', 'Run to the finish'])('%s retains explicit night in the actual scene rig', sentence => {
  const game = draftGameSpecWithMeta(`${sentence} through a city at night.`);
  expect(game.spec.theme.timeOfDay).toBe('night');
  const night = sceneLook(game.spec.theme);
  const day = sceneLook({ ...game.spec.theme, timeOfDay: 'day' });
  expect(night.skyTop).not.toBe(day.skyTop);
  expect(night.horizon).not.toBe(day.horizon);
  expect(night.sun).toBeLessThan(day.sun);
  expect(night.ground).toBe(day.ground);
});

it('keeps ordinary daytime lighting and supports explicit dusk', () => {
  const theme = { setting: 'forest', mood: 'adventurous' };
  expect(sceneLook(theme)).toEqual(sceneLook({ ...theme, timeOfDay: 'day' }));
  expect(sceneLook({ ...theme, setting: 'forest at dusk' }).horizon).not.toBe(sceneLook(theme).horizon);
});
