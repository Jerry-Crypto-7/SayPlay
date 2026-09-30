'use client';

/**
 * Postprocessing rigu (P32A T2): N8AO (kontaktní stíny v koutech), bloom jen
 * na emisi a slunci na obloze, SMAA a ACES. Kolik z toho se kreslí, určuje
 * úroveň kvality (`quality.ts`), kterou tu řídí průběžné FPS.
 *
 * Mimo hash: jádro úroveň ani obraz nečte.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { type RefObject, useEffect, useRef, useState } from 'react';

import type { Look } from '@/play/arcade/look';

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
  const [start] = useState(() => startQuality(window.devicePixelRatio));
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
 * `low` skládač nemá (`TIER_SETTINGS`): scénu kreslí renderer sám, s ACES
 * a MSAA plátna. SMAA jde první – čte vstup průchodu, efekty před ním by zahodil.
 */
export function Post({ look, tier }: { readonly look: Look; readonly tier: QualityTier }) {
  const { bloom, ao } = TIER_SETTINGS[tier];
  if (!bloom && ao === false) return null;
  return (
    <>
      <PostProbe effects={[ao === false ? '' : 'ao', 'smaa', bloom ? 'bloom' : '', 'aces'].filter(Boolean).join(' ')} />
      <EffectComposer multisampling={0} renderPriority={COMPOSER_PRIORITY}>
        {ao === false ? <></> : <N8AO aoRadius={1.2} distanceFalloff={1} intensity={2} halfRes={ao === 'half'} quality={ao === 'half' ? 'performance' : 'medium'} />}
        <SMAA />
        {bloom ? <Bloom mipmapBlur luminanceThreshold={bloomThreshold(look)} luminanceSmoothing={0.1} intensity={0.8} /> : <></>}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </>
  );
}
