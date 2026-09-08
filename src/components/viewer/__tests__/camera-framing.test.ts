/**
 * Obal scény, ze kterého se počítá statické rámování.
 *
 * **Tenhle test existuje kvůli naměřené vadě, ne pro pořádek.** První běh P14
 * T8 (28. 8. 2026) počítal do obalu i prach, který zabírá 80 × 22 × 60 jednotek.
 * Kamera odjela na desítky jednotek a všech šest ručních layoutů se scvrklo na
 * tečku: mrtvá plocha z 0,28 na 0,88, silueta z 0,18 na 0,012. Kontaktní list
 * přitom **prošel** — jeho aserce hlídají rozdílnost světů, a šest stejně
 * pokažených světů je pořád šest různých otisků.
 *
 * Vada tedy neměla jediného soudce. Tady ho má.
 */

import { describe, expect, it } from 'vitest';

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, SphereGeometry } from 'three';

import { ATMOSPHERE_PREFIX, MOTES_NAME, SKY_NAME, WATER_NAME } from '../Atmosphere';
import { sceneBounds } from '../FollowCamera';

const MATERIAL = new MeshBasicMaterial();

function box(name: string, size: number, at = 0): Mesh {
  const mesh = new Mesh(new BoxGeometry(size, size, size), MATERIAL);
  mesh.name = name;
  mesh.position.set(at, 0, 0);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function scene(...children: readonly Object3D[]): Object3D {
  const root = new Group();
  for (const child of children) root.add(child);
  root.updateMatrixWorld(true);
  return root;
}

describe('sceneBounds', () => {
  it('měří geometrii světa', () => {
    const bounds = sceneBounds(scene(box('world', 4)));

    expect(bounds).not.toBeNull();
    expect(bounds!.min.x).toBeCloseTo(-2, 6);
    expect(bounds!.max.x).toBeCloseTo(2, 6);
  });

  it('vynechá celou atmosférickou vrstvu, ne jen oblohu a vodu', () => {
    const world = box('world', 4);
    const sky = new Mesh(new SphereGeometry(180, 8, 6), MATERIAL);
    sky.name = SKY_NAME;
    const water = box(WATER_NAME, 600);
    const motes = box(MOTES_NAME, 80);
    const anything = box(`${ATMOSPHERE_PREFIX}whatever-comes-next`, 500);

    const withAtmosphere = sceneBounds(scene(world, sky, water, motes, anything));
    const alone = sceneBounds(scene(box('world', 4)));

    expect(withAtmosphere).not.toBeNull();
    // Ta poslední položka je tam schválně: pravidlo je předpona, ne seznam
    // jmen. Kdyby se vynechávalo výčtem, projde tenhle test jen do chvíle, než
    // někdo přidá šestou vrstvu — a to je přesně, jak vada vznikla.
    expect(withAtmosphere!.min.x).toBeCloseTo(alone!.min.x, 6);
    expect(withAtmosphere!.max.x).toBeCloseTo(alone!.max.x, 6);
    expect(withAtmosphere!.max.y).toBeCloseTo(2, 6);
  });

  it('scéna, ve které stojí jen atmosféra, nemá obal', () => {
    expect(sceneBounds(scene(box(SKY_NAME, 180), box(MOTES_NAME, 80)))).toBeNull();
  });

  it('prázdná scéna nemá obal', () => {
    expect(sceneBounds(scene())).toBeNull();
  });

  it('spojí víc kusů světa do jednoho obalu', () => {
    const bounds = sceneBounds(scene(box('a', 2, -10), box('b', 2, 10)));

    expect(bounds!.min.x).toBeCloseTo(-11, 6);
    expect(bounds!.max.x).toBeCloseTo(11, 6);
  });
});
