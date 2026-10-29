'use client';

/**
 * 3D panel HUD ve VR (P65 T5) podle kitu Sayplay: neprůhledná papírová karta s inkoustovým obrysem a tvrdým
 * stínem bez rozostření, texty Roboto, tlačítka jako `.sp-btn` (rajčatové nejvýš jedno na panel). DOM se
 * v immersive relaci nekreslí, proto se karta kreslí do plátna 2D písmem, které stránka už načetla (`play.css`),
 * a ve scéně je to textura na ploše. Rozměry jsou v pixelech kitu: 1 px kitu = 2 mm ve vzdálenosti 1 m (`KIT_PX`),
 * takže text kitu má ve VR na metr tutéž úhlovou velikost jako na telefonu v ruce. Sloupec panelů ho dál násobí
 * vzdáleností od očí (`XrHud`).
 *
 * Tlačítko je vlastní síť s obsluhou událostí: najde ho paprsek ovladače a spoušť ho stiskne (`@react-three/xr`).
 * Paprsek na tlačítku se zapisuje do `PanelAim`, ať stisk spouště na panelu nejde zároveň do hry (`XrInput`).
 */

import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';

import { borderWidth, color, fontFamily, radius, size, space, typography } from '@/brand/tokens';

/** Metrů na pixel kitu ve vzdálenosti 1 m od očí. */
export const KIT_PX = 0.002;
/** Pixelů plátna na pixel kitu: ~2000 px na metr, víc, než Quest 2 na 1 m rozliší (~1300). */
const RES = 4;
/** Panely se kreslí přes scénu (bez testu hloubky): kulisa dioramy ani svět 1:1 je nezakryjí. Kurzor paprsku má víc (`XrRoot`). */
export const PANEL_ORDER = 1000;
/** Tlačítko leží kousek před kartou (m). */
const KEY_LIFT = 0.0015;

/**
 * Písmo panelů z typografie kitu; text cíle tučně jako `.sp-objective`, ale ve velikosti `body-l`, ne `body-s` –
 * nejmenší text (popisek počítadla, `label` 13 px) má na 1 m 26 mm.
 */
const TYPE = {
  headline: typography['display-m'],
  title: typography['title-m'],
  body: { ...typography['body-l'], weight: 700 },
  value: typography['hud-num'],
  caption: typography.label,
  button: typography['button-l'],
} as const;
type Type = (typeof TYPE)[keyof typeof TYPE];

/** Nejmenší písmo panelu (px kitu) – sonda e2e z něj počítá čitelnost. */
export const MIN_TEXT = Math.min(...Object.values(TYPE).map((type) => type.size));

const PAD = space['4'];
const GAP = space['3'];
const CHIP_PAD = { x: space['3'], y: space['2'] };
const CARD_SHADOW = 5;
const KEY_SHADOW = 3;
const KEY_HEIGHT = size['control-m'];
/** Nejužší tlačítko vedle obsahu (px kitu) – terč paprsku. */
const KEY_MIN = 120;

/** Barvy karet nápadů kitu (`.sp-idea--mint` …); inkoust na nich má kontrast 10,6–11,5:1. */
export type PanelTone = 'mint' | 'sun' | 'sky' | 'bubblegum';

export interface PanelButton {
  readonly id: string;
  readonly label: string;
  /** Rajčatová hlavní akce – nejvýš jedna na panel. */
  readonly primary?: boolean;
  /** Výplň místo papíru: karta nápadu v mřížce `grid`, mikrofon lobby (`sun`, P67 T3). */
  readonly tone?: PanelTone;
  press(): void;
}

/** Mřížka tlačítek (P67 T2): karty vět lobby, klávesy klávesnice. Popisek se zalomí do šířky buňky. */
export interface PanelGrid {
  readonly columns: number;
  readonly cells: readonly PanelButton[];
  /** Mezera mezi buňkami (px kitu), výchozí `space-2`. */
  readonly gap?: number;
}

/** Počítadlo jako `.sp-stat`: hodnota a pod ní popisek (`null` = hodnota se popíše sama, „5 shots left“). */
export interface PanelStat {
  readonly value: string;
  readonly caption: string | null;
  /** Popisek počítadla jako v DOM HUD (`hud-counter-…`) – čte ho sonda e2e. */
  readonly label: string;
}

export interface PanelSpec {
  /** `hud`, `result` nebo `notice` – sonda e2e panely hledá podle něj. */
  readonly id: string;
  /** Šířka karty v px kitu. */
  readonly width: number;
  readonly headline?: string;
  readonly title?: string;
  readonly body?: string;
  /** Chyba pod textem, barvou `alarm` jako `.sp-field-error` (P67 T2). */
  readonly note?: string;
  readonly stats?: readonly PanelStat[];
  /** Mřížka tlačítek pod počítadly, nad řadou `buttons`. */
  readonly grid?: PanelGrid;
  readonly buttons?: readonly PanelButton[];
  /** Tlačítka vedle poslední řady obsahu, ne pod ní – nižší karta tam, kde je v zorném poli málo místa. */
  readonly inline?: boolean;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Line {
  readonly text: string;
  readonly type: Type;
  /** Střed řádku od horního okraje karty (px kitu). */
  readonly y: number;
  /** Barva textu; bez ní inkoust. */
  readonly fill?: string;
}

/** Tlačítko rozvržené na kartě: `lines` = popisek zalomený do šířky (jeden řádek u tlačítek řady). */
interface Key {
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
  readonly tone?: PanelTone;
  readonly lines: readonly string[];
  readonly type: Type;
  readonly rect: Rect;
}

/** Rozvržená karta v px kitu, `y` dolů od horního okraje. */
export interface PanelLayout {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly lines: readonly Line[];
  readonly chips: readonly { readonly stat: PanelStat; readonly rect: Rect }[];
  readonly keys: readonly Key[];
}

const fontOf = (type: Type, scale = 1): string => `${type.weight} ${type.size * scale}px ${fontFamily.display}`;

let measurer: CanvasRenderingContext2D | null = null;
function widthOf(text: string, type: Type): number {
  measurer ??= document.createElement('canvas').getContext('2d');
  if (measurer === null) return text.length * type.size * 0.55;
  measurer.font = fontOf(type, RES);
  return measurer.measureText(text).width / RES;
}

/** Zalomení po slovech do šířky `max` (px kitu); slovo delší než řádek zůstane celé. */
function wrap(text: string, type: Type, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && widthOf(next, type) > max) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Poslední řada obsahu: kde začíná, jak je vysoká a kde končí vpravo – vedle ní smí stát tlačítka (`inline`). */
interface Row {
  readonly top: number;
  readonly h: number;
  readonly right: number;
  readonly lines: Mutable<Line>[];
  readonly chips: { rect: Mutable<Rect> }[];
}

/**
 * Rozvržení karty: nadpis, titulek, text a řada počítadel pod sebou, pak tlačítka – vedle poslední řady
 * (`inline`, vejdou-li se), jinak vlastní řada se stejnou šířkou tlačítek.
 */
export function layoutOf(spec: PanelSpec): PanelLayout {
  const inner = spec.width - 2 * PAD;
  const lines: Mutable<Line>[] = [];
  const last: { row: Row | null } = { row: null };
  let y = PAD;
  const block = (text: string | undefined, type: Type, fill?: string): void => {
    if (text === undefined) return;
    const step = type.size * type.lineHeight;
    for (const part of wrap(text, type, inner)) {
      const line = { text: part, type, y: y + step / 2, ...(fill === undefined ? {} : { fill }) };
      lines.push(line);
      last.row = { top: y, h: step, right: PAD + widthOf(part, type), lines: [line], chips: [] };
      y += step;
    }
    y += GAP;
  };
  block(spec.headline, TYPE.headline);
  block(spec.title, TYPE.title);
  block(spec.body, TYPE.body);
  block(spec.note, TYPE.body, color.alarm);

  const chips: { stat: PanelStat; rect: Mutable<Rect> }[] = [];
  const stats = spec.stats ?? [];
  if (stats.length > 0) {
    const h = 2 * CHIP_PAD.y + TYPE.value.size * TYPE.value.lineHeight + (stats.some((stat) => stat.caption !== null) ? TYPE.caption.size * TYPE.caption.lineHeight : 0);
    let x = PAD;
    let row: { rect: Mutable<Rect> }[] = [];
    for (const stat of stats) {
      const w = Math.min(inner, 2 * CHIP_PAD.x + Math.max(widthOf(stat.value, TYPE.value), stat.caption === null ? 0 : widthOf(stat.caption, TYPE.caption)));
      if (x > PAD && x + w > PAD + inner) {
        x = PAD;
        y += h + space['2'];
        row = [];
      }
      const chip = { stat, rect: { x, y, w, h } };
      chips.push(chip);
      row.push(chip);
      last.row = { top: y, h, right: x + w, lines: [], chips: row };
      x += w + space['2'];
    }
    y += h + GAP;
  }

  // Mřížka: buňky jedné šířky, řada tak vysoká jako nejdelší zalomený popisek v ní, aspoň `control-s`.
  const cells: Key[] = [];
  const grid = spec.grid;
  if (grid !== undefined && grid.cells.length > 0) {
    const gap = grid.gap ?? space['2'];
    const w = (inner - gap * (grid.columns - 1)) / grid.columns;
    const step = TYPE.body.size * TYPE.body.lineHeight;
    for (let from = 0; from < grid.cells.length; from += grid.columns) {
      const row = grid.cells.slice(from, from + grid.columns).map((cell) => ({ cell, lines: wrap(cell.label, TYPE.body, w - 2 * CHIP_PAD.x) }));
      const h = Math.max(size['control-s'], Math.max(...row.map(({ lines: wrapped }) => wrapped.length)) * step + 2 * CHIP_PAD.y);
      row.forEach(({ cell, lines: wrapped }, index) =>
        cells.push({ ...keyFrom(cell, wrapped, TYPE.body), rect: { x: PAD + index * (w + gap), y, w, h } }),
      );
      y += h + gap;
    }
    y += GAP - gap;
    // Tlačítka řady pod mřížkou, ne vedle ní.
    last.row = null;
  }

  const buttons = spec.buttons ?? [];
  const natural = buttons.map((button) => Math.max(KEY_MIN, widthOf(button.label, TYPE.button) + 2 * space['5']));
  const together = natural.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, buttons.length - 1);
  const beside = last.row;
  let keys: Key[];
  if (spec.inline === true && beside !== null && buttons.length > 0 && beside.right + GAP + together <= PAD + inner) {
    // Řada se srovná na výšku tlačítka; obsah řady i tlačítka svisle uprostřed.
    const h = Math.max(beside.h, KEY_HEIGHT);
    for (const line of beside.lines) line.y += (h - beside.h) / 2;
    for (const chip of beside.chips) chip.rect.y += (h - beside.h) / 2;
    let x = PAD + inner - together;
    keys = buttons.map((button, index) => {
      const rect = { x, y: beside.top + (h - KEY_HEIGHT) / 2, w: natural[index]!, h: KEY_HEIGHT };
      x += natural[index]! + GAP;
      return { ...keyFrom(button, [button.label], TYPE.button), rect };
    });
    y = beside.top + h + GAP;
  } else {
    // Stejná šířka, dokud se do ní vejde každý popisek; jinak každé tlačítko na svůj popisek a zbytek řady rovným
    // dílem (P67 T3: lobby s „Say it“ má čtyři tlačítka a „More ideas“ by v čtvrtině řady přetekl).
    const free = inner - GAP * (buttons.length - 1);
    const fitted = buttons.map((button) => widthOf(button.label, TYPE.button) + 2 * space['3']);
    const share = (free - fitted.reduce((sum, w) => sum + w, 0)) / buttons.length;
    const widths = fitted.every((w) => w <= free / buttons.length) ? fitted.map(() => free / buttons.length) : fitted.map((w) => w + share);
    let x = PAD;
    keys = buttons.map((button, index) => {
      const rect = { x, y, w: widths[index]!, h: KEY_HEIGHT };
      x += widths[index]! + GAP;
      return { ...keyFrom(button, [button.label], TYPE.button), rect };
    });
    if (keys.length > 0) y += KEY_HEIGHT + GAP;
  }
  return { id: spec.id, width: spec.width, height: y - GAP + PAD, lines, chips, keys: [...cells, ...keys] };
}

const keyFrom = (button: PanelButton, lines: readonly string[], type: Type): Omit<Key, 'rect'> => ({
  id: button.id,
  label: button.label,
  primary: button.primary === true,
  ...(button.tone === undefined ? {} : { tone: button.tone }),
  lines,
  type,
});

/** Obsah karty bez obsluhy tlačítek – podle něj se karta rozvrhne a nakreslí znovu jen při změně. */
export const specKey = (spec: PanelSpec): string =>
  JSON.stringify([
    spec.id,
    spec.width,
    spec.inline === true,
    spec.headline,
    spec.title,
    spec.body,
    spec.note,
    spec.stats,
    spec.grid === undefined ? null : [spec.grid.columns, spec.grid.gap, spec.grid.cells.map((cell) => [cell.id, cell.label, cell.primary === true, cell.tone])],
    spec.buttons?.map((button) => [button.id, button.label, button.primary === true, button.tone]),
  ]);

function canvasOf(w: number, h: number, shadow: number): { readonly canvas: HTMLCanvasElement; readonly texture: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((w + shadow) * RES);
  canvas.height = Math.ceil((h + shadow) * RES);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return { canvas, texture };
}

/** Obdélník s obrysem uvnitř, jako `border` v CSS. */
function box(ctx: CanvasRenderingContext2D, rect: Rect, corner: number, fill: string, line: number): void {
  ctx.beginPath();
  ctx.roundRect(rect.x + line / 2, rect.y + line / 2, rect.w - line, rect.h - line, corner);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = color.ink;
  ctx.stroke();
}

/** Tvrdý stín kitu: obdélník inkoustu posunutý doprava dolů, bez rozostření. */
function shadowOf(ctx: CanvasRenderingContext2D, rect: Rect, corner: number, offset: number): void {
  ctx.beginPath();
  ctx.roundRect(rect.x + offset, rect.y + offset, rect.w, rect.h, corner);
  ctx.fillStyle = color.ink;
  ctx.fill();
}

function text(ctx: CanvasRenderingContext2D, value: string, type: Type, x: number, y: number, fill: string, align: CanvasTextAlign): void {
  ctx.font = fontOf(type);
  ctx.fillStyle = fill;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y);
}

function drawCard(canvas: HTMLCanvasElement, layout: PanelLayout): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.setTransform(RES, 0, 0, RES, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const card = { x: 0, y: 0, w: layout.width, h: layout.height };
  shadowOf(ctx, card, radius.lg, CARD_SHADOW);
  box(ctx, card, radius.lg, color.paper, borderWidth.base);
  for (const line of layout.lines) text(ctx, line.text, line.type, PAD, line.y, line.fill ?? color.ink, 'left');
  for (const { stat, rect } of layout.chips) {
    box(ctx, rect, radius.md, color.paper, borderWidth.base);
    const value = TYPE.value.size * TYPE.value.lineHeight;
    text(ctx, stat.value, TYPE.value, rect.x + rect.w / 2, rect.y + CHIP_PAD.y + value / 2, color.ink, 'center');
    if (stat.caption !== null) text(ctx, stat.caption, TYPE.caption, rect.x + rect.w / 2, rect.y + CHIP_PAD.y + value + (TYPE.caption.size * TYPE.caption.lineHeight) / 2, color['ink-soft'], 'center');
  }
}

type KeyState = 'rest' | 'aimed' | 'pressed';

/** Tlačítko kitu: v klidu se stínem, s paprskem na něm silnější obrys, stisknuté „zamáčknuté“ do stínu. */
function drawKey(canvas: HTMLCanvasElement, key: Key, state: KeyState): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.setTransform(RES, 0, 0, RES, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sunk = state === 'pressed' ? KEY_SHADOW : 0;
  const face = { x: sunk, y: sunk, w: key.rect.w, h: key.rect.h };
  if (state !== 'pressed') shadowOf(ctx, face, radius.md, KEY_SHADOW);
  box(ctx, face, radius.md, key.primary ? color.tomato : key.tone !== undefined ? color[key.tone] : color.paper, state === 'aimed' ? borderWidth.thick * 1.5 : borderWidth.base);
  // Řádky popisku svisle uprostřed tlačítka.
  const step = key.type.size * key.type.lineHeight;
  const top = sunk + key.rect.h / 2 - (step * (key.lines.length - 1)) / 2;
  key.lines.forEach((line, index) => text(ctx, line, key.type, sunk + key.rect.w / 2, top + index * step, color.ink, 'center'));
}

/** Plátno 2D kreslí písmem stránky, až je načtené: do té doby náhradním, po načtení se karty rozvrhnou znovu. */
export function useFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([TYPE.body.weight, TYPE.headline.weight].map((weight) => document.fonts.load(`${weight} 16px ${fontFamily.display}`))).then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

/** Které ruce mají paprsek na kterém tlačítku (klíč `panel:tlačítko`); čte `XrInput`. */
export type PanelAim = Map<string, ReadonlySet<XRHandedness>>;

export function aimsAtPanel(aim: PanelAim, hand: XRHandedness): boolean {
  for (const hands of aim.values()) if (hands.has(hand)) return true;
  return false;
}

/** Ruka paprsku z události `@react-three/xr` (stav zdroje vstupu ukazatele). */
const handOf = (event: ThreeEvent<PointerEvent>): XRHandedness =>
  (event as unknown as { readonly pointerState?: { readonly inputSource?: XRInputSource } }).pointerState?.inputSource?.handedness ?? 'none';

/** Bod rozvržení (px kitu od levého horního rohu karty) → poloha v panelu (m; počátek uprostřed spodní hrany karty). */
const localOf = (layout: PanelLayout, x: number, y: number): [number, number] => [(x - layout.width / 2) * KIT_PX, (layout.height - y) * KIT_PX];

function PanelKey({ panel, layout, keyOf, aim, press }: { readonly panel: string; readonly layout: PanelLayout; readonly keyOf: PanelLayout['keys'][number]; readonly aim: PanelAim; readonly press: () => void }) {
  const { rect } = keyOf;
  const paint = useMemo(() => canvasOf(rect.w, rect.h, KEY_SHADOW), [rect.w, rect.h]);
  const [state, setState] = useState<KeyState>('rest');
  const hands = useRef(new Set<XRHandedness>());
  const id = `${panel}:${keyOf.id}`;
  useEffect(() => {
    drawKey(paint.canvas, keyOf, state);
    paint.texture.needsUpdate = true;
  }, [paint, keyOf, state]);
  useEffect(() => () => paint.texture.dispose(), [paint]);
  // Tlačítko, které zmizí pod paprskem (výsledek po „Again“), odchod paprsku neohlásí.
  useEffect(
    () => () => {
      aim.delete(id);
    },
    [aim, id],
  );
  const [x, y] = localOf(layout, rect.x + (rect.w + KEY_SHADOW) / 2, rect.y + (rect.h + KEY_SHADOW) / 2);
  return (
    <mesh
      position={[x, y, KEY_LIFT]}
      renderOrder={PANEL_ORDER + 1}
      userData={{ xrButton: keyOf.id, label: keyOf.label, state }}
      onPointerEnter={(event) => {
        hands.current.add(handOf(event));
        aim.set(id, hands.current);
        setState((now) => (now === 'pressed' ? now : 'aimed'));
      }}
      onPointerLeave={(event) => {
        hands.current.delete(handOf(event));
        if (hands.current.size > 0) return;
        aim.delete(id);
        setState('rest');
      }}
      onPointerDown={() => setState('pressed')}
      onPointerUp={() => setState(hands.current.size > 0 ? 'aimed' : 'rest')}
      onClick={press}
    >
      <planeGeometry args={[(rect.w + KEY_SHADOW) * KIT_PX, (rect.h + KEY_SHADOW) * KIT_PX]} />
      <meshBasicMaterial map={paint.texture} transparent depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
    </mesh>
  );
}

/**
 * Jedna karta s tlačítky, počátek uprostřed spodní hrany (sloupec `XrHud` je skládá na sebe). `press` dostane id
 * tlačítka a zavolá jeho aktuální obsluhu – rozvržení se drží, dokud se nezmění obsah, obsluha je vždy čerstvá.
 */
export function XrPanel({ layout, y, aim, press }: { readonly layout: PanelLayout; readonly y: number; readonly aim: PanelAim; readonly press: (button: string) => void }) {
  const paint = useMemo(() => {
    const made = canvasOf(layout.width, layout.height, CARD_SHADOW);
    drawCard(made.canvas, layout);
    return made;
  }, [layout]);
  useEffect(() => () => paint.texture.dispose(), [paint]);
  const [x, cy] = localOf(layout, (layout.width + CARD_SHADOW) / 2, (layout.height + CARD_SHADOW) / 2);
  const text = [...layout.lines.map((line) => line.text), ...layout.chips.map(({ stat }) => (stat.caption === null ? stat.value : `${stat.value} ${stat.caption}`))];
  return (
    <group position={[0, y, 0]} userData={{ xrPanel: layout.id, text, labels: layout.chips.map(({ stat }) => stat.label), minText: MIN_TEXT * KIT_PX }}>
      <mesh position={[x, cy, 0]} renderOrder={PANEL_ORDER}>
        <planeGeometry args={[(layout.width + CARD_SHADOW) * KIT_PX, (layout.height + CARD_SHADOW) * KIT_PX]} />
        <meshBasicMaterial map={paint.texture} transparent depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
      {layout.keys.map((keyOf) => (
        <PanelKey key={keyOf.id} panel={layout.id} layout={layout} keyOf={keyOf} aim={aim} press={() => press(keyOf.id)} />
      ))}
    </group>
  );
}
