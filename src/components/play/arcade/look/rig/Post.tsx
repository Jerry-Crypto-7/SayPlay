'use client';

/**
 * Postprocessing rigu (P32A T2): N8AO (kontaktní stíny v koutech), bloom jen
 * na emisi a slunci na obloze, SMAA, ACES a za ním ladění barev rodiny
 * prostředí (P37B T3, `grade.ts`). Kolik z toho se kreslí, určuje
 * úroveň kvality (`quality.ts`), kterou tu řídí průběžné FPS.
 *
 * Mimo hash: jádro úroveň ani obraz nečte.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import type { Look } from '@/play/arcade/look';

import { GRADES, GradeEffect, type GradeFamily } from './grade';
import { GAP_MS, type QualityState, type QualityTier, TIER_SETTINGS, bloomThreshold, sampleQuality, startQuality } from './quality';

/** FPS se měří po půlsekundách. */
const SAMPLE_MS = 500;

/**
 * Úroveň kvality podle `devicePixelRatio` a průběžného FPS. Měří jen, když hra
 * kreslí naplno: pauza a konec kreslí na požádání a jejich snímky nic neříkají.
 * Úroveň nastaví poměr pixelů plátna a zapíše se jako `data-quality`.
 */
export function useQualityTier(surface: RefObject<HTMLDivElement | null>): QualityTier {
  const setDpr = useThree((three) => three.setDpr);
  const [start] = useState(() => startQuality(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches));
  const governor = useRef<QualityState>(start);
  const [tier, setTier] = useState(start.tier);
  const meter = useRef({ from: -1, frames: 0 });

  useFrame(({ frameloop }) => {
    const now = performance.now();
    const span = meter.current;
    if (frameloop !== 'always' || span.from < 0 || now - span.from > GAP_MS) {
      span.from = frameloop === 'always' ? now : -1;
      span.frames = 0;
      return;
    }
    span.frames += 1;
    if (now - span.from < SAMPLE_MS) return;
    governor.current = sampleQuality(governor.current, (span.frames * 1000) / (now - span.from), now);
    span.from = now;
    span.frames = 0;
    setTier(governor.current.tier);
  });

  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, TIER_SETTINGS[tier].dpr));
    if (surface.current !== null) surface.current.dataset.quality = tier;
  }, [setDpr, surface, tier]);

  return tier;
}

/** Skládač kreslí snímek s touto prioritou (`useFrame`). */
const COMPOSER_PRIORITY = 1;

/**
 * Pro sondu `__playRender`: efekty skládače v pořadí (`data-post` plátna) –
 * se skládačem tónuje efekt `aces`, renderer má `NoToneMapping`. A skládač volá
 * `render()` víckrát za snímek, `renderer.info` se nuluje při každém a sonda by
 * viděla jen poslední průchod: tady se nuluje jednou za snímek, těsně před skládačem.
 */
function PostProbe({ effects }: { readonly effects: string }) {
  const gl = useThree((three) => three.gl);
  useEffect(() => {
    gl.info.autoReset = false;
    gl.domElement.dataset.post = effects;
    return () => {
      gl.info.autoReset = true;
      delete gl.domElement.dataset.post;
    };
  }, [gl, effects]);
  useFrame(() => gl.info.reset(), COMPOSER_PRIORITY - 0.5);
  return null;
}

/**
 * Ladění rodiny prostředí (P37B T3, `grade.ts`) – za ACES, slije se s ním do
 * jednoho průchodu. Rodinu, kterou efektu nastavil, zapíše plátnu (`data-grade`,
 * sonda `__playRender`): bez ladění ve skládači sonda nic nehlásí.
 */
export function Grading({ family }: { readonly family: GradeFamily }) {
  const gl = useThree((three) => three.gl);
  const effect = useMemo(() => new GradeEffect(), []);
  useEffect(() => {
    effect.grade = GRADES[family];
    gl.domElement.dataset.grade = family;
    return () => {
      delete gl.domElement.dataset.grade;
    };
  }, [effect, family, gl]);
  useEffect(() => () => effect.dispose(), [effect]);
  return <primitive object={effect} dispose={null} />;
}

/** Vzorky MSAA cíle skládače na úrovni bez SMAA. */
const MSAA_SAMPLES = 4;

/**
 * N8AO bez ohledu na průhledné sítě (P37B T7). Sám je hledá průchodem scény a pak
 * každý snímek kreslí scénu ještě dvakrát, jen aby je z AO vyňal – průhledné jsou tu
 * částice a záře, AO pod nimi není vidět. Telefon (Pixel 7, CPU 4×) na `medium` tím
 * každý snímek dvakrát navíc procházel scénu a přepočítal její matice (pirát ~8 % CPU).
 * Knihovna to propem nenabízí, nastavuje se na průchodu:
 * hledání vypne `autoDetectTransparency`, setter konfigurace jen při změně hodnoty.
 */
export function opaqueAo(pass: { autoDetectTransparency: boolean; configuration: { transparencyAware: boolean } } | null): void {
  if (pass === null) return;
  pass.autoDetectTransparency = false;
  pass.configuration.transparencyAware = false;
}

/**
 * `true`, jakmile plátno vykreslilo první snímek (P50 T2). Callback `useFrame`
 * běží uvnitř téhož `requestAnimationFrame` PŘED vykreslením snímku, takže úloha
 * naplánovaná z prvního callbacku doběhne až po vykreslení – i když další snímek
 * nepřijde (`frameloop="demand"`).
 */
export function useFirstFrameDrawn(): boolean {
  const [drawn, setDrawn] = useState(false);
  const scheduled = useRef(false);
  useFrame(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    setTimeout(() => setDrawn(true), 0);
  });
  return drawn;
}

/**
 * Skládač kreslí na každé úrovni (`TIER_SETTINGS`): scéna tak jde vždy do jeho
 * cíle bez tónování a změna úrovně nepřekládá shadery materiálů. SMAA jde první –
 * čte vstup průchodu, efekty před ním by zahodil.
 *
 * `lean` (P50 T2) = první snímek: skládač jen tónuje a ladí, AO, SMAA a bloom
 * přijdou hned po něm. Jejich programy stály před prvním snímkem sdílené hry
 * ~285 ms ze 419 ms překladu (desktop, 17. 10.). Skládač samotný se neodkládá:
 * bez něj by renderer tónoval sám a jeho příchod by přeložil shadery všech
 * materiálů znovu (viz `TIER_SETTINGS`); `multisampling` se nemění, jinak by
 * se skládač postavil znovu.
 */
export function Post({ look, family, tier, lean = false }: { readonly look: Look; readonly family: GradeFamily; readonly tier: QualityTier; readonly lean?: boolean }) {
  const { aa } = TIER_SETTINGS[tier];
  const { bloom, ao } = lean ? { bloom: false, ao: false as const } : TIER_SETTINGS[tier];
  const smaa = aa === 'smaa' && !lean;
  return (
    <>
      <PostProbe effects={[ao === false ? '' : 'ao', smaa ? 'smaa' : '', bloom ? 'bloom' : '', 'aces'].filter(Boolean).join(' ')} />
      <EffectComposer multisampling={aa === 'msaa' ? MSAA_SAMPLES : 0} renderPriority={COMPOSER_PRIORITY}>
        {ao === false ? <></> : <N8AO ref={opaqueAo} aoRadius={1.2} distanceFalloff={1} intensity={2} halfRes={ao === 'half'} quality={ao === 'half' ? 'performance' : 'medium'} />}
        {smaa ? <SMAA /> : <></>}
        {bloom ? <Bloom mipmapBlur luminanceThreshold={bloomThreshold(look)} luminanceSmoothing={0.1} intensity={0.8} /> : <></>}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <Grading family={family} />
      </EffectComposer>
    </>
  );
}
