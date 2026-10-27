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
import { createXRStore, XR } from '@react-three/xr';
import { type ReactNode, useEffect } from 'react';

import { createHostTunnel, StagePortal } from '../feed/StageHost';
import { PANEL_ORDER } from './XrPanel';
import { XrRig } from './XrRig';

/** Quest 2 umí 72, 80, 90 a 120 Hz; plán cílí na 72. */
const TARGET_HZ = 72;

function nearestRate(rates: ArrayLike<number>): number | false {
  let best: number | false = false;
  for (const rate of Array.from(rates)) {
    if (best === false || Math.abs(rate - TARGET_HZ) < Math.abs(best - TARGET_HZ)) best = rate;
  }
  return best;
}

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
  frameRate: nearestRate,
});

/** Tunel trvalého plátna VR; kontejner plátna se stěhuje do místa hry, která právě hraje. */
export const host = createHostTunnel();

/**
 * Výjimka v jednom snímku VR by zastavila kreslení relace natrvalo: three po chybě v `setAnimationLoop` nepožádá
 * brýle o další snímek a obraz v nich zamrzne (Quest ho jen dál přepočítává podle hlavy). Snímek s chybou se proto
 * zahodí a další jede; chyba jde jednou do konzole. Nález T5 (`docs/vr/README.md`): `look/Ambient.tsx` (P62) ve VR
 * padá, když žádné umístění života není v obraze hlavy – opravit tam, tohle je jen pojistka relace.
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
              try {
                callback(time, frame);
              } catch (error) {
                const message = String(error);
                if (!seen.has(message)) console.error(error);
                seen.add(message);
              }
            },
      );
    return () => {
      xr.setAnimationLoop = set;
    };
  }, [xr]);
  return null;
}

function wrapScene(scene: ReactNode): ReactNode {
  return (
    <XR store={store}>
      <KeepXrFrames />
      <XrRig>{scene}</XrRig>
    </XR>
  );
}

/** Plátno s XR relací. Programy shaderů drží přes výměny her a novou scénu staví odloženě, jako řetěz mikroher. */
export function XrStage() {
  return <StagePortal host={host} keepPrograms deferScenes wrap={wrapScene} />;
}

export async function enterVr(): Promise<void> {
  await store.enterVR();
}

export function exitVr(): void {
  void store.getState().session?.end();
}

/** Hlásí vstup do relace a odchod z ní; hned i aktuální stav. */
export function onPresenting(listener: (presenting: boolean) => void): () => void {
  listener(store.getState().session != null);
  return store.subscribe((state, prev) => {
    if ((state.session != null) !== (prev.session != null)) listener(state.session != null);
  });
}
