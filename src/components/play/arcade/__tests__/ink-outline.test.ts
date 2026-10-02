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
import { INK_COLOR, INK_PX, inkCount, inkMeshes, setInkViewport } from '../look/rig/InkOutline';

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
      expect((hull!.material as ShaderMaterial).uniforms.color!.value.getHex()).toBe(INK_COLOR.hero);
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
    const colour = (hullsOf(foe)[0]!.material as ShaderMaterial).uniforms.color!.value.getHex();
    expect(colour).toBe(INK_COLOR.foe);
    expect(colour).not.toBe(INK_COLOR.hero);
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

  it('keeps the line 2.5 CSS px wide whatever the canvas size', () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    inkMeshes(mesh, 'hero');
    setInkViewport(400, 800);
    const offset = (hullsOf(mesh)[0]!.material as ShaderMaterial).uniforms.inkOffset!.value as Vector2;
    expect(offset.x * (400 / 2)).toBeCloseTo(INK_PX);
    expect(offset.y * (800 / 2)).toBeCloseTo(INK_PX);
  });
});
