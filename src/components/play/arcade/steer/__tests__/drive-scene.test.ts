import { expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { ROLE } from '@/play/arcade/contract';
import { chaserModel, enemyModel, heroModel, propModels } from '@/play/arcade/models';
import { driveSpec } from '@/play/compose/drive';
import { modelIdOf } from '../../World';
import { chaserSpot } from '../../track-camera';
import { placeChase } from '../SteerScene';

it('draws the native drive participants and turbo from their role labels', () => {
  const made = driveSpec({ move: 'drive', actions: ['shoot'], objective: 'race', threats: ['chaser'] },
    { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city', cast: [{ label: 'zombie', does: 'shoot_at' }, { label: 'police car', does: 'chase_me' }, { label: 'truck', does: 'fight' }] });
  const spec = { ...made, roles: made.roles.map(role => role.id === 'turbo' ? { ...role, label: 'battery' } : role) };
  const cast = { player: heroModel(spec), enemy: enemyModel(spec), chaser: chaserModel(spec), props: propModels(spec) };
  for (const [kind, role, model] of [
    ['rival-car', ROLE.enemy, cast.props.rival], ['enemy', ROLE.enemy, cast.enemy],
    ['chaser', ROLE.chaser, cast.chaser], ['turbo', ROLE.collectible, cast.props.turbo],
  ] as const) {
    expect(model).toBeTruthy();
    expect(modelIdOf({ index: 1, kind, role, w: 2, h: 2, d: 2 }, cast)).toBe(model);
  }
  expect(cast.props.turbo).toBe('gen3d-battery');
});

it('leans the chase camera visually while preserving its forward view', () => {
  const camera = new PerspectiveCamera(55, 390 / 844, 0.1, 200);
  const look = new Vector3();
  placeChase(camera, look, 0, 20, 0);
  const centered = camera.quaternion.clone();
  placeChase(camera, look, 2, 20, 0);
  expect(camera.quaternion.equals(centered)).toBe(false);
  expect(camera.position.z).toBeLessThan(20);
  expect(look.z).toBeGreaterThan(20);
});

it('shows a distant drive pursuer but preserves its exact position near contact', () => {
  const hero = { x: 0, y: 0, z: 30 };
  expect(chaserSpot('steer', hero, { x: 2, y: 0, z: 10 }, 100, 0.46).spot.z).toBe(26);
  const close = { x: 1, y: 0, z: 28 };
  expect(chaserSpot('steer', hero, close, 100, 0.46).spot).toEqual(close);
});
