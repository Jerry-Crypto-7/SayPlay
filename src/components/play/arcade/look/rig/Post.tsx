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
import { Bloom, EffectComposer, N8AO, SMAA, TiltShift2, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import type { Look } from '@/play/arcade/look';

import { tiltFocus } from '../framing';
import { GradeEffect, type GradeFamily, gradeFor } from './grade';
import { GAP_MS, type QualityState, type QualityTier, TIER_SETTINGS, bloomThreshold, sampleQuality, startQuality } from './quality';

/** FPS se měří po půlsekundách. */
const SAMPLE_MS = 500;

/** Ovládání (`data-control` plochy), jehož hra začíná na telefonu na `low` (`startQuality`, P68R T3). */
const LIGHT_START: ReadonlySet<string> = new Set(['buildshift', 'stunt']);

/**
 * Úroveň kvality podle `devicePixelRatio` a průběžného FPS. Měří jen, když hra
 * kreslí naplno: pauza a konec kreslí na požádání a jejich snímky nic neříkají.
 * Úroveň nastaví poměr pixelů plátna a zapíše se jako `data-quality`.
 */
export function useQualityTier(surface: RefObject<HTMLDivElement | null>): QualityTier {
  const setDpr = useThree((three) => three.setDpr);
  const [start] = useState(() =>
    startQuality(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches, LIGHT_START.has(surface.current?.dataset.control ?? '')),
  );
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

  // Poměr pixelů jen jednou, podle startovní úrovně (P74 R2): emulovaný iPhone (WebKit) po zmenšení plátna za běhu
  // (`medium` → `low`, 1,5 → 1) kreslil už jen barvu pozadí, u všech her. Pozdější úroveň mění jen efekty a stíny.
  // simplified: telefon, který spadne z `medium` na `low`, si nechá 1,5 – zmenšovat plátno, až se ověří na skutečném iPhonu.
  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, TIER_SETTINGS[start.tier].dpr));
  }, [setDpr, start]);

  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.quality = tier;
  }, [surface, tier]);

  return tier;
}

/** Skládač kreslí snímek s touto prioritou (`useFrame`). */
const COMPOSER_PRIORITY = 1;
/**
 * Priorita `useFrame` po všem, co scéna za snímek hýbe (kamera, hrdina, slunce mají 0), a před kresbou
 * skládače. Kladná priorita bere R3F kreslení – smí ji mít jen to, co běží pod rigem, který skládač má vždy.
 */
export const BEFORE_COMPOSER = COMPOSER_PRIORITY - 0.5;

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
  useFrame(() => gl.info.reset(), BEFORE_COMPOSER);
  return null;
}

/**
 * Ladění rodiny prostředí (P37B T3, `grade.ts`) – za ACES, slije se s ním do
 * jednoho průchodu. Rodinu, kterou efektu nastavil, zapíše plátnu (`data-grade`,
 * sonda `__playRender`): bez ladění ve skládači sonda nic nehlásí.
 */
export function Grading({ family, tier }: { readonly family: GradeFamily; readonly tier: QualityTier }) {
  const gl = useThree((three) => three.gl);
  const effect = useMemo(() => new GradeEffect(), []);
  useEffect(() => {
    effect.grade = gradeFor(family, tier);
    gl.domElement.dataset.grade = family;
    return () => {
      delete gl.domElement.dataset.grade;
    };
  }, [effect, family, tier, gl]);
  useEffect(() => () => effect.dispose(), [effect]);
  return <primitive object={effect} dispose={null} />;
}

/** Tilt-shift: síla rozostření, šíře ostrého pásu (0–1, víc = širší) a vzorky – jemně, hračka, ne rozmazaný obraz. */
const TILT_BLUR = 0.12;
const TILT_TAPER = 0.7;
const TILT_SAMPLES = 8;

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
 * Skládač kreslí na každé úrovni (`TIER_SETTINGS`): scéna tak jde vždy do jeho
 * cíle bez tónování a změna úrovně nepřekládá shadery materiálů. SMAA jde první –
 * čte vstup průchodu, efekty před ním by zahodil.
 */
export function Post({ look, family, tier, control }: { readonly look: Look; readonly family: GradeFamily; readonly tier: QualityTier; readonly control: string }) {
  const { bloom, ao, aa, tilt } = TIER_SETTINGS[tier];
  // Tilt-shift diorama (P73D T4) jen na `high` a jen u ovládání s rámováním diorama: ostrý pás přes hrdinu.
  const focus = tilt ? tiltFocus(control) : null;
  return (
    <>
      <PostProbe effects={[ao === false ? '' : 'ao', aa === 'smaa' ? 'smaa' : '', bloom ? 'bloom' : '', focus === null ? '' : 'tilt', 'aces'].filter(Boolean).join(' ')} />
      <EffectComposer multisampling={aa === 'msaa' ? MSAA_SAMPLES : 0} renderPriority={COMPOSER_PRIORITY}>
        {ao === false ? <></> : <N8AO ref={opaqueAo} aoRadius={1.2} distanceFalloff={1} intensity={2} halfRes={ao === 'half'} quality={ao === 'half' ? 'performance' : 'medium'} />}
        {aa === 'smaa' ? <SMAA /> : <></>}
        {bloom ? <Bloom mipmapBlur luminanceThreshold={bloomThreshold(look)} luminanceSmoothing={0.1} intensity={0.8} /> : <></>}
        {focus === null ? <></> : <TiltShift2 blur={TILT_BLUR} taper={TILT_TAPER} start={[0, focus]} end={[1, focus]} samples={TILT_SAMPLES} />}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <Grading family={family} tier={tier} />
      </EffectComposer>
    </>
  );
}
