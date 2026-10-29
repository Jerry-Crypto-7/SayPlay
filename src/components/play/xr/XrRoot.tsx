'use client';

/**
 * Všechno, co VR potřebuje a 2D ne (P65 T1). Načítá ho jen `XrGate` dynamickým importem, až když adresa nese
 * `?vr=1` a prohlížeč umí `immersive-vr`.
 *
 * Trvalé plátno: výměna rychlé hry za AI verzi je navigace na jinou `/play/<id>`, a hra s vlastním `<Canvas>`
 * by s ním ztratila i XR relaci (ta je svázaná s kontextem WebGL). Ve VR proto každá hra pod `/play` kreslí do
 * jednoho plátna tady (`host`), které žije s layoutem.
 */

import { useThree } from '@react-three/fiber';
import { createXRStore, useXR, XR } from '@react-three/xr';
import { EffectComposer } from 'postprocessing';
import { type ReactNode, useEffect, useMemo } from 'react';
import type { Light } from 'three';

import { fpsHudWanted } from '@/play/xr/flag';
import { profileFor } from '@/play/xr/headset';
import { type FrameMeter, XR_QUALITY, createFrameMeter, framebufferScaleOf, nearestRate } from '@/play/xr/quality';

import { createHostTunnel, StagePortal } from '../feed/StageHost';
import { registerSw } from './RegisterSw';
import { closeXrLobby, openXrLobby } from './xr-lobby';
import { XrFpsHud } from './XrFpsHud';
import { PANEL_ORDER } from './XrPanel';
import { XrRig } from './XrRig';

/** Adresa, kterou stránka otevřela – jako brána `?vr=1` (`XrGate`), tedy i po přechodu na AI verzi. */
const opened = window.location.href;
/** Které brýle (`profileFor`): Quest 3 a 3S mají vlastní profil, ostatní profil Questu 2. */
const userAgent = navigator.userAgent;

// Instalace jako aplikace (T11): worker se registruje odsud, ne z layoutu – telefon ho nemá ani v prvním JS.
void registerSw();

const store = createXRStore({
  // Emulátor IWER vstřikuje jen e2e; produkt ho nenačte ani na localhostu.
  emulate: false,
  // Relaci začíná jen „Enter VR“, ne nabídka prohlížeče.
  offerSession: false,
  // Ovladače bez modelu: výchozí model se stahuje z cizího CDN. Paprsek zůstává – ovládá panely HUD (T5).
  controller: {
    model: false,
    grabPointer: false,
    teleportPointer: false,
    rayPointer: {
      // Klik = stisk a puštění spouště na tlačítku; výchozích 300 ms je na dlouhý chod spouště Questu málo.
      clickThresholdMs: 1000,
      // Paprsek a kurzor přes panely, které se kreslí přes scénu (`PANEL_ORDER`), jinak by je panel zakryl.
      rayModel: { renderOrder: PANEL_ORDER + 10 },
      cursorModel: { renderOrder: PANEL_ORDER + 10 },
    },
  },
  hand: false,
  gaze: false,
  screenInput: false,
  transientPointer: false,
  // Jen VR (rozhovor 27. 10.): žádné ruce, kotvy, roviny ani síť prostoru – a s nimi žádné dotazy na oprávnění.
  handTracking: false,
  anchors: false,
  layers: false,
  meshDetection: false,
  planeDetection: false,
  hitTest: false,
  domOverlay: false,
  // Profil brýlí (`headset.ts`): Quest 2 a neznámé 72 Hz, pevná foveace, rozlišení relace 1; Quest 3 a 3S 90 Hz
  // (když ho relace nabízí) a rozlišení 1,2. Rozlišení se volí před relací, frekvence až podle jejího seznamu.
  frameRate: (supportedFrameRates) => nearestRate(supportedFrameRates, profileFor({ userAgent, supportedFrameRates }).hz),
  foveation: XR_QUALITY.foveation,
  frameBufferScaling: framebufferScaleOf(opened, profileFor({ userAgent }).scale),
});

// VR lobby (P67 T2) patří relaci: po odchodu z VR se zavře a další „Enter VR“ ze hry začne hrou, ne lobby.
store.subscribe((state, prev) => {
  if (prev.session != null && state.session == null) closeXrLobby();
});

/** Panel FPS (`?vrhud=1`) pro ruční bránu T8. */
const fpsHud = fpsHudWanted(opened);
/** Snímky relace pro panel FPS; měří `KeepXrFrames`. */
const meter: FrameMeter = createFrameMeter();

/** Tunel trvalého plátna VR; kontejner plátna se stěhuje do místa hry, která právě hraje. */
export const host = createHostTunnel();

/**
 * Výjimka v jednom snímku VR by zastavila kreslení relace natrvalo: three po chybě v `setAnimationLoop` nepožádá
 * brýle o další snímek a obraz v nich zamrzne (Quest ho jen dál přepočítává podle hlavy). Snímek s chybou se proto
 * zahodí a další jede; chyba jde jednou do konzole. Nález T5 (`docs/vr/README.md`): `look/Ambient.tsx` (P62) ve VR
 * padá, když žádné umístění života není v obraze hlavy – opravit tam, tohle je jen pojistka relace.
 * Zároveň měří, kdy snímek začal a kolik ms práce CPU stál (panel FPS, `XrFpsHud`).
 */
function KeepXrFrames() {
  const xr = useThree((three) => three.gl.xr);
  useEffect(() => {
    const set = xr.setAnimationLoop;
    const seen = new Set<string>();
    xr.setAnimationLoop = (callback) =>
      set.call(
        xr,
        callback === null
          ? null
          : (time, frame) => {
              const start = performance.now();
              try {
                callback(time, frame);
              } catch (error) {
                const message = String(error);
                if (!seen.has(message)) console.error(error);
                seen.add(message);
              }
              meter.record(start, performance.now() - start);
            },
      );
    return () => {
      xr.setAnimationLoop = set;
    };
  }, [xr]);
  return null;
}

/**
 * Profil Questu 2 v relaci (`quality.ts`), zvenku, bez souborů P62:
 *
 * - **Bez postprocessingu.** Skládač (`look/rig/Post.tsx`) ve VR stereo rozbije, proto scénu kreslí `XrRig`
 *   napřímo; skládač by dál kreslil celou scénu podruhé a AO, bloom a SMAA v rozlišení brýlí naprázdno. V relaci
 *   se jeho `render` i `setSize` přeskočí (i cíle kreslení zůstanou v 2D velikosti); po odchodu z VR jede jako dřív.
 * - **Bez stínů.** Three předá stínovému průchodu světla se stínem dřív, než skládá světla pro materiály: světlo
 *   tam ztratí `castShadow` a materiály se přeloží bez stínu hned v prvním snímku – i se sluncem nové hry
 *   po výměně za AI verzi. Po odchodu z VR světla stín vrhají znovu.
 *
 * simplified: přepsaná metoda knihovny `postprocessing`; až půjde měnit `Post.tsx` (P62), patří tam
 * `enabled={!presenting}` skládače a tohle zmizí.
 */
function XrQuality() {
  const gl = useThree((three) => three.gl);
  const presenting = useXR((xr) => xr.session != null);
  useEffect(() => {
    if (!presenting) return undefined;
    const composer = EffectComposer.prototype;
    const { render, setSize } = composer;
    composer.render = function (this: EffectComposer, delta?: number) {
      if (!this.getRenderer().xr.isPresenting) render.call(this, delta);
    };
    composer.setSize = function (this: EffectComposer, width: number, height: number, updateStyle?: boolean) {
      if (!this.getRenderer().xr.isPresenting) setSize.call(this, width, height, updateStyle);
    };
    const shadows = gl.shadowMap;
    const shadowPass = shadows.render;
    const unlit = new Set<Light>();
    shadows.render = (lights) => {
      for (const light of lights) {
        light.castShadow = false;
        unlit.add(light);
      }
    };
    return () => {
      composer.render = render;
      composer.setSize = setSize;
      shadows.render = shadowPass;
      for (const light of unlit) light.castShadow = true;
    };
  }, [gl, presenting]);
  return null;
}

/**
 * Plátno s `<XR>` je připojené k three: `<XR>` předá správce WebXR už při renderu, efekt dítěte běží po něm.
 * Do té doby `store.enterVR` odmítne („not connected to three.js“) a klepnutí na „Enter VR“ by tiše nic neudělalo –
 * tlačítko se proto ukáže až teď (`XrControls.ready`). Naměřeno 28. 10.: tlačítko bylo vidět ~200 ms před připojením.
 */
let connected = false;
const connectedListeners = new Set<(ready: boolean) => void>();

function setConnected(next: boolean): void {
  connected = next;
  connectedListeners.forEach((listener) => listener(next));
}

function XrConnected() {
  useEffect(() => {
    setConnected(true);
    return () => setConnected(false);
  }, []);
  return null;
}

function FpsHud() {
  const presenting = useXR((xr) => xr.session != null);
  const aim = useMemo(() => new Map(), []);
  return presenting ? <XrFpsHud meter={meter} aim={aim} /> : null;
}

function wrapScene(scene: ReactNode): ReactNode {
  return (
    <XR store={store}>
      <XrConnected />
      <KeepXrFrames />
      <XrQuality />
      <XrRig>{scene}</XrRig>
      {fpsHud && <FpsHud />}
    </XR>
  );
}

/** Plátno s XR relací. Programy shaderů drží přes výměny her a novou scénu staví odloženě, jako řetěz mikroher. */
export function XrStage() {
  return <StagePortal host={host} keepPrograms deferScenes wrap={wrapScene} />;
}

/** `lobby` (P67 T2, „Enter VR“ domova): relace začne VR lobby; když se do VR nevstoupí, lobby nezůstane čekat. */
export async function enterVr(options?: { readonly lobby?: boolean }): Promise<void> {
  if (options?.lobby === true) openXrLobby();
  try {
    await store.enterVR();
  } catch (error) {
    closeXrLobby();
    throw error;
  }
}

export function exitVr(): void {
  void store.getState().session?.end();
}

/** Hlásí, jestli `enterVr` umí relaci začít (plátno s `<XR>` připojené); hned i aktuální stav. */
export function onReady(listener: (ready: boolean) => void): () => void {
  listener(connected);
  connectedListeners.add(listener);
  return () => {
    connectedListeners.delete(listener);
  };
}

/** Hlásí vstup do relace a odchod z ní; hned i aktuální stav. */
export function onPresenting(listener: (presenting: boolean) => void): () => void {
  listener(store.getState().session != null);
  return store.subscribe((state, prev) => {
    if ((state.session != null) !== (prev.session != null)) listener(state.session != null);
  });
}
