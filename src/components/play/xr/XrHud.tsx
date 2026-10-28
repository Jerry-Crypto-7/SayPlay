'use client';

/**
 * HUD ve VR (P65 T5): cíl, počítadla, výsledek a „AI version ready“ jako 3D panely (`XrPanel`). DOM HUD se
 * v immersive relaci nekreslí; data jsou tatáž, která kreslí 2D (`XrHudSource` v `ArcadePlay`, `UpgradeBanner`).
 *
 * - **Diorama:** tabule stojí za vzdáleným okrajem stolu, nad nízkou scénou – cíl, počítadla a „Exit VR“.
 *   „AI version ready“ visí pod bližším okrajem. Výsledek stojí na bližší polovině stolu, kam se hráč dívá;
 *   po konci běhu smí zakrýt zamrzlou scénu. Všechno jede s deskou, když ji hráč levým gripem posune.
 * - **VR-nativní žánry** (střílečka, hod, krtci, krájení): jeden sloupec nad levým zápěstím, výsledek místo HUD.
 *
 * Panely se natáčejí k hlavě. Velikost roste se vzdáleností od očí (`scale`), ať má text úhlovou velikost
 * textu kitu na 1 m (`KIT_PX`): tabule je od očí ~1,7 m, výsledek a „AI version ready“ ~0,9 m, zápěstí ~0,45 m.
 */

import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { type Group, Vector3 } from 'three';

import { DESK, type Point, TABLE, worldOfDesk } from '@/play/xr/diorama-scale';

import { PLAY_FULL, SO_CLOSE, YOU_DID_IT } from '../starters';
import type { DeskReport } from './Diorama';
import { type XrCounter, type XrHudView, type XrNotice, useXrHud, useXrNotice } from './xr-context';
import { KIT_PX, type PanelAim, type PanelSpec, type PanelStat, XrPanel, layoutOf, specKey, useFonts } from './XrPanel';

export const EXIT_VR = 'Exit VR';
export const AGAIN = 'Again';
export const AI_READY = 'AI version ready';

/** Kotva sloupce: bod desky (osy desky, +z k hráči), nebo levé zápěstí. `hang` = sloupec visí z kotvy dolů. */
type Anchor = { readonly kind: 'desk'; readonly at: Point; readonly scale: number; readonly hang?: boolean } | { readonly kind: 'wrist'; readonly up: number; readonly scale: number };

/** Tabule: spodní hrana 0,25 m nad deskou, 6 cm za vzdáleným okrajem – nad scénou, v horní části zorného pole. */
const BOARD: Anchor = { kind: 'desk', at: { x: 0, y: 0.25, z: -TABLE.depth / 2 - 0.06 }, scale: 1.75 };
/** „AI version ready“: visí z bližšího okraje desky – v dolní části zorného pole a nic na stole nezakryje. */
const APRON: Anchor = { kind: 'desk', at: { x: 0, y: 0.005, z: TABLE.depth / 2 + 0.005 }, scale: 0.95, hang: true };
/** Výsledek: stojí na bližší polovině desky, ~1 m od očí. */
const RESULT: Anchor = { kind: 'desk', at: { x: 0, y: 0.02, z: 0.2 }, scale: 1.1 };
/** Sloupec 5 cm nad levým ovladačem; zápěstí je od očí ~0,4 m, proto menší (text pořád větší než na 1 m). */
const WRIST: Anchor = { kind: 'wrist', up: 0.05, scale: 0.45 };
/** Šířky karet v px kitu. */
const WIDTH = { board: 340, notice: 300, result: 300, wrist: 300 } as const;
/** Mezera mezi panely ve sloupci (px kitu, se stínem karty). */
const STACK_GAP = 16;

/** Počítadlo, jehož text svůj popisek už nese („5 shots left“, „Best 120“), se nepopisuje dvakrát. */
const statsOf = (counters: readonly XrCounter[]): PanelStat[] =>
  counters.map(({ label, text }) => ({ value: text, caption: text.toLowerCase().includes(label.toLowerCase()) ? null : label, label }));

const hudOf = (view: XrHudView, width: number, exit: () => void): PanelSpec => ({
  id: 'hud',
  width,
  body: view.goalLine,
  stats: statsOf(view.counters),
  buttons: [{ id: 'exit', label: EXIT_VR, press: exit }],
  inline: true,
});

/** Výsledek: nadpis kitu, konečná počítadla, „Again“ (jediná rajčatová akce) a „Exit VR“ zpátky k 2D výsledku. */
const resultOf = (view: XrHudView, width: number, exit: () => void): PanelSpec => ({
  id: 'result',
  width,
  headline: view.result === 'won' ? YOU_DID_IT : SO_CLOSE,
  stats: statsOf(view.counters),
  buttons: [
    { id: 'again', label: AGAIN, primary: true, press: view.again },
    { id: 'exit', label: EXIT_VR, press: exit },
  ],
});

const noticeOf = (notice: XrNotice, width: number): PanelSpec => ({
  id: 'notice',
  width,
  title: AI_READY,
  buttons: notice.kind === 'ready' ? [{ id: 'open', label: PLAY_FULL, primary: true, press: notice.open }] : [],
  inline: true,
});

/** Sloupec panelů (`specs` odspodu nahoru, u `hang` shora dolů) přichycený ke kotvě a natočený k hlavě. */
function XrColumn({ anchor, specs, desk, aim }: { readonly anchor: Anchor; readonly specs: readonly PanelSpec[]; readonly desk: RefObject<DeskReport | null>; readonly aim: PanelAim }) {
  const group = useRef<Group>(null);
  const left = useXRInputSourceState('controller', 'left');
  const space = useXR((xr) => xr.originReferenceSpace);
  // Výchozí hlava (stojící hráč), než přijde první póza brýlí.
  const head = useMemo(() => new Vector3(0, 1.6, 0), []);
  const fonts = useFonts();
  const content = specs.map(specKey).join('\n');
  // Rozvržení podle obsahu (a načteného písma), ne podle identity – `XrHud` skládá nové pole každý render.
  const layouts = useMemo(() => specs.map(layoutOf), [content, fonts]);
  const latest = useRef(specs);
  useEffect(() => {
    latest.current = specs;
  });

  useFrame((_, __, frame: XRFrame | undefined) => {
    const column = group.current;
    if (column === null) return;
    if (anchor.kind === 'desk') {
      const at = worldOfDesk(desk.current ?? DESK, anchor.at);
      column.position.set(at.x, at.y, at.z);
    } else {
      const pose = left !== undefined && space !== undefined && frame !== undefined ? frame.getPose(left.inputSource.gripSpace ?? left.inputSource.targetRaySpace, space) : undefined;
      // Bez pózy (ztracené sledování) zůstane sloupec, kde byl.
      if (pose != null) column.position.set(pose.transform.position.x, pose.transform.position.y + anchor.up, pose.transform.position.z);
    }
    column.scale.setScalar(anchor.scale);
    // Hlava z pózy brýlí v tomto snímku: kamera XR je před kreslením ještě z minulého snímku a její světová
    // matice se teprve skládá (`getWorldPosition` v `useFrame` vrací nesmysl a panel by se otočil zády).
    const viewer = space !== undefined ? frame?.getViewerPose(space) : undefined;
    if (viewer != null) head.set(viewer.transform.position.x, viewer.transform.position.y, viewer.transform.position.z);
    column.lookAt(head);
  });

  const hang = anchor.kind === 'desk' && anchor.hang === true;
  let y = 0;
  return (
    <group ref={group}>
      {layouts.map((layout) => {
        // Počátek panelu je uprostřed jeho spodní hrany.
        const at = hang ? y - layout.height * KIT_PX : y;
        y += (hang ? -1 : 1) * (layout.height + STACK_GAP) * KIT_PX;
        return (
          <XrPanel
            key={layout.id}
            layout={layout}
            y={at}
            aim={aim}
            press={(button) =>
              latest.current
                .find((spec) => spec.id === layout.id)
                ?.buttons?.find((candidate) => candidate.id === button)
                ?.press()
            }
          />
        );
      })}
    </group>
  );
}

/**
 * HUD hry na obrazovce ve VR; `diorama` = hra na stole, jinak zápěstí. `desk` je deska dioramy (`Diorama`).
 * `XrRig` ho kreslí jen s hrou na obrazovce: mezi dvěma hrami (výměna za AI verzi) by panel přeskočil na zápěstí.
 */
export function XrHud({ diorama, desk, aim }: { readonly diorama: boolean; readonly desk: RefObject<DeskReport | null>; readonly aim: PanelAim }) {
  const view = useXrHud();
  const notice = useXrNotice();
  const session = useXR((xr) => xr.session);
  const left = useXRInputSourceState('controller', 'left');
  // Konec relace: brýle se vrátí do 2D a stránka ukazuje výsledek (`PostRun`), odkud jde sdílet a remixovat.
  const exit = useCallback(() => void session?.end(), [session]);
  const top = (width: number): PanelSpec[] => (notice === null ? [] : [noticeOf(notice, width)]);

  if (diorama) {
    return (
      <>
        {view !== null && view.result === null && <XrColumn anchor={BOARD} specs={[hudOf(view, WIDTH.board, exit)]} desk={desk} aim={aim} />}
        {view !== null && view.result !== null && <XrColumn anchor={RESULT} specs={[resultOf(view, WIDTH.result, exit)]} desk={desk} aim={aim} />}
        {notice !== null && <XrColumn anchor={APRON} specs={top(WIDTH.notice)} desk={desk} aim={aim} />}
      </>
    );
  }
  const wrist = [...(view === null ? [] : [view.result === null ? hudOf(view, WIDTH.wrist, exit) : resultOf(view, WIDTH.wrist, exit)]), ...top(WIDTH.wrist)];
  // Bez levého ovladače sloupec není: neviditelné tlačítko by paprsek pořád našel.
  return wrist.length > 0 && left !== undefined ? <XrColumn anchor={WRIST} specs={wrist} desk={desk} aim={aim} /> : null;
}
