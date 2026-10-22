/**
 * Deformace vrcholů (P45D T6). Shader, který se zkompiluje, ale ohne trup místo
 * křídla, klon materiálu s vlastním klíčem programu (kompilace na každé tělo,
 * zásek při spawnu) a obrys, který se neohne a uteče od křídla, by všechny
 * prošly testem „uniforma existuje“ – tady se pinují.
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type ShaderMaterial, ShaderLib, SphereGeometry, Texture, type Vector2, Vector3, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';

import { mergeBody } from '../load';
import { inkMeshes, setInkViewport } from '../rig/InkOutline';
import { deformBody, deformPoint, type ToyUniforms } from '../toy-deform';

function coin(): Group {
  const model = new Group();
  model.position.set(0.5, 0, 0);
  const rim = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshStandardMaterial({ color: '#e2b33c', roughness: 0.3, metalness: 0.9 }));
  rim.position.set(0, 1, 0);
  const face = new Mesh(new SphereGeometry(0.4, 8, 6), new MeshStandardMaterial({ color: '#ffd84a', roughness: 0.4, metalness: 0 }));
  face.position.set(0, 2, 0.3);
  model.add(rim, face);
  return model;
}

const physical = () => ({ vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, unknown> });
const uniformsOf = (mesh: Mesh): ToyUniforms => (mesh.material as MeshStandardMaterial).userData.toyDeform as ToyUniforms;

describe('deformPoint', () => {
  // midX 0, křídla od |x| > 0,4, ocas za z < −0,25, nohy pod y < 0,2.
  const regions = new Vector4(0, 0.4, -0.25, 0.2);
  const rest = { flap: 0, sway: 0, stride: 0 };
  const moved = (point: Vector3, pose: typeof rest): number => deformPoint(point, regions, pose).distanceTo(point);

  it('leaves every vertex where it is at rest', () => {
    for (const point of [new Vector3(0.8, 0.5, 0), new Vector3(0, 0.5, -0.6), new Vector3(0.2, 0.05, 0), new Vector3(0, 0.5, 0)]) expect(moved(point, rest)).toBeLessThan(1e-12);
  });

  it('raises both wings when flapping and keeps the trunk still', () => {
    const flap = { ...rest, flap: 1 };
    const right = deformPoint(new Vector3(0.8, 0.5, 0), regions, flap);
    const left = deformPoint(new Vector3(-0.8, 0.5, 0), regions, flap);
    expect(right.y).toBeGreaterThan(0.6);
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(left.x).toBeCloseTo(-right.x, 6);
    expect(moved(new Vector3(0.3, 0.5, 0), flap)).toBe(0);
    expect(moved(new Vector3(-0.3, 0.5, 0), flap)).toBe(0);
  });

  it('swings the tail sideways and keeps the head still', () => {
    const sway = { ...rest, sway: 1 };
    expect(Math.abs(deformPoint(new Vector3(0, 0.5, -0.6), regions, sway).x)).toBeGreaterThan(0.1);
    expect(moved(new Vector3(0, 0.5, 0.4), sway)).toBe(0);
  });

  it('swings left and right legs opposite ways and keeps the body above them still', () => {
    const stride = { ...rest, stride: 1 };
    const right = deformPoint(new Vector3(0.2, 0, 0), regions, stride);
    const left = deformPoint(new Vector3(-0.2, 0, 0), regions, stride);
    expect(Math.abs(right.z)).toBeGreaterThan(0.05);
    expect(left.z).toBeCloseTo(-right.z, 6);
    expect(moved(new Vector3(0.2, 0.3, 0), stride)).toBe(0);
  });
});

describe('deformBody', () => {
  it('gives each body its own material and uniforms but the same shader program', () => {
    const merged = mergeBody(coin()) as Mesh;
    const a = merged.clone();
    const b = merged.clone();
    const poseA = deformBody(a, { legY: 1 })!;
    const poseB = deformBody(b, { legY: 1 })!;
    expect(a.material).not.toBe(b.material);
    expect(a.material).not.toBe(merged.material);
    expect((a.material as MeshStandardMaterial).customProgramCacheKey()).toBe((b.material as MeshStandardMaterial).customProgramCacheKey());
    expect((a.material as MeshStandardMaterial).customProgramCacheKey()).toBe('arcade-body+toon+toy');
    expect(poseA.toyFlap).not.toBe(poseB.toyFlap);
    expect(uniformsOf(a).toyFlap).toBe(poseA.toyFlap);
  });

  it('compiles the deformation into the merged body shader with its pose uniforms', () => {
    const body = mergeBody(coin()) as Mesh;
    const pose = deformBody(body, { midX: 0, wingX: 0.3, legY: 1 })!;
    const shader = physical();
    (body.material as MeshStandardMaterial).onBeforeCompile(shader as never, undefined as never);
    for (const name of ['toyFlap', 'toySway', 'toyStride']) expect(shader.vertexShader).toContain(`uniform float ${name};`);
    expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s*transformed = toyDeform\(transformed\);/);
    // Úprava slitého těla (drsnost, kov a záře z vrcholů) zůstala.
    expect(shader.vertexShader).toMatch(/vPbr = pbr;/);
    expect(shader.uniforms.toyFlap).toBe(pose.toyFlap);
    expect((shader.uniforms.toyRegions as { value: Vector4 }).value.toArray()).toEqual([0, 0.3, -1e6, 1]);
  });

  it('deforms a textured body merged per material, and a mesh off the model origin through its frame', () => {
    const model = coin();
    const textured = new MeshStandardMaterial({ map: new Texture() });
    for (const child of model.children) (child as Mesh).material = textured;
    const flat = mergeBody(model);
    expect(flat.children).toHaveLength(1);
    deformBody(flat, { tailZ: -0.2 });
    const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: {} as Record<string, unknown> };
    const copy = (flat.children[0] as Mesh).material as MeshStandardMaterial;
    expect(copy).not.toBe(textured);
    expect(copy.map).toBe(textured.map);
    copy.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain('transformed = toyDeform(transformed);');

    // Model, který zůstal, jak je: síť posunutá o 1 m nahoru nese převod do prostoru modelu.
    const loose = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ map: new Texture() }));
    mesh.position.set(0, 1, 0);
    loose.add(mesh);
    deformBody(loose, { legY: 0.5 });
    expect(new Vector3().setFromMatrixPosition(uniformsOf(mesh).toyFrame.value).toArray()).toEqual([0, 1, 0]);
  });

  it('takes the leg side from the model centre when the model has no wings', () => {
    const body = mergeBody(coin()) as Mesh;
    deformBody(body, { legY: 1 });
    expect(uniformsOf(body).toyRegions.value.x).toBeCloseTo(0.5, 6);
  });

  it('leaves a body without regions untouched', () => {
    const body = mergeBody(coin()) as Mesh;
    const material = body.material;
    expect(deformBody(body, undefined)).toBeUndefined();
    expect(body.material).toBe(material);
  });

  it('bends the ink outline with the body it outlines', () => {
    const body = mergeBody(coin()) as Mesh;
    const pose = deformBody(body, { midX: 0, wingX: 0.3 })!;
    const still = mergeBody(coin()) as Mesh;
    const root = new Group().add(body, still);
    inkMeshes(root, 'hero');
    const hull = body.children.find((child) => child.userData.ink !== undefined) as Mesh;
    const stillHull = still.children.find((child) => child.userData.ink !== undefined) as Mesh;
    const material = hull.material as ShaderMaterial;
    expect(material.vertexShader).toMatch(/#include <begin_vertex>\s*transformed = toyDeform\(transformed\);/);
    expect(material.uniforms.toyFlap).toBe(pose.toyFlap);
    expect(material.uniforms.toyFrame).toBe(uniformsOf(body).toyFrame);
    expect((stillHull.material as ShaderMaterial).vertexShader).not.toContain('toyDeform');
    // Posun obrysu z velikosti plátna platí i pro ohnutý obal.
    setInkViewport(500, 250);
    expect((material.uniforms.inkOffset!.value as Vector2).toArray()).toEqual([0.01, 0.02]);
  });
});
