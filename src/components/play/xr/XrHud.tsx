'use client';

/**
 * HUD ve VR (P65 T5): cíl, počítadla, výsledek a „AI version ready“ jako 3D panely (`XrPanel`). DOM HUD se
 * v immersive relaci nekreslí; data jsou tatáž, která kreslí 2D (`XrHudSource` v `ArcadePlay`, `UpgradeBanner`).
 *
 * - **Diorama:** tabule stojí za vzdáleným okrajem stolu, nad nízkou scénou – cíl, počítadla a „Exit VR“.
 *   „AI version ready“ visí pod bližším okrajem. Výsledek stojí na bližší polovině stolu, kam se hráč dívá;
 *   po konci běhu smí zakrýt zamrzlou scénu. Všechno jede s deskou, když ji hráč levým gripem posune.
 * - **Pódium tratí** (P67 T7): tabule stojí nad horní hranou vzdáleného kraje pódia – výš, než kam se promítne
 *   cokoli z prostoru pódia, takže trať nezakryje. „AI version ready“ visí z téhož místa dolů přes mlhu na konci
 *   trati, výsledek stojí na bližší části pódia. Panely mají tutéž úhlovou velikost jako na stole (`onStage`).
 * - **VR-nativní žánry** (střílečka, hod, krtci, krájení): jeden sloupec nad levým zápěstím, výsledek místo HUD.
 *
 * „Share“ na výsledku (P67 T5) dá na jeho místo kartu s QR kódem odkazu (`XrShare`).
 *
 * Panely se natáčejí k hlavě. Velikost roste se vzdáleností od očí (`scale`), ať má text úhlovou velikost
 * textu kitu na 1 m (`KIT_PX`): tabule je od očí ~1,7 m, výsledek a „AI version ready“ ~0,9 m, zápěstí ~0,45 m.
 */

import { useFrame } from '@react-three/fiber';
import { useXR, useXRInputSourceState } from '@react-three/xr';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Group, Vector3 } from 'three';

import { openComfort, useHeading } from '@/play/xr/comfort';
import { DESK, type DeskPose, HEAD, type Point, STAGE, STAGE_POSE, TABLE, worldOfDesk } from '@/play/xr/diorama-scale';

import { feedSteps } from '../feed/feed-next';
import { PLAY_FULL, SO_CLOSE, YOU_DID_IT } from '../starters';
import type { DeskReport } from './Diorama';
import { type XrCounter, type XrHudView, type XrNotice, useShared, useXrHud, useXrNotice } from './xr-context';
import { openXrLobby } from './xr-lobby';
import { KIT_PX, type PanelAim, type PanelSpec, type PanelStat, XrPanel, layoutOf, specKey, useFonts } from './XrPanel';
import { SHARE, playingVersion, sharePanelOf, useShareLink } from './XrShare';

export const EXIT_VR = 'Exit VR';
export const AGAIN = 'Again';
export const AI_READY = 'AI version ready';
/** Výsledek → VR lobby s kartami vět (P67 T2). */
export const NEW_GAME = 'New game';
/** Výsledek ve feedu → další karta (P67 T4). */
export const NEXT = 'Next';
/** Výsledek a lobby → panel pohodlí (P67 T9, `XrComfort`). */
export const COMFORT = 'Comfort';

/**
 * Kotva sloupce: bod desky (osy desky, +z k hráči), levé zápěstí, nebo místo před hráčem (`front`, P67 T2 lobby):
 * `distance` m před hlavou ve směru pohledu (jen otočení kolem svislé osy) a horní hrana `up` m nad očima,
 * spočtené z první pózy brýlí a pak pevné – nabídka nejezdí s hlavou. `hang` = sloupec visí z kotvy dolů
 * (`front` visí vždy).
 */
export type Anchor =
  | { readonly kind: 'desk'; readonly at: Point; readonly scale: number; readonly hang?: boolean }
  | { readonly kind: 'wrist'; readonly up: number; readonly scale: number }
  | { readonly kind: 'front'; readonly distance: number; readonly up: number; readonly scale: number };

type DeskAnchor = Extract<Anchor, { kind: 'desk' }>;

/** Tabule: spodní hrana 0,25 m nad deskou, 6 cm za vzdáleným okrajem – nad scénou, v horní části zorného pole. */
const BOARD: DeskAnchor = { kind: 'desk', at: { x: 0, y: 0.25, z: -TABLE.depth / 2 - 0.06 }, scale: 1.75 };
/** „AI version ready“: visí z bližšího okraje desky – v dolní části zorného pole a nic na stole nezakryje. */
const APRON: DeskAnchor = { kind: 'desk', at: { x: 0, y: 0.005, z: TABLE.depth / 2 + 0.005 }, scale: 0.95, hang: true };
/** Výsledek: stojí na bližší polovině desky, ~1 m od očí. */
const RESULT: DeskAnchor = { kind: 'desk', at: { x: 0, y: 0.02, z: 0.2 }, scale: 1.1 };

/** Vzdálenost kotvy od očí stojícího hráče (`HEAD`) při výchozí poloze desky. */
const away = (pose: DeskPose, at: Point): number => {
  const real = worldOfDesk(pose, at);
  return Math.hypot(real.x, real.y - HEAD.y, real.z);
};

/** Kotva pódia (T7) se stejnou úhlovou velikostí panelu, jakou má `desk` na stole. */
const onStage = (desk: DeskAnchor, at: Point): DeskAnchor => ({ ...desk, at, scale: (desk.scale * away(STAGE_POSE, at)) / away(DESK, desk.at) });

/** Vzdálený kraj pódia v úrovni horní hrany jeho prostoru: tabule odtud stojí nahoru, oznámení visí dolů. */
const STAGE_FAR_TOP: Point = { x: 0, y: STAGE.height, z: -STAGE.depth / 2 - 0.06 };
const STAGE_ANCHORS = {
  board: onStage(BOARD, STAGE_FAR_TOP),
  apron: onStage(APRON, STAGE_FAR_TOP),
  // Výsledek na bližší části pódia, 0,35 m od kraje (~1,7 m od očí).
  result: onStage(RESULT, { x: 0, y: 0.02, z: STAGE.depth / 2 - 0.35 }),
};
const DESK_ANCHORS = { board: BOARD, apron: APRON, result: RESULT };

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

/**
 * Výsledek: nadpis kitu, konečná počítadla, „Again“ (jediná rajčatová akce) přes celou šířku, nad ním vedlejší
 * „New game“ do VR lobby (P67 T2) a „Exit VR“ zpátky k 2D výsledku. Tři tlačítka v jedné řadě by se do karty
 * 300 px nevešla a širší karta by na zápěstí přesáhla zorné pole. Ve feedu (`next`, P67 T4) stojí vedle „Again“
 * vedlejší „Next“ na další kartu. „Comfort“ (P67 T9) otevře panel pohodlí místo výsledku, „Share“ (P67 T5) kartu
 * s QR kódem odkazu (`XrShare`) – jen když adresa nese hranou verzi (`share` není `null`).
 */
const resultOf = (view: XrHudView, width: number, exit: () => void, next: (() => void) | null, share: (() => void) | null): PanelSpec => ({
  id: 'result',
  width,
  headline: view.result === 'won' ? YOU_DID_IT : SO_CLOSE,
  stats: statsOf(view.counters),
  grid: {
    columns: 2,
    cells: [
      { id: 'new', label: NEW_GAME, press: openXrLobby },
      { id: 'exit', label: EXIT_VR, press: exit },
      { id: 'comfort', label: COMFORT, press: openComfort },
      ...(share === null ? [] : [{ id: 'share', label: SHARE, press: share }]),
    ],
  },
  buttons: [...(next === null ? [] : [{ id: 'next', label: NEXT, press: next }]), { id: 'again', label: AGAIN, primary: true, press: view.again }],
});

const noticeOf = (notice: XrNotice, width: number): PanelSpec => ({
  id: 'notice',
  width,
  title: AI_READY,
  buttons: notice.kind === 'ready' ? [{ id: 'open', label: PLAY_FULL, primary: true, press: notice.open }] : [],
  inline: true,
});

/** Sloupec panelů (`specs` odspodu nahoru, u `hang` shora dolů) přichycený ke kotvě a natočený k hlavě. */
export function XrColumn({ anchor, specs, desk, aim }: { readonly anchor: Anchor; readonly specs: readonly PanelSpec[]; readonly desk: RefObject<DeskReport | null>; readonly aim: PanelAim }) {
  const group = useRef<Group>(null);
  const left = useXRInputSourceState('controller', 'left');
  const space = useXR((xr) => xr.originReferenceSpace);
  // Výchozí hlava (stojící hráč), než přijde první póza brýlí.
  const head = useMemo(() => new Vector3(0, 1.6, 0), []);
  // Místo kotvy `front`, jakmile ho první póza brýlí určí; „Recenter“ (P67 T9) ho určí znovu před hlavou.
  const placed = useRef<Vector3 | null>(null);
  const heading = useHeading();
  useEffect(() => {
    placed.current = null;
  }, [heading]);
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
    // Hlava z pózy brýlí v tomto snímku: kamera XR je před kreslením ještě z minulého snímku a její světová
    // matice se teprve skládá (`getWorldPosition` v `useFrame` vrací nesmysl a panel by se otočil zády).
    const viewer = space !== undefined ? frame?.getViewerPose(space) : undefined;
    if (viewer != null) head.set(viewer.transform.position.x, viewer.transform.position.y, viewer.transform.position.z);
    if (anchor.kind === 'desk') {
      const at = worldOfDesk(desk.current ?? DESK, anchor.at);
      column.position.set(at.x, at.y, at.z);
    } else if (anchor.kind === 'front') {
      if (placed.current === null && viewer != null) {
        // Směr pohledu bez sklonu; hlava svisle dolů nebo nahoru nemá vodorovný směr, pak rovně (−z).
        const { x, y, z, w } = viewer.transform.orientation;
        const ahead = new Vector3(-2 * (x * z + w * y), 0, -(1 - 2 * (x * x + y * y)));
        if (ahead.lengthSq() < 1e-6) ahead.set(0, 0, -1);
        ahead.normalize().multiplyScalar(anchor.distance);
        placed.current = new Vector3(head.x + ahead.x, head.y + anchor.up, head.z + ahead.z);
      }
      column.position.copy(placed.current ?? new Vector3(head.x, head.y + anchor.up, head.z - anchor.distance));
    } else {
      const pose = left !== undefined && space !== undefined && frame !== undefined ? frame.getPose(left.inputSource.gripSpace ?? left.inputSource.targetRaySpace, space) : undefined;
      // Bez pózy (ztracené sledování) zůstane sloupec, kde byl.
      if (pose != null) column.position.set(pose.transform.position.x, pose.transform.position.y + anchor.up, pose.transform.position.z);
    }
    column.scale.setScalar(anchor.scale);
    // Natočení jen kolem svislé osy u `front`: velká nabídka visí svisle, i když se hráč skloní.
    if (anchor.kind === 'front') column.lookAt(head.x, column.position.y, head.z);
    else column.lookAt(head);
  });

  const hang = anchor.kind === 'front' || (anchor.kind === 'desk' && anchor.hang === true);
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
            press={(button) => {
              const spec = latest.current.find((candidate) => candidate.id === layout.id);
              [...(spec?.grid?.cells ?? []), ...(spec?.buttons ?? [])].find((candidate) => candidate.id === button)?.press();
            }}
          />
        );
      })}
    </group>
  );
}

/**
 * HUD hry na obrazovce ve VR; `diorama` = hra na stole (`stage` = na pódiu tratí), jinak zápěstí. `desk` je deska
 * dioramy (`Diorama`). `XrRig` ho kreslí jen s hrou na obrazovce: mezi dvěma hrami (výměna za AI verzi) by panel
 * přeskočil na zápěstí.
 */
export function XrHud({ diorama, stage, desk, aim }: { readonly diorama: boolean; readonly stage: boolean; readonly desk: RefObject<DeskReport | null>; readonly aim: PanelAim }) {
  const view = useXrHud();
  const notice = useXrNotice();
  const session = useXR((xr) => xr.session);
  const left = useXRInputSourceState('controller', 'left');
  // Konec relace: brýle se vrátí do 2D a stránka ukazuje výsledek (`PostRun`), odkud jde sdílet a remixovat.
  const exit = useCallback(() => void session?.end(), [session]);
  // Ve feedu (P67 T4) vede výsledek i na další kartu.
  const next = useShared(feedSteps, null)?.next ?? null;
  const top = (width: number): PanelSpec[] => (notice === null ? [] : [noticeOf(notice, width)]);
  // Karta sdílení (P67 T5) stojí místo výsledku, dokud ji „Done“ nezavře; nové kolo nebo karta feedu ji zavře samy.
  const [sharing, setSharing] = useState(false);
  const ended = view !== null && view.result !== null;
  useEffect(() => {
    if (!ended) setSharing(false);
  }, [ended]);
  const link = useShareLink(view, sharing);
  const share = ended && playingVersion(window.location) !== null ? () => setSharing(true) : null;
  const outcome = (shown: XrHudView, width: number): PanelSpec => (link === null ? resultOf(shown, width, exit, next, share) : sharePanelOf(link, width, () => setSharing(false)));

  if (diorama) {
    const anchors = stage ? STAGE_ANCHORS : DESK_ANCHORS;
    return (
      <>
        {view !== null && view.result === null && <XrColumn anchor={anchors.board} specs={[hudOf(view, WIDTH.board, exit)]} desk={desk} aim={aim} />}
        {view !== null && view.result !== null && <XrColumn anchor={anchors.result} specs={[outcome(view, WIDTH.result)]} desk={desk} aim={aim} />}
        {notice !== null && <XrColumn anchor={anchors.apron} specs={top(WIDTH.notice)} desk={desk} aim={aim} />}
      </>
    );
  }
  const wrist = [...(view === null ? [] : [view.result === null ? hudOf(view, WIDTH.wrist, exit) : outcome(view, WIDTH.wrist)]), ...top(WIDTH.wrist)];
  // Bez levého ovladače sloupec není: neviditelné tlačítko by paprsek pořád našel.
  return wrist.length > 0 && left !== undefined ? <XrColumn anchor={WRIST} specs={wrist} desk={desk} aim={aim} /> : null;
}
