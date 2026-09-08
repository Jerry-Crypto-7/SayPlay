/**
 * **Materializace: rozvrh odhalení a krytí** (P15 T20).
 *
 * Rozvrh je čistá funkce, takže se soudí tady a bez plátna — stejné dělení
 * jako u `Assembly`. To, co se bez prohlížeče dokázat nedá (že crossfade
 * doopravdy proběhne v rendereru a skončí jedinou podobou ve slotu), měří
 * `e2e/worldstream-hot-swap.spec.ts`.
 *
 * Dvě věci tu vypadají jako detail a nejsou:
 *
 * 1. **Mimo prohlížeč nesmí rozvrh spadnout na „hned".** `prefersReducedMotion()`
 *    vrací mimo DOM `false`, takže výchozí rozvrh je plnohodnotný. Kdyby to
 *    bylo naopak, byl by každý serverový render a každý test tiše bez odhalení
 *    — a chyběl by právě tam, kde se hledá.
 * 2. **Hotové odhalení musí `transparent` zase vypnout.** Průhledný materiál se
 *    v three řadí jinak. Podoba, které by příznak zůstal, by se s okolím
 *    překrývala jinak než hlína, kterou nahradila — pop-in vyměněný za tichou
 *    vadu řazení.
 */

import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { MATERIALIZE_MS, applyReveal, createRevealPlan } from '../Materialize';

function subtree(): { root: Group; materials: MeshBasicMaterial[] } {
  const root = new Group();
  const materials: MeshBasicMaterial[] = [];

  const outer = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  materials.push(outer.material);

  // Potomek s **polem** materiálů: podoba z workeru je jeden mesh, ale kandidát
  // může být skupina, a `material` je v three legitimně buď jeden, nebo pole.
  const pair = [new MeshBasicMaterial(), new MeshBasicMaterial()];
  const inner = new Mesh(new BoxGeometry(1, 1, 1), pair);
  materials.push(...pair);

  outer.add(inner);
  root.add(outer);
  return { root, materials };
}

describe('createRevealPlan', () => {
  it('mimo prohlížeč je rozvrh plnohodnotný, ne „hned"', () => {
    const plan = createRevealPlan();
    expect(plan.reducedMotion).toBe(false);
    expect(plan.durationMs).toBe(MATERIALIZE_MS);
    expect(plan.done(0)).toBe(false);
  });

  it('krytí roste lineárně od nuly do jedničky', () => {
    const plan = createRevealPlan({ durationMs: 800 });

    expect(plan.opacityAt(0)).toBe(0);
    expect(plan.opacityAt(400)).toBeCloseTo(0.5, 6);
    expect(plan.opacityAt(800)).toBe(1);
    // Za koncem se nepřetáčí — snímek, který dorazí pozdě, nesmí objekt zase
    // zprůhlednit.
    expect(plan.opacityAt(5_000)).toBe(1);
    expect(plan.done(799)).toBe(false);
    expect(plan.done(800)).toBe(true);
  });

  it('tlumený pohyb je žádné odhalení, ne zkrácené', () => {
    const plan = createRevealPlan({ reducedMotion: true });

    expect(plan.durationMs).toBe(0);
    // Od prvního snímku plné krytí a hotovo — týž konec, jiná cesta.
    expect(plan.opacityAt(0)).toBe(1);
    expect(plan.done(0)).toBe(true);
  });

  it('tlumený pohyb přebije i vlastní délku', () => {
    const plan = createRevealPlan({ reducedMotion: true, durationMs: 5_000 });
    expect(plan.durationMs).toBe(0);
    expect(plan.done(0)).toBe(true);
  });
});

describe('applyReveal', () => {
  it('nastaví krytí každému materiálu v podstromu, i tomu v poli', () => {
    const { root, materials } = subtree();

    applyReveal(root, 0.4);

    for (const material of materials) {
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeCloseTo(0.4, 6);
      // Hloubka se píše i uprostřed přechodu: bez toho by se odvrácená strana
      // kandidáta kreslila přes tu přivrácenou.
      expect(material.depthWrite).toBe(true);
    }
  });

  it('hotové odhalení průhlednost zase vypne', () => {
    const { root, materials } = subtree();

    applyReveal(root, 0.4);
    applyReveal(root, 1);

    for (const material of materials) {
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
    }
  });
});
