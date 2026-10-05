/**
 * Ladění barev je ve skládači (P37B T3). Odpojené ladění vypadá na snímku
 * „skoro stejně“ a slepý soud ho nemusí chytit; e2e `p32-look` čte rodinu,
 * kterou efekt ladění sám zapíše plátnu. Tenhle pin hlídá totéž bez prohlížeče:
 * `Post` ladění na každé úrovni kvality připojí s rodinou looku a efekt
 * dostane její hodnoty. Od P37B T7 hlídá i to, že každá úroveň kreslí přes skládač.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu a `useThree` nahrazuje malá
 * náhrada, komponenty se volají jako funkce a čte se jejich strom elementů.
 */

import { EffectComposer, N8AO, SMAA, ToneMapping } from '@react-three/postprocessing';
// @ts-expect-error -- n8ao typy nemá; test sahá jen na `configuration` a `detectTransparency`.
import { N8AOPostPass } from 'n8ao';
import { ToneMappingMode } from 'postprocessing';
import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type Vector3 } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOOKS, LOOK_IDS } from '@/play/arcade/look';

import { GRADES, type GradeEffect } from '../look/rig/grade';
import { Grading, Post, opaqueAo } from '../look/rig/Post';
import { TIER_SETTINGS } from '../look/rig/quality';

const hooks = vi.hoisted(() => ({ effects: [] as (() => unknown)[], dataset: {} as Record<string, string> }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useMemo: (make: () => unknown) => make(),
    useEffect: (effect: () => unknown) => hooks.effects.push(effect),
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useThree: (select: (three: { gl: { domElement: { dataset: Record<string, string> } } }) => unknown) => select({ gl: { domElement: { dataset: hooks.dataset } } }),
}));

type Element = ReactElement<Record<string, unknown>>;

/** Všechny elementy daného typu ve stromu (přes `children`). */
function findAll(node: ReactNode, type: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => findAll(child, type));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [...(element.type === type ? [element] : []), ...findAll(element.props.children as ReactNode, type)];
}

const look = LOOKS[LOOK_IDS[0]];
const tiers = Object.keys(TIER_SETTINGS) as (keyof typeof TIER_SETTINGS)[];

beforeEach(() => {
  hooks.effects.length = 0;
  for (const key of Object.keys(hooks.dataset)) delete hooks.dataset[key];
});

describe('colour grade wiring', () => {
  it.each(tiers)('the %s composer grades with the look’s family', (tier) => {
    const grading = findAll(Post({ look, family: 'cold', tier }), Grading);
    expect(grading).toHaveLength(1);
    expect(grading[0]!.props.family).toBe('cold');
  });

  // P37B T7: tier bez skládače tónoval rendererem a přepnutí na něj přeložilo
  // shadery celé scény (telefon 1–2 s pod 10 FPS). Každá úroveň proto kreslí
  // přes jeden skládač s ACES; liší se jen efekty a hranování.
  it.each(tiers)('the %s tier draws through one composer that tones with ACES', (tier) => {
    const tree = Post({ look, family: 'cold', tier });
    const composers = findAll(tree, EffectComposer);
    expect(composers).toHaveLength(1);
    const toning = findAll(tree, ToneMapping);
    expect(toning).toHaveLength(1);
    expect(toning[0]!.props.mode).toBe(ToneMappingMode.ACES_FILMIC);
    const smaa = findAll(tree, SMAA).length === 1;
    expect(smaa).toBe(TIER_SETTINGS[tier].aa === 'smaa');
    expect(composers[0]!.props.multisampling, 'bez SMAA hranuje MSAA cíle skládače').toBe(smaa ? 0 : 4);
  });

  // P37B T7: N8AO s průhlednou sítí ve scéně kreslil scénu každý snímek ještě dvakrát.
  it.each(tiers.filter((tier) => TIER_SETTINGS[tier].ao !== false))('the %s AO pass ignores transparent meshes', (tier) => {
    const ao = findAll(Post({ look, family: 'cold', tier }), N8AO);
    expect(ao).toHaveLength(1);
    expect(ao[0]!.props.ref).toBe(opaqueAo);
  });

  // Průchod vzniká se skládačem, částice a záře přibudou do scény až potom.
  it('a pass set up by opaqueAo stays opaque when transparent meshes arrive later', () => {
    const camera = new PerspectiveCamera();
    const later = (pass: { detectTransparency(): void }, scene: Scene) => {
      scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ transparent: true })));
      pass.detectTransparency();
    };
    const plainScene = new Scene();
    const plain = new N8AOPostPass(plainScene, camera);
    later(plain, plainScene);
    expect(plain.configuration.transparencyAware, 'bez opaqueAo si průhlednost najde sám').toBe(true);
    const opaqueScene = new Scene();
    const opaque = new N8AOPostPass(opaqueScene, camera);
    opaqueAo(opaque);
    later(opaque, opaqueScene);
    expect(opaque.configuration.transparencyAware).toBe(false);
  });

  it('the grade effect gets the family’s values and reports the family to the canvas', () => {
    const tree = Grading({ family: 'dark' }) as Element;
    for (const effect of hooks.effects) effect();
    const effect = tree.props.object as GradeEffect;
    expect(effect.uniforms.get('gamma')!.value).toBe(GRADES.dark.gamma);
    expect((effect.uniforms.get('lift')!.value as Vector3).toArray()).toEqual([...GRADES.dark.lift]);
    expect(hooks.dataset.grade).toBe('dark');
  });
});
