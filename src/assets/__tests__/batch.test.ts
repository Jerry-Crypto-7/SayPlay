import { expect, it } from 'vitest';
import { Box3, Group, Mesh, BoxGeometry, MeshStandardMaterial, Vector3 } from 'three';
import { batchStaticAsset } from '../batch';
import { disposeSubtree } from '@/components/viewer/dispose';

it('reduces draws while preserving bounds, named transforms, transparent order and movable parts', () => {
  const root=new Group(), solid=new MeshStandardMaterial(), glass=new MeshStandardMaterial({transparent:true,opacity:.3});
  const first=new Mesh(new BoxGeometry(),solid);first.name='first';first.position.set(2,1,0);root.add(first);
  const second=new Mesh(new BoxGeometry(),solid);second.name='second';second.position.set(-2,2,0);second.scale.set(1,2,1);root.add(second);
  const pane=new Mesh(new BoxGeometry(),glass);pane.name='glass';root.add(pane);
  const leaf=new Group();leaf.name='leaf';leaf.position.set(0,0,3);root.add(leaf);
  const moving=new Mesh(new BoxGeometry(),solid);leaf.add(moving);
  const before=new Box3().setFromObject(root,true), expected=second.getWorldPosition(new Vector3());
  const result=batchStaticAsset(root,['leaf']);
  expect(result.removedDraws).toBe(1);
  const after=new Box3().setFromObject(root,true);expect(after.min.toArray()).toEqual(before.min.toArray());expect(after.max.toArray()).toEqual(before.max.toArray());
  expect(root.getObjectByName('second')!.getWorldPosition(new Vector3()).toArray()).toEqual(expected.toArray());
  expect(root.getObjectByName('glass')).toBe(pane);expect(leaf.children[0]).toBe(moving);
  leaf.rotation.y=1;root.updateMatrixWorld(true);expect(moving.parent).toBe(leaf);
  expect(result.geometryBytes).toBeGreaterThan(0);disposeSubtree(root);
});

it('does not invert mirrored winding or combine distinct material instances', () => {
  const root=new Group(),material=new MeshStandardMaterial();
  const a=new Mesh(new BoxGeometry(),material),b=new Mesh(new BoxGeometry(),material),c=new Mesh(new BoxGeometry(),material.clone());
  a.scale.x=-1;root.add(a,b,c);expect(batchStaticAsset(root).removedDraws).toBe(0);disposeSubtree(root);
});

it('bounds repeated-buffer expansion before cloning and keeps originals usable', () => {
  const root=new Group(),geometry=new BoxGeometry(),material=new MeshStandardMaterial();
  const a=new Mesh(geometry,material),b=new Mesh(geometry,material);root.add(a,b);
  expect(batchStaticAsset(root,[],1).removedDraws).toBe(0);
  expect(root.children).toEqual([a,b]);expect(a.geometry).toBe(b.geometry);disposeSubtree(root);
});
