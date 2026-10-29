'use client';

/**
 * Feed ve VR (P67 T4): listování her bez sundání brýlí. Aktivní karta feedu kreslí do plátna XR relace stejně jako
 * hra na své stránce – `StageHost` jí ve VR dá trvalé plátno z layoutu místo vlastního. Tady je ovládání:
 *
 * - **pravá páčka** mávnutím nahoru = další karta, dolů = předchozí; jen mimo běžící kolo (náhled robota, výsledek,
 *   karta, která se ještě načítá). V kole patří páčka hře (`XrInput`);
 * - **spoušť nebo A/X** na náhledu robota hru převezme, jako ťuk na scénu ve 2D. Spoušť s paprskem na panelu patří
 *   panelu (`createTriggerOwner`, jako u hry);
 * - „Next“ na panelu výsledku (`XrHud`).
 *
 * Listování dává feed přes `feedSteps` (`feed-next.ts`): plátno R3F je vlastní React kořen a kontexty feedu
 * do něj nedosáhnou. Páčka ani poloha ovladačů nejdou do stavu hry – převzetí je tentýž restart jako po ťuku.
 *
 * Do feedu se v relaci jde i „Next“ z hry na vlastní stránce (P67 T14a, `XrHud`). Nová stránka `/play` začne nahoře
 * a v úzkém okně (pod 1024 px) leží feed pod formulářem: karta, kterou feed nevidí z poloviny, nehraje, a v brýlích
 * by nebylo nic, ani panel. Dokud žádná hra na obrazovce není, posune se proto feed do obrazu (`nearest`: feed, který
 * vidět je, se nehne).
 */

import { useFrame } from '@react-three/fiber';
import { type XRControllerState, useXRInputSourceState } from '@react-three/xr';
import { useEffect, useMemo, useRef } from 'react';

import { createFlick, createTriggerOwner } from '@/play/xr/input-map';

import type { ArcadeSession } from '../arcade/session';
import { feedSteps } from '../feed/feed-next';
import { useShared } from './xr-context';
import { type PanelAim, aimsAtPanel } from './XrPanel';

const pressed = (controller: XRControllerState | undefined, id: string): boolean => controller?.gamepad[id]?.state === 'pressed';

/** Kolo běží: hraje člověk (ne náhled robota) a hra ještě neskončila – i když čeká na první pohyb. */
export const roundRunning = (session: ArcadeSession | null): boolean => session !== null && session.demo() === null && session.snapshot().runState === 'running';

/** Ukazatel ťuku z VR – jiný, než dá prst nebo myš, ať se s jejich stisky nesejde. */
const TAP_POINTER = 9_000;

/**
 * Ťuk na scénu aktivní karty, jak ho dělá prst: stisk a puštění na místě. `ReelFeed` ťuk bez tahu zopakuje
 * na scéně a hru převezme `ArcadePlay` (restart, hodiny běží); do vstupů hry ťuk nejde.
 */
function tapCard(): void {
  const stage = document.querySelector('[data-testid="feed-current"] [data-testid="arcade-stage"]');
  if (stage === null) return;
  const init: PointerEventInit = { bubbles: true, cancelable: true, pointerId: TAP_POINTER, pointerType: 'touch', isPrimary: true };
  stage.dispatchEvent(new PointerEvent('pointerdown', init));
  stage.dispatchEvent(new PointerEvent('pointerup', init));
}

export function XrFeed({ shown, aim }: { readonly shown: ArcadeSession | null; readonly aim: PanelAim }) {
  const steps = useShared(feedSteps, null);
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const flick = useMemo(createFlick, []);
  const owner = useMemo(createTriggerOwner, []);
  const held = useRef(false);
  useEffect(() => {
    if (steps !== null && shown === null) document.querySelector('[data-testid="feed-pager"]')?.scrollIntoView({ block: 'nearest' });
  }, [steps, shown]);
  useFrame(() => {
    if (steps === null) return;
    const stick = right?.gamepad['xr-standard-thumbstick'];
    // Gamepad API: páčka od sebe = záporné y. Mávnutí z kola se počítá i v kole, ať po konci kola samo nelistuje.
    const step = flick(stick?.xAxis ?? 0, -(stick?.yAxis ?? 0));
    if (step !== 0 && !roundRunning(shown)) (step === 1 ? steps.next : steps.prev)();
    const trigger = owner('left', pressed(left, 'xr-standard-trigger'), aimsAtPanel(aim, 'left')) || owner('right', pressed(right, 'xr-standard-trigger'), aimsAtPanel(aim, 'right'));
    const down = trigger || pressed(right, 'a-button') || pressed(left, 'x-button');
    if (down && !held.current && shown?.demo()?.preview === true) tapCard();
    held.current = down;
  });
  return null;
}
