'use client';

/**
 * Panel „Comfort“ ve VR (P67 T9): otevře ho „Comfort“ na lobby nebo na výsledku a stojí místo nich, karta kitu
 * metr před hráčem jako lobby – na stole, pódiu i zápěstí stejně velká a stejně čitelná. Volby jsou v `comfort.ts`.
 *
 * - „Standing“ / „Seated“: vsedě klesne stůl, pódium i svět kolem hráče o 40 cm (`SEATED_DROP`);
 * - „Recenter“: svět se otočí k pohledu hráče a postaví se před něj. Hýbe se svět, ne hlava, a jen na stisk;
 * - „Small“ / „Medium“ / „Large“: velikost světa (`SIZES`); „Small“ dá tratě a hry kolem hráče na stůl;
 * - „Haptics on/off“, „Vignette on/off“: vibrace ovladačů a vinětace pódia. Přepínače `setHapticsOn`
 *   a `setVignetteOn` nastavuje `XrRig` z uložených voleb;
 * - „Done“ (jediná rajčatová akce) panel zavře.
 *
 * Vybraná volba má inkoustovou výplň jako `.sp-chip.is-selected`; vypínače nesou stav i v textu („Haptics off“).
 * Řady mřížky jsou skupiny: jak hráč stojí, velikost světa, vibrace a vinětace.
 */

import { useFrame } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { useRef } from 'react';

import { type Comfort, type WorldSize, closeComfort, recenterTo, setComfort, useComfort, yawOfHead } from '@/play/xr/comfort';

import type { DeskReport } from './Diorama';
import { type Anchor, COMFORT, XrColumn } from './XrHud';
import type { PanelAim, PanelButton, PanelSpec } from './XrPanel';

export const STANDING = 'Standing';
export const SEATED = 'Seated';
export const RECENTER = 'Recenter';
export const DONE = 'Done';
const SIZE_LABEL: Readonly<Record<WorldSize, string>> = { small: 'Small', medium: 'Medium', large: 'Large' };
const switchLabel = (name: string, on: boolean): string => `${name} ${on ? 'on' : 'off'}`;

/**
 * Metr před hráčem, horní hrana 10 cm pod očima, měřítko 0,8 jako lobby: karta 520 × ~280 px kitu je ~45° široká
 * a sahá do ~26° pod oči; nejmenší písmo kitu (13 px) má ~1,2°, nad 0,9° z pravidel plánu. Níž než lobby, ať je
 * vidět i od stolu, kam se hráč dívá skloněnou hlavou.
 */
const FRONT: Anchor = { kind: 'front', distance: 1, up: -0.1, scale: 0.8 };
/** Šířka karty jako lobby: tři buňky v řadě unesou „Vignette off“ na jeden řádek. */
const WIDTH = 520;

/** Karta pohodlí; `change` dostane celé nové volby, `recenter` a `done` jsou akce. */
export function comfortPanelOf(options: Comfort, change: (next: Comfort) => void, recenter: () => void, done: () => void): PanelSpec {
  const choose = (patch: Partial<Comfort>) => () => change({ ...options, ...patch });
  const sizes: PanelButton[] = (Object.keys(SIZE_LABEL) as WorldSize[]).map((size) => ({ id: size, label: SIZE_LABEL[size], selected: options.size === size, press: choose({ size }) }));
  return {
    id: 'comfort',
    width: WIDTH,
    title: COMFORT,
    grid: {
      columns: 3,
      cells: [
        { id: 'standing', label: STANDING, selected: options.stance === 'standing', press: choose({ stance: 'standing' }) },
        { id: 'seated', label: SEATED, selected: options.stance === 'seated', press: choose({ stance: 'seated' }) },
        { id: 'recenter', label: RECENTER, press: recenter },
        ...sizes,
        { id: 'haptics', label: switchLabel('Haptics', options.haptics), selected: options.haptics, press: choose({ haptics: !options.haptics }) },
        { id: 'vignette', label: switchLabel('Vignette', options.vignette), selected: options.vignette, press: choose({ vignette: !options.vignette }) },
      ],
    },
    buttons: [{ id: 'done', label: DONE, primary: true, press: done }],
  };
}

export function XrComfort({ aim }: { readonly aim: PanelAim }) {
  const options = useComfort();
  const space = useXR((xr) => xr.originReferenceSpace);
  // Kotva `desk` tu není; sloupec ref jen vyžaduje.
  const desk = useRef<DeskReport | null>(null);
  // „Recenter“ čte hlavu z pózy brýlí v dalším snímku (kamera XR mimo snímek drží starou pózu).
  const recentering = useRef(false);
  useFrame((_, __, frame: XRFrame | undefined) => {
    if (!recentering.current) return;
    const viewer = space !== undefined ? frame?.getViewerPose(space) : undefined;
    if (viewer == null) return;
    const { position, orientation } = viewer.transform;
    // Hlava svisle dolů nebo nahoru směr nemá: počká se na snímek, kdy ho má.
    const yaw = yawOfHead(orientation);
    if (yaw === null) return;
    recentering.current = false;
    recenterTo({ x: position.x, z: position.z, yaw });
  });
  const spec = comfortPanelOf(
    options,
    (next) => setComfort(next),
    () => {
      recentering.current = true;
    },
    closeComfort,
  );
  return <XrColumn anchor={FRONT} specs={[spec]} desk={desk} aim={aim} />;
}
