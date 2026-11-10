/**
 * Inkoustový obrys (P36C T6). Obrys je na snímku vidět, ale tři věci by vypadaly
 * dobře a byly špatně: obal, který vyhlazením normál tiše přepíše ploché stínování
 * samotného modelu; riggovaná postava, jejíž obal stojí v klidové póze vedle
 * animovaného těla; obal přidaný při každém snímku znovu (volání kreslení rostou
 * bez konce, oko si všimne až propadu FPS); a sonda záběru, která kostmi přepočítá
 * i vrcholy obalu (na startovní obrazovce každý snímek – rytíři 28 → 10 FPS).
 */

import {
  BackSide,
  Bone,
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  type ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  type Vector2,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { frameOf } from '../ArcadeStage';
import { INK_COLOR, INK_PX, inkCount, inkMeshes, outlinable, setInkViewport } from '../look/rig/InkOutline';

const hullsOf = (mesh: Mesh): Mesh[] => mesh.children.filter((child) => child.userData.ink !== undefined) as Mesh[];

describe('ink outline on the hero and foes (P36C T6)', () => {
  it('adds one back-faced hull per mesh, once, and casts no shadow', () => {
    const body = new Group();
    const torso = new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    const head = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial());
    torso.add(head);
    body.add(torso);
    expect(inkMeshes(body, 'hero')).toBe(2);
    expect(inkMeshes(body, 'hero')).toBe(0);
    expect(inkCount(body)).toBe(2);
    for (const mesh of [torso, head]) {
      const [hull] = hullsOf(mesh);
      expect(hullsOf(mesh)).toHaveLength(1);
      expect((hull!.material as ShaderMaterial).side).toBe(BackSide);
      expect(hull!.castShadow).toBe(false);
      // Rig stínů (`ShadowFlags`) dá stín každé síti bez značky – obal by se kreslil i do stínové mapy.
      expect(hull!.userData.rigShadow).toBe('off');
      expect((hull!.material as ShaderMaterial).uniforms.inkColor!.value.getHex()).toBe(INK_COLOR.hero);
    }
  });

  it('the outlined body casts its shadow at once, the hull never does', () => {
    // Rig stínů označí novou síť jen každý 30. snímek; na pomalém telefonu stál hrdina
    // po dotažení modelu sekundy bez ostrého stínu (snímky P36C před/po).
    const hero = new Group();
    const body = new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    hero.add(body);
    inkMeshes(hero, 'hero');
    expect(body.castShadow).toBe(true);
    expect(body.receiveShadow).toBe(true);
    expect(body.userData.rigShadow).toBe('both');
    const [hull] = hullsOf(body);
    expect(hull!.castShadow).toBe(false);
    expect(hull!.userData.rigShadow).toBe('off');
    // Síť, kterou scéna označila sama (např. jen přijímá), obrys nepřepíše.
    const decal = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    decal.userData.rigShadow = 'receive';
    inkMeshes(decal, 'foe');
    expect(decal.castShadow).toBe(false);
  });

  it('foes get the threat colour, not the ink', () => {
    const foe = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    inkMeshes(foe, 'foe');
    const colour = (hullsOf(foe)[0]!.material as ShaderMaterial).uniforms.inkColor!.value.getHex();
    expect(colour).toBe(INK_COLOR.foe);
    expect(colour).not.toBe(INK_COLOR.hero);
  });

  // P75 T2: obrys modelíny je tmavý odstín povrchu; nepřítel drží rajčatovou, ta je jeho signál hrozby.
  it('a vertex-coloured hero takes a dark shade of its surface, a foe keeps the threat colour', () => {
    const tinted = (): Mesh => {
      const geometry = new BoxGeometry();
      geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(0.8), 3));
      return new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true }));
    };
    const hero = tinted();
    const foe = tinted();
    inkMeshes(hero, 'hero');
    inkMeshes(foe, 'foe');
    const heroInk = hullsOf(hero)[0]!.material as ShaderMaterial;
    const foeInk = hullsOf(foe)[0]!.material as ShaderMaterial;
    expect(heroInk.vertexColors).toBe(true);
    // P81 (směr mix): čtvrtina tónu povrchu, zbytek inkoust – dřív 0,7.
    expect(heroInk.uniforms.inkSurface!.value).toBeGreaterThan(0);
    expect(foeInk.uniforms.inkSurface!.value).toBe(0);
    expect(heroInk.fragmentShader).toMatch(/ink = mix\(inkColor, vColor\.rgb \* 0\.\d+, inkSurface\)/);
    // Textura bez barev ve vrcholech: inkoust, a vlastní materiál (jiný program než tónovaný).
    const plain = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    inkMeshes(plain, 'hero');
    expect((hullsOf(plain)[0]!.material as ShaderMaterial).vertexColors).toBe(false);
  });

  it('leaves the flat shading of a non-indexed model alone', () => {
    const flat = new BoxGeometry().toNonIndexed();
    flat.computeVertexNormals();
    const before = Array.from(flat.getAttribute('normal').array);
    const model = new Mesh(flat, new MeshStandardMaterial());
    inkMeshes(model, 'hero');
    expect(Array.from(flat.getAttribute('normal').array)).toEqual(before);
    // Obal má normály vyhlazené: roh krychle míří úhlopříčně, ne kolmo ke stěně.
    const smooth = hullsOf(model)[0]!.geometry.getAttribute('normal');
    expect(Math.max(Math.abs(smooth.getX(0)), Math.abs(smooth.getY(0)), Math.abs(smooth.getZ(0)))).toBeLessThan(0.95);
  });

  it('a rigged mesh gets a skinned hull on the same skeleton', () => {
    const bone = new Bone();
    const skinned = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
    skinned.add(bone);
    skinned.bind(new Skeleton([bone]));
    inkMeshes(skinned, 'hero');
    const hull = hullsOf(skinned)[0] as SkinnedMesh;
    expect(hull.isSkinnedMesh).toBe(true);
    expect(hull.skeleton).toBe(skinned.skeleton);
    expect(hull.bindMatrix.equals(skinned.bindMatrix)).toBe(true);
    // Sdílený materiál riggované a statické sítě nutí three přepínat program při každém kreslení.
    const still = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    inkMeshes(still, 'hero');
    expect(hullsOf(still)[0]!.material).not.toBe(hull.material);
  });

  it('the frame probe measures the body and never skins the hull', () => {
    const bone = new Bone();
    const geometry = new BoxGeometry(1, 2, 1);
    const vertices = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(vertices * 4), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(vertices * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const body = new SkinnedMesh(geometry, new MeshStandardMaterial());
    body.add(bone);
    body.bind(new Skeleton([bone]));
    body.position.z = -10;
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    body.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const bare = frameOf(body, camera, 400, 400);
    inkMeshes(body, 'hero');
    const hull = hullsOf(body)[0] as SkinnedMesh;
    const skin = vi.spyOn(hull, 'computeBoundingBox');
    body.updateMatrixWorld(true);
    expect(frameOf(body, camera, 400, 400)).toEqual(bare);
    expect(skin).not.toHaveBeenCalled();
  });

  it('keeps the line INK_PX CSS px wide whatever the canvas size', () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    inkMeshes(mesh, 'hero');
    setInkViewport(400, 800);
    const offset = (hullsOf(mesh)[0]!.material as ShaderMaterial).uniforms.inkOffset!.value as Vector2;
    expect(offset.x * (400 / 2)).toBeCloseTo(INK_PX);
    expect(offset.y * (800 / 2)).toBeCloseTo(INK_PX);
  });
});

describe('scenery outline goes on visible models only (P81 T5)', () => {
  const solid = (geometry = new BoxGeometry(1, 2, 1)) => new Mesh(geometry, new MeshStandardMaterial());

  it('outlines a solid prop, once, with ink and no shadow', () => {
    const prop = solid();
    expect(outlinable(prop)).toBe(true);
    expect(inkMeshes(prop, 'scenery')).toBe(1);
    expect(inkMeshes(prop, 'scenery')).toBe(0);
    expect(hullsOf(prop)[0]!.userData.rigShadow).toBe('off');
    expect(INK_COLOR.scenery).toBe(INK_COLOR.hero);
  });

  it('skips an invisible hitbox, a mask, a see-through mesh and shader-driven life', () => {
    const hitbox = solid();
    (hitbox.material as MeshStandardMaterial).visible = false;
    const mask = solid();
    (mask.material as MeshStandardMaterial).colorWrite = false;
    const glass = solid();
    (glass.material as MeshStandardMaterial).transparent = true;
    const life = solid();
    life.userData.rigShadow = 'none';
    for (const mesh of [hitbox, mask, glass, life]) expect(outlinable(mesh)).toBe(false);
  });

  it('skips ground and terrain, where the line would cost and never show', () => {
    const floor = solid(new BoxGeometry(20, 0.2, 20));
    const valley = solid();
    valley.userData.terrain = 'valley';
    expect(outlinable(floor)).toBe(false);
    expect(outlinable(valley)).toBe(false);
  });

  it('leaves a foe or obstacle body to its own outline colour', () => {
    const foe = new Group();
    foe.userData.inkOwner = 'foe';
    const body = solid();
    foe.add(new Group().add(body));
    expect(outlinable(body)).toBe(false);
  });

  it('outlines only the prop itself, not a nested see-through child', () => {
    const prop = solid();
    const glass = solid();
    (glass.material as MeshStandardMaterial).transparent = true;
    prop.add(glass);
    expect(inkMeshes(prop, 'scenery')).toBe(1);
    expect(hullsOf(glass)).toHaveLength(0);
  });
});
