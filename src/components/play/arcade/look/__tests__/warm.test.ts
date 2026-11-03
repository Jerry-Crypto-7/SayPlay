/**
 * Odložená práce směny na telefonu (P68-M T1): model obchodu, který doběhne po prvním snímku, se skryje, dokud nemá
 * přeložený program (`Warm`), a volný slot zákazníka si nepřepočítává matice kostí (`updateWhenShown`). Obojí jde
 * vidět jen jako čas, ne jako obraz – test pinuje, že výměna náhradního dílu za model se pozná a první obsah ne, že se
 * skryje jen díl bez programu, že slot, který se ukáže, má matice dětí složené v tomtéž renderu (žádný snímek se
 * starou pózou) a kdy je postava pro animaci skrytá.
 */

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { shownInWorld } from '../../RiggedModel';
import { contentChanged, hasColdMaterial, updateWhenShown } from '../warm';

const box = (): Mesh => new Mesh(new BoxGeometry(), new MeshBasicMaterial());

describe('contentChanged', () => {
  it('reports the first content, then only a swap of a child or grandchild', () => {
    const root = new Group();
    const fallback = box();
    root.add(fallback);
    const seen: Object3D[] = [];
    expect(contentChanged(root, seen)).toBe(true);
    expect(contentChanged(root, seen)).toBe(false);

    root.remove(fallback);
    const model = new Group();
    model.add(box());
    root.add(model);
    expect(contentChanged(root, seen)).toBe(true);
    expect(contentChanged(root, seen)).toBe(false);

    model.add(box());
    expect(contentChanged(root, seen)).toBe(true);
  });
});

describe('hasColdMaterial', () => {
  it('is cold while any mesh material has no program, warm once all have one', () => {
    const root = new Group();
    const a = box();
    const b = box();
    root.add(a, new Group().add(b));
    const programs = new Map<unknown, { currentProgram?: unknown }>();
    const gl = { properties: { get: (material: unknown) => programs.get(material) ?? {} } } as unknown as Parameters<typeof hasColdMaterial>[0];

    expect(hasColdMaterial(gl, root)).toBe(true);
    programs.set(a.material, { currentProgram: {} });
    expect(hasColdMaterial(gl, root)).toBe(true);
    programs.set(b.material, { currentProgram: {} });
    expect(hasColdMaterial(gl, root)).toBe(false);
  });
});

describe('updateWhenShown', () => {
  it('skips a hidden slot and composes its children in the same update once shown', () => {
    const scene = new Group();
    const slot = new Group();
    slot.updateMatrixWorld = updateWhenShown;
    const bone = new Object3D();
    slot.add(bone);
    scene.add(slot);
    slot.visible = false;

    slot.position.set(3, 0, 0);
    bone.position.set(0, 2, 0);
    scene.updateMatrixWorld();
    expect(bone.matrixWorld.elements[12]).toBe(0);
    expect(bone.matrixWorld.elements[13]).toBe(0);

    slot.visible = true;
    scene.updateMatrixWorld();
    expect(bone.matrixWorld.elements[12]).toBe(3);
    expect(bone.matrixWorld.elements[13]).toBe(2);
  });
});

describe('shownInWorld', () => {
  it('is false when the node or any ancestor is hidden', () => {
    const slot = new Group();
    const inner = new Group();
    const holder = new Group();
    slot.add(inner.add(holder));
    expect(shownInWorld(holder)).toBe(true);
    slot.visible = false;
    expect(shownInWorld(holder)).toBe(false);
    slot.visible = true;
    holder.visible = false;
    expect(shownInWorld(holder)).toBe(false);
    expect(shownInWorld(null)).toBe(false);
  });
});
