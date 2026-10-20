/**
 * Okrajový svit postav (P54B T14). Pinuje se, co by na snímku vypadalo stejně a přesto bylo špatně:
 * svit, který three přeloží programem materiálu bez svitu (stejný klíč programu – svit náhodně chybí,
 * nebo naopak svítí mince), úprava sdíleného materiálu, po které svítí i rekvizity, kopie souboje,
 * která svit ztratí, fialová barva svitu v některé náladě a ladění telefonní úrovně, které kontrast nezvedne.
 */

import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, ShaderLib, SkinnedMesh } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, TIMES_OF_DAY, WEATHERS, sceneLook } from '@/play/arcade/look';

import { characterRim, mergeBody, patchedClone, rimLit, rimMaterial, setCharacterRim } from '../load';
import { GRADES, GRADE_FAMILIES, gradeFor } from '../rig/grade';
import { QUALITY_TIERS } from '../rig/quality';

/** Shader materiálu, jak by ho three přeložil. */
function compiled(material: { onBeforeCompile(shader: never, renderer: never): void }) {
  const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: {} as Record<string, unknown> };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

const meshOf = (root: { traverse(visit: (node: unknown) => void): void }): Mesh[] => {
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    if ((node as Mesh).isMesh === true) meshes.push(node as Mesh);
  });
  return meshes;
};

/** Slité tělo (`mergeBody`): barva, drsnost a záře ve vrcholech, jeden sdílený materiál pro všechna těla. */
const mergedBody = (color: string) => mergeBody(new Group().add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color }))));

const hueOf = (hex: string): { readonly hue: number; readonly saturation: number } => {
  const hsl = { h: 0, s: 0, l: 0 };
  new Color(hex).getHSL(hsl);
  return { hue: hsl.h * 360, saturation: hsl.s };
};

describe('rim light on characters (P54B T14)', () => {
  it('lights the rim through the shared uniforms, in its own program', () => {
    const source = new MeshStandardMaterial({ color: '#c08040' });
    const rim = rimMaterial(source);
    expect(rim).not.toBe(source);
    const { fragmentShader, uniforms } = compiled(rim);
    // Fresnel po normálách a směru ke kameře, přičtený k záři – před světly, takže ho ACES a mlha zpracují jako zbytek těla.
    // Barvou těla: čistá barva oblohy postavu vybělila (soud telefonu T14, 5 z 10).
    expect(fragmentShader).toMatch(/#include <emissivemap_fragment>[\s\S]*totalEmissiveRadiance \+= rimColor \* mix\(diffuseColor\.rgb, [^;]*dot\(normal, normalize\(vViewPosition\)\)/);
    // Sdílené uniformy: sada, nálada i úroveň mění jen hodnotu, program se nepřekládá.
    expect(uniforms.rimColor).toBe(characterRim.color);
    expect(uniforms.rimStrength).toBe(characterRim.strength);
    expect(rim.customProgramCacheKey()).not.toBe(source.customProgramCacheKey());
    expect(compiled(source).fragmentShader).not.toContain('rimColor');
    // Jedna kopie na zdroj a kopie se znovu nekopíruje: opakované vepsání modelu nepřidá programy.
    expect(rimMaterial(source)).toBe(rim);
    expect(rimMaterial(rim)).toBe(rim);
  });

  it('keeps the merged body patch and leaves the props unlit', () => {
    const hero = mergedBody('#2563eb');
    const coin = mergedBody('#facc15');
    const shared = (coin as Mesh).material as MeshStandardMaterial;
    expect((hero as Mesh).material).toBe(shared);
    const lit = rimLit(hero.clone(true));
    const [body] = meshOf(lit);
    expect(body!.material).not.toBe(shared);
    const { fragmentShader } = compiled(body!.material as MeshStandardMaterial);
    expect(fragmentShader).toContain('totalEmissiveRadiance += vGlow;');
    expect(fragmentShader).toContain('rimStrength');
    expect((body!.material as MeshStandardMaterial).customProgramCacheKey()).toBe(`${shared.customProgramCacheKey()}+rim`);
    // Zdroj zůstal: mince i nerozsvícený originál hrdiny kreslí sdílený materiál bez svitu.
    expect((hero as Mesh).material).toBe(shared);
    expect(compiled(shared).fragmentShader).not.toContain('rimStrength');
  });

  it('reaches rigged meshes and survives the fight copy', () => {
    const rig = new Group().add(new SkinnedMesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial({ color: '#94a3b8' })), new Mesh(new BoxGeometry(0.2, 0.2, 1), [new MeshStandardMaterial(), new MeshStandardMaterial()]));
    rimLit(rig);
    for (const mesh of meshOf(rig)) for (const material of [mesh.material].flat()) expect(compiled(material as MeshStandardMaterial).fragmentShader).toContain('rimStrength');
    // Souboj klonuje materiál každého bojovníka (záblesk zásahu); `clone()` úpravu shaderu nepřenese.
    const fighter = meshOf(rig)[0]!.material as MeshStandardMaterial;
    const copy = patchedClone(fighter);
    expect(copy).not.toBe(fighter);
    expect(compiled(copy).fragmentShader).toContain('rimStrength');
    expect(copy.customProgramCacheKey()).toBe(fighter.customProgramCacheKey());
  });

  it('takes a light colour from the set palette in every mood, never purple', () => {
    for (const look of LOOK_IDS) {
      for (const timeOfDay of TIMES_OF_DAY) {
        for (const weather of WEATHERS) {
          const scene = sceneLook({ setting: look, mood: 'calm', look, timeOfDay, weather });
          setCharacterRim(scene);
          expect(characterRim.color.value.getHexString()).toBe(new Color(scene.light[0]).getHexString());
          expect(characterRim.strength.value).toBeGreaterThan(0);
          const { hue, saturation } = hueOf(scene.light[0]);
          if (saturation > 0.1) expect(hue < 250 || hue > 320, `${look} ${timeOfDay} ${weather}: ${scene.light[0]}`).toBe(true);
        }
      }
    }
  });

  it('raises the contrast of every family on the phone tier only', () => {
    for (const family of GRADE_FAMILIES) {
      for (const tier of QUALITY_TIERS) {
        const grade = gradeFor(family, tier);
        if (tier === 'low') {
          expect(grade.contrast).toBeGreaterThan(GRADES[family].contrast);
          expect({ ...grade, contrast: GRADES[family].contrast }).toEqual(GRADES[family]);
        } else expect(grade).toEqual(GRADES[family]);
      }
    }
  });
});
