/**
 * Tělo z jednoho kusu (P32A T2-R1): sítě těla se slijí do jedné a materiál se
 * rozepíše do vrcholů. Posunutá geometrie, prohozená barva nebo shader, do
 * kterého se drsnost tiše nevloží (přejmenovaný chunk three), by na obrazovce
 * vypadaly jen jako trochu jiný model.
 */

import { BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, ShaderLib, SphereGeometry, Texture, Vector3 } from 'three';
import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';

import motion from '@/assets/catalog-motion.json';

import { bodyFor, glowingCopy, MAX_PARTS, mergeBody, singlePass, toyPartsOf } from '../look/load';
import { motionOf } from '../toy/body-class';

function coin(): Group {
  const model = new Group();
  model.position.set(0.5, 0, 0);
  const rim = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshStandardMaterial({ color: '#e2b33c', roughness: 0.3, metalness: 0.9 }));
  rim.position.set(0, 1, 0);
  const face = new Mesh(new SphereGeometry(0.4, 8, 6), new MeshStandardMaterial({ color: '#ffd84a', emissive: '#ffd84a', emissiveIntensity: 0.5, roughness: 0.4, metalness: 0 }));
  face.position.set(0, 2, 0.3);
  face.scale.setScalar(2);
  model.add(rim, face);
  return model;
}

const firstVertexOf = (mesh: Mesh, attribute: string, count: number): number[] => Array.from({ length: count }, (_, i) => mesh.geometry.getAttribute(attribute).array[i] as number);

describe('mergeBody', () => {
  it('draws the whole body as one mesh in the same place', () => {
    const model = coin();
    const before = new Box3().setFromObject(model);
    const merged = mergeBody(model) as Mesh;
    expect(merged.isMesh).toBe(true);
    expect(merged.children).toHaveLength(0);
    const after = new Box3().setFromObject(merged);
    expect(after.min.distanceTo(before.min)).toBeLessThan(1e-5);
    expect(after.max.distanceTo(before.max)).toBeLessThan(1e-5);
  });

  it('carries each part’s colour, roughness, metalness and glow into its vertices', () => {
    const model = coin();
    const [rim, face] = model.children as Mesh[];
    const merged = mergeBody(model) as Mesh;
    const rimColor = (rim!.material as MeshStandardMaterial).color;
    expect(firstVertexOf(merged, 'color', 3)).toEqual([rimColor.r, rimColor.g, rimColor.b].map((v) => Math.fround(v)));
    expect(firstVertexOf(merged, 'pbr', 2)).toEqual([Math.fround(0.3), Math.fround(0.9)]);
    expect(firstVertexOf(merged, 'glow', 3)).toEqual([0, 0, 0]);
    // Tvář začíná za vrcholy obruby; záře = emise × intenzita.
    const start = rim!.geometry.toNonIndexed().getAttribute('position').count;
    const glow = merged.geometry.getAttribute('glow');
    const emissive = (face!.material as MeshStandardMaterial).emissive;
    expect([glow.getX(start), glow.getY(start), glow.getZ(start)]).toEqual([emissive.r, emissive.g, emissive.b].map((v) => Math.fround(v * 0.5)));
    expect(merged.geometry.getAttribute('pbr').getX(start)).toBeCloseTo(0.4, 6);
  });

  it('shares one material across bodies so every body draws with one program', () => {
    const a = mergeBody(coin()) as Mesh;
    const b = mergeBody(coin()) as Mesh;
    expect(a.material).toBe(b.material);
    expect((a.material as MeshStandardMaterial).vertexColors).toBe(true);
  });

  it('patches roughness, metalness and glow into the three standard shader', () => {
    const material = (mergeBody(coin()) as Mesh).material as MeshStandardMaterial;
    const shader = { vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader, uniforms: {} };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain('attribute vec2 pbr;');
    expect(shader.vertexShader).toMatch(/#include <color_vertex>\s*vPbr = pbr;\s*vGlow = glow;/);
    expect(shader.fragmentShader).toMatch(/#include <roughnessmap_fragment>\s*roughnessFactor \*= vPbr\.x;/);
    expect(shader.fragmentShader).toMatch(/#include <metalnessmap_fragment>\s*metalnessFactor \*= vPbr\.y;/);
    expect(shader.fragmentShader).toMatch(/#include <emissivemap_fragment>\s*totalEmissiveRadiance \+= vGlow;/);
  });

  it('leaves a model it cannot fold into vertices as it is', () => {
    const textured = coin();
    ((textured.children[0] as Mesh).material as MeshStandardMaterial).map = new Texture();
    expect(mergeBody(textured)).toBe(textured);

    const see = coin();
    ((see.children[1] as Mesh).material as MeshStandardMaterial).transparent = true;
    expect(mergeBody(see)).toBe(see);

    const basic = coin();
    (basic.children[0] as Mesh).material = new MeshBasicMaterial();
    expect(mergeBody(basic)).toBe(basic);

    const mixedSides = coin();
    ((mixedSides.children[0] as Mesh).material as MeshStandardMaterial).side = DoubleSide;
    expect(mergeBody(mixedSides)).toBe(mixedSides);
  });

  it('merges a body with glass per material instead of leaving every part apart (P35 T4)', () => {
    const model = coin();
    const glass = new MeshStandardMaterial({ color: '#bfe8ff', transparent: true, opacity: 0.3 });
    for (const x of [-1, 1]) {
      const pane = new Mesh(new BoxGeometry(0.05, 1, 1), glass);
      pane.position.set(x, 1, 0);
      model.add(pane);
    }
    const rim = (model.children[0] as Mesh).material;
    const before = new Box3().setFromObject(model);
    const merged = mergeBody(model);
    // Obruba, tvář a jedno sklo za obě tabule – každé se svým materiálem.
    expect(merged.children).toHaveLength(3);
    const materials = merged.children.map((child) => (child as Mesh).material);
    expect(materials).toContain(glass);
    expect(materials).toContain(rim);
    const after = new Box3().setFromObject(merged);
    expect(after.min.distanceTo(before.min)).toBeLessThan(1e-5);
    expect(after.max.distanceTo(before.max)).toBeLessThan(1e-5);
  });

  it('draws see-through double-sided parts in one pass, so three does not re-judge their program every draw (P35 T4)', () => {
    const model = coin();
    const glass = new MeshStandardMaterial({ transparent: true, opacity: 0.3, side: DoubleSide });
    const thinGlass = new MeshStandardMaterial({ transparent: true, opacity: 0.3 });
    const solid = new MeshStandardMaterial({ side: DoubleSide });
    model.add(new Mesh(new BoxGeometry(1, 1, 1), glass), new Mesh(new BoxGeometry(1, 1, 1), thinGlass), new Mesh(new BoxGeometry(1, 1, 1), solid));
    singlePass(model);
    expect(glass.forceSinglePass).toBe(true);
    expect(thinGlass.forceSinglePass).toBe(false);
    expect(solid.forceSinglePass).toBe(false);
  });

  it('keeps a double-sided body double-sided', () => {
    const model = coin();
    for (const child of model.children) ((child as Mesh).material as MeshStandardMaterial).side = DoubleSide;
    const merged = mergeBody(model) as Mesh;
    expect((merged.material as MeshStandardMaterial).side).toBe(DoubleSide);
    expect(new Box3().setFromObject(merged).getSize(new Vector3()).y).toBeGreaterThan(0);
  });
});

/**
 * Tělo, které se hýbe (P45D T6): díly s rolí se vyčlení pod pivot, ostatní
 * zůstává jedna síť. Díl s pivotem jinde než v kloubu by dveře při otevření
 * odletěly; tělo s pěti sítěmi by rozbilo rozpočet arény (≤ 200 sítí).
 */
describe('posed bodies', () => {
  const meshesOf = (root: Object3D): number => {
    let count = 0;
    root.traverse((node) => {
      if ((node as Mesh).isMesh) count += 1;
    });
    return count;
  };
  const plain = (color: string) => new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0 });

  /** Rám a křídlo dveří; křídlo visí v pivotu katalogu a sahá do +x. */
  function panelDoor(): Group {
    const model = new Group();
    const frame = new Mesh(new BoxGeometry(1, 2.1, 0.1), plain('#8a6a4a'));
    frame.position.set(0, 1.05, 0);
    const leaf = new Mesh(new BoxGeometry(0.94, 2, 0.05).translate(0.47, 1, 0), plain('#c9a27a'));
    leaf.name = 'door-leaf';
    leaf.position.set(-0.47, 0, 0);
    model.add(frame, leaf);
    return model;
  }

  it('keeps a coin, an obstacle and a body that does not move one mesh', () => {
    expect(meshesOf(bodyFor(coin(), 'coin', true))).toBe(1);
    expect(meshesOf(bodyFor(coin(), 'cone', true))).toBe(1);
    expect(meshesOf(bodyFor(panelDoor(), 'panel-door', false))).toBe(1);
  });

  it('lifts the door leaf out under a pivot at its hinge, the rest stays one mesh', () => {
    const model = panelDoor();
    const before = new Box3().setFromObject(model);
    const body = bodyFor(model, 'panel-door', true);
    expect(meshesOf(body)).toBe(2);
    expect(new Box3().setFromObject(body).min.distanceTo(before.min)).toBeLessThan(1e-5);
    expect(new Box3().setFromObject(body).max.distanceTo(before.max)).toBeLessThan(1e-5);
    // Sdílený model zůstal celý (cache `loadModel`).
    expect(model.getObjectByName('door-leaf')).toBeDefined();

    const [part, ...more] = toyPartsOf(body);
    expect(more).toHaveLength(0);
    expect(part!.role).toBe('door');
    expect(part!.side).toBe(-1);
    expect(part!.pivot.position.toArray()).toEqual([-0.47, 0, 0]);
    // Otevřené křídlo se točí kolem kloubu: hrana u pivotu stojí, volná hrana opíše čtvrtkruh.
    part!.pivot.rotation.y = Math.PI / 2;
    const open = new Box3().setFromObject(part!.pivot);
    expect(open.min.x).toBeCloseTo(-0.47 - 0.025, 3);
    expect(open.max.x).toBeCloseTo(-0.47 + 0.025, 3);
    expect(open.min.z).toBeCloseTo(-0.94, 3);
  });

  it(`never draws a posed body with more than ${1 + MAX_PARTS} meshes`, () => {
    const listed = Object.keys(motion.models).flatMap((id) => {
      const parts = motionOf(id)?.parts;
      return parts === undefined ? [] : [{ id, parts }];
    });
    expect(listed.length).toBeGreaterThan(10);
    for (const { id, parts } of listed) {
      const model = new Group().add(new Mesh(new BoxGeometry(1, 1, 1), plain('#777777')));
      for (const part of parts) {
        const node = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), plain('#999999'));
        node.name = part.node;
        node.position.set(...part.pivot);
        model.add(node);
      }
      const meshes = meshesOf(bodyFor(model, id, true));
      expect(meshes, id).toBeLessThanOrEqual(1 + MAX_PARTS);
      expect(meshes, id).toBe(1 + Math.min(MAX_PARTS, new Set(parts.map((part) => part.node)).size));
    }
    expect(motionOf('bar-stool')!.parts!.length).toBeGreaterThan(MAX_PARTS);
  });
});

/**
 * Věc arény září (P35 T8): kopie slitého těla bez úpravy shaderu kreslila bílou
 * barvu materiálu a zářila bíle – zlaté rybky kočky byly na snímku bílé fleky.
 */
describe('glowingCopy', () => {
  const physical = () => ({ vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader, uniforms: {} });

  it('lets a merged body glow in its own vertex colours, not white', () => {
    const body = (mergeBody(coin()) as Mesh).material as MeshStandardMaterial;
    const glow = glowingCopy(body, 2.4) as MeshStandardMaterial;
    expect(glow.vertexColors).toBe(true);
    // Záře = bílá × intenzita × barva vrcholu (odstín modelu), k ní vlastní záře částí.
    expect(glow.emissive.getHex()).toBe(0xffffff);
    expect(glow.emissiveIntensity).toBe(2.4);
    const shader = physical();
    glow.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toMatch(/metalnessFactor \*= vPbr\.y;/);
    expect(shader.fragmentShader).toMatch(/#include <emissivemap_fragment>\s*totalEmissiveRadiance \*= vColor\.rgb;\s*totalEmissiveRadiance \+= vGlow;/);
    // Jiný program než nezářící tělo – stejný klíč by three vrátil program bez násobení barvou.
    expect(glow.customProgramCacheKey()).not.toBe(body.customProgramCacheKey());
    const plain = physical();
    body.onBeforeCompile(plain as never, undefined as never);
    expect(plain.fragmentShader).not.toContain('vColor.rgb;');
  });

  it('lets a model it did not merge glow in its vertex colours, like the goldfish (COLOR_0 under a white material)', () => {
    const fish = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    expect(mergeBody(new Group().add(new Mesh(new BoxGeometry(1, 1, 1), fish)))).not.toBeInstanceOf(Mesh);
    const glow = glowingCopy(fish, 2.4) as MeshStandardMaterial;
    const shader = physical();
    glow.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toMatch(/#include <emissivemap_fragment>\s*totalEmissiveRadiance \*= vColor\.rgb;/);
    expect(glow.customProgramCacheKey()).not.toBe(fish.customProgramCacheKey());
  });

  it('lets a model it did not merge glow in its material colour', () => {
    const material = new MeshStandardMaterial({ color: '#f08a24' });
    const glow = glowingCopy(material, 2.4) as MeshStandardMaterial;
    expect(glow.emissive.getHex()).toBe(material.color.getHex());
    expect(glow.emissiveIntensity).toBe(2.4);
    expect(material.emissive.getHex()).toBe(0);
    const shader = physical();
    glow.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).not.toContain('vColor.rgb;');
  });
});
