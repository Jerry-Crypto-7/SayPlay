'use client';

/**
 * Díl scény směny, který se ukáže až s přeloženým programem shaderu (P68-M T1).
 *
 * Modely obchodu (pec, pult, police, kulisa, zboží, zákazník) doběhnou až po prvním snímku a three by program nového
 * materiálu přeložil v prvním snímku, který model kreslí: na Pixelu 7 (CPU ×4) stál takový snímek ~85 ms čekáním na
 * `getProgramInfoLog`, tři hned po startu – právě když hráč (i sonda času do hratelnosti) poprvé ťuká. Když se obsah
 * dílu vymění (náhradní kvádr → model), skupina se skryje, program se přeloží mimo hlavní vlákno
 * (`compileForComposer`, `KHR_parallel_shader_compile`) a díl se ukáže, až je hotový. Obsah, se kterým díl vznikl, se
 * kreslí hned: přeloží ho první snímek spolu s ostatními.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, useRef } from 'react';
import { type Group, type Material, type Mesh, Object3D, type WebGLRenderer } from 'three';

import { compileForComposer } from '../../../feed/StageHost';

/**
 * `updateMatrixWorld` slotu zákazníka: three jinak skládá matice celého podstromu každý snímek, i neviditelného – volný
 * slot je riggovaná postava s desítkami kostí a slotů je 12 (P68-M T1, cena snímku na telefonu). Slot, který se
 * ukáže, si v tomtéž renderu matici složí a změnu předá dětem.
 */
export function updateWhenShown(this: Object3D, force?: boolean): void {
  if (this.visible) Object3D.prototype.updateMatrixWorld.call(this, force);
}

/** Zapíše do `seen` děti a vnoučata skupiny a řekne, jestli se od minula změnily (výměna náhradního dílu za model). */
export function contentChanged(root: Object3D, seen: Object3D[]): boolean {
  let i = 0;
  let changed = false;
  const visit = (node: Object3D): void => {
    if (seen[i] !== node) {
      seen[i] = node;
      changed = true;
    }
    i += 1;
  };
  for (const child of root.children) {
    visit(child);
    for (const grandchild of child.children) visit(grandchild);
  }
  if (seen.length !== i) {
    seen.length = i;
    changed = true;
  }
  return changed;
}

/** Má podstrom materiál, pro který three ještě nemá program? */
export function hasColdMaterial(gl: Pick<WebGLRenderer, 'properties'>, root: Object3D): boolean {
  let cold = false;
  root.traverse((node) => {
    const material = (node as Mesh).material as Material | Material[] | undefined;
    if (cold || (node as Mesh).isMesh !== true || material === undefined) return;
    for (const one of Array.isArray(material) ? material : [material]) {
      if ((gl.properties.get(one) as { currentProgram?: unknown }).currentProgram === undefined) cold = true;
    }
  });
  return cold;
}

export function Warm({ children }: { readonly children: ReactNode }) {
  const group = useRef<Group | null>(null);
  const get = useThree((three) => three.get);
  const memory = useRef({ seen: [] as Object3D[], warming: false, first: true });
  useFrame(() => {
    const root = group.current;
    const known = memory.current;
    if (root === null || known.warming || !contentChanged(root, known.seen)) return;
    if (known.first) {
      known.first = false;
      return;
    }
    const three = get();
    if (!hasColdMaterial(three.gl, root)) return;
    root.visible = false;
    known.warming = true;
    void compileForComposer(three, root).then(() => {
      known.warming = false;
      root.visible = true;
    });
  });
  return <group ref={group}>{children}</group>;
}
