/**
 * Riggovaná postava z jednoho kusu (P36C T9): slitá postava musí v každé póze stát
 * tam, kde stály její díly. Meč o kus vedle ruky nebo helma, která se s hlavou
 * neotočí, by na obrazovce vypadaly jen jako trochu jiný model.
 */

import { Bone, BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, type Object3D, Skeleton, SkinnedMesh, Uint16BufferAttribute, Float32BufferAttribute, Vector3 } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it } from 'vitest';

import { mergeRig } from '../look/load';

const skin = new MeshStandardMaterial({ color: '#888888' });
const other = new MeshStandardMaterial({ color: '#444444' });

/** Kostra boky → ruka, dvě riggované sítě (jedna posunutá, s vlastní `bindMatrix`) a meč, štít a helma na kostech. */
function rig(): Group {
  const root = new Group();
  const armature = new Group();
  armature.position.set(0, 0.2, 0);
  armature.scale.setScalar(1.5);
  const hips = new Bone();
  hips.name = 'hips';
  hips.position.set(0, 1, 0);
  const hand = new Bone();
  hand.name = 'hand';
  hand.position.set(0.6, 0.3, 0);
  hips.add(hand);
  armature.add(hips);
  root.add(armature);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton([hips, hand]);
  const skinned = (offset: number): SkinnedMesh => {
    const geometry = new BoxGeometry(0.5, 1, 0.3, 2, 3, 1);
    const count = geometry.getAttribute('position').count;
    const index = new Uint16Array(count * 4);
    const weight = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      const up = geometry.getAttribute('position').getY(i) > 0 ? 0.7 : 0.2;
      index.set([0, 1, 0, 0], i * 4);
      weight.set([1 - up, up, 0, 0], i * 4);
    }
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weight, 4));
    const mesh = new SkinnedMesh(geometry, skin);
    mesh.position.set(offset, 0.5, 0);
    armature.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(new Skeleton(skeleton.bones, skeleton.boneInverses), mesh.matrixWorld);
    return mesh;
  };
  skinned(0);
  skinned(0.4);
  const sword = new Mesh(new BoxGeometry(0.1, 1.2, 0.1), skin);
  sword.position.set(0.1, 0.5, 0);
  sword.rotation.set(0, 0, 0.3);
  hand.add(sword);
  const holder = new Group();
  holder.position.set(0, 0, 0.2);
  hand.add(holder);
  const shield = new Mesh(new BoxGeometry(0.6, 0.6, 0.05), skin);
  holder.add(shield);
  const helmet = new Mesh(new BoxGeometry(0.4, 0.3, 0.4), skin);
  helmet.position.set(0, 0.6, 0);
  hips.add(helmet);
  // GLB nezaručuje, že model přijde v póze vazby: klidová póza kostí je jiná než `boneInverses`.
  hand.position.set(0.7, 0.25, 0.1);
  hips.rotation.set(0, 0.4, 0);
  root.updateMatrixWorld(true);
  return root;
}

function pose(root: Object3D, turn: number): void {
  root.position.set(2, 0, -1);
  root.rotation.y = turn;
  root.getObjectByName('hips')!.rotation.set(0.2, turn, 0.1);
  root.getObjectByName('hand')!.rotation.set(-0.8, 0.3, turn);
  root.updateMatrixWorld(true);
}

/** Vrcholy všech sítí ve světě, zaokrouhlené a seřazené – pořadí dílů po slití se mění. */
function worldVertices(root: Object3D): string[] {
  const out: string[] = [];
  const at = new Vector3();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    for (let i = 0; i < mesh.geometry.getAttribute('position').count; i += 1) {
      mesh.getVertexPosition(i, at).applyMatrix4(mesh.matrixWorld);
      out.push(`${at.x.toFixed(3)},${at.y.toFixed(3)},${at.z.toFixed(3)}`);
    }
  });
  return out.sort();
}

const meshes = (root: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((node) => {
    if ((node as Mesh).isMesh) out.push(node as Mesh);
  });
  return out;
};

describe('mergeRig', () => {
  it('draws the rigged body, its weapons and its helmet as one skinned mesh', () => {
    const merged = mergeRig(rig());
    const left = meshes(merged);
    expect(left).toHaveLength(1);
    expect((left[0] as SkinnedMesh).isSkinnedMesh).toBe(true);
  });

  it('keeps every vertex where the parts drew it, in any pose and on a clone', () => {
    for (const turn of [0, 0.7, -1.9]) {
      const parts = rig();
      const one = cloneSkinned(mergeRig(rig()));
      pose(parts, turn);
      pose(one, turn);
      expect(worldVertices(one)).toEqual(worldVertices(parts));
    }
  });

  it('leaves alone a part with another material, a hidden part and a model without a skeleton', () => {
    const model = rig();
    const hidden = new Mesh(new BoxGeometry(1, 1, 1), skin);
    hidden.visible = false;
    model.getObjectByName('hand')!.add(hidden, new Mesh(new BoxGeometry(1, 1, 1), other));
    expect(meshes(mergeRig(model))).toHaveLength(3);
    const pet = new Group().add(new Mesh(new BoxGeometry(1, 1, 1), skin), new Mesh(new BoxGeometry(1, 1, 1), skin));
    expect(meshes(mergeRig(pet))).toHaveLength(2);
  });

  it('gives the merged body an identity bind so only the bones place it', () => {
    const merged = meshes(mergeRig(rig()))[0] as SkinnedMesh;
    expect(merged.bindMatrix.equals(new Matrix4())).toBe(true);
  });
});
