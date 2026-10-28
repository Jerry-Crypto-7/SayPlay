/**
 * Diorama ve VR (P65 T4): žánry mimo čtyři VR-nativní (střílečka, hod, krtci, krájení) se hrají jako zmenšený svět
 * na stole. Deska 1,2 × 1,2 m stojí 0,9 m před hráčem ve výšce 0,8 m; měřítko se spočte z velikosti hřiště, aby
 * se celá hrací plocha vešla na šířku desky (nejvýš 1:12). Hřiště delší nebo vyšší, než deska unese (trať běžce,
 * věž stohování), je okno, které se pod hrdinou posouvá: hlava hráče i deska stojí, jede svět.
 *
 * Vše je jen kresba. Do hashovaného stavu nejde nic – ani okno, ani poloha desky, kterou hráč posune levým gripem.
 *
 * Osy scény: x zrcadlí jádro (x scény = −x jádra), y nahoru, z vpřed (trať běží po +z). Osy desky: x doprava,
 * y nad deskou, z k hráči (bližší kraj desky je +z).
 */

import { baseControlOf } from '@/play/arcade/addons';
import { type ArcadeWorld, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { PUSH } from '@/play/arcade/pieces/push-ring';

/** Deska ve skutečném prostoru (m, `local-floor`): střed 0,9 m před hráčem, nad ní 0,75 m prostoru pro svět. */
export const TABLE = { x: 0, top: 0.8, z: -0.9, width: 1.2, depth: 1.2, height: 0.75 } as const;

/** Největší měřítko: malé hřiště (souboj, slučování) se nezvětší nad 1:12, ať je pořád diorama, ne hračka v ruce. */
export const SCALE_MAX = 1 / 12;

/**
 * Hřiště nejvýš 2× větší než deska v měřítku podle šířky se zmenší, aby se vešlo celé (aréna 40 × 40 m). Větší
 * je trať (běžec 600 m, věž 22 m, fronta not rytmu) – ta se nezmenšuje do nečitelna, ale posouvá.
 */
const FIT_STRETCH = 2;

/**
 * Hlava hráče pro kontrolu zorného pole: oči ve výšce 1,6 m (stojící hráč, výchozí hlava emulátoru IWER) nad
 * středem prostoru, pohled na střed desky. Zorné pole 80° × 80° – Quest 2 má na oko ~90°, zbytek je rezerva na
 * rozmazaný okraj čočky.
 */
export const HEAD = { y: 1.6, fov: 80 } as const;

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Kvádr v metrech scény. */
export interface Box {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Hrací plocha ze startu úrovně: kvádr živých kreslených těl (ne logika, ne počítadla nulové velikosti), u arény
 * a souboje sjednocený se čtvercem stěn (`half` ovládání) a u tlačení s ringem (`PUSH.radius`) – stěny ani ring
 * nejsou těla, a aréna by se jinak měřila jen podle toho, kde zrovna leží věci.
 *
 * Proč těla a ne scéna: těla jsou ve všech 19 žánrech, nezávisí na načtených modelech a dají se spočíst bez
 * kreslení (test). Kde scéna kreslí jinde než tělo (ohyb trati běžce, posuvník stohování), to dorovná okno, které
 * jede za kresleným hrdinou (`createDiorama`).
 */
export function playAreaOf(world: ArcadeWorld): Box {
  const state = world.initial;
  const count = state[HEADER.bodyCount] as number;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    const role = state[base + BODY.role] as number;
    const w = state[base + BODY.w] as number;
    const h = state[base + BODY.h] as number;
    const d = state[base + BODY.d] as number;
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || role === ROLE.logic || role === ROLE.thing || Math.max(w, h, d) <= 1) continue;
    const x = state[base + BODY.x] as number;
    const y = state[base + BODY.y] as number;
    const z = state[base + BODY.z] as number;
    minX = Math.min(minX, -(x + w / 2) / UNIT);
    maxX = Math.max(maxX, -(x - w / 2) / UNIT);
    minY = Math.min(minY, y / UNIT);
    maxY = Math.max(maxY, (y + h) / UNIT);
    minZ = Math.min(minZ, (z - d / 2) / UNIT);
    maxZ = Math.max(maxZ, (z + d / 2) / UNIT);
  }
  const control = baseControlOf(world.control);
  const half = control.id === 'push' ? PUSH.radius : (control.params as { half?: unknown }).half;
  if (typeof half === 'number') {
    const edge = half / UNIT;
    minX = Math.min(minX, -edge);
    maxX = Math.max(maxX, edge);
    minZ = Math.min(minZ, -edge);
    maxZ = Math.max(maxZ, edge);
  }
  return { minX, maxX, minY: Math.min(minY, 0), maxY, minZ, maxZ };
}

/** Měřítko dioramy: šířka hřiště na šířku desky (nejvýš 1:12); hloubka a výška, jen když se vejdou celé (`FIT_STRETCH`). */
export function dioramaScale(area: Box): number {
  let scale = Math.min(SCALE_MAX, TABLE.width / Math.max(area.maxX - area.minX, 1e-3));
  const depth = area.maxZ - area.minZ;
  if (depth * scale <= FIT_STRETCH * TABLE.depth) scale = Math.min(scale, TABLE.depth / depth);
  const height = area.maxY - area.minY;
  if (height * scale <= FIT_STRETCH * TABLE.height) scale = Math.min(scale, TABLE.height / height);
  return scale;
}

/** Kde svět na desce leží: měřítko a bod scény, který sedí na středu desky (x, z) a na její ploše (y). */
export interface DioramaView {
  readonly scale: number;
  readonly center: Point;
}

type Band = readonly [number, number];

/**
 * Pás okna (zlomky od bližšího, spodního kraje), ve kterém hrdina smí být, než okno pojede za ním:
 * - `fit` – hřiště se vejde a okno stojí; hrdina ho posune, jen kdyby kresbou vyjel z desky (ohyb trati). Celé
 *   okno: hrdina arény u stěny (19,5 m z 20) je pořád na desce a deska se kvůli němu nehne;
 * - `ahead` – trať: hrdina v bližší třetině, zbytek desky ukazuje, co přijde;
 * - `lift` – výška: hrdina pod horním krajem, zem dole smí pod desku (věž, sestup přistávače).
 */
const BAND = { fit: [0, 1], ahead: [0.1, 0.35], lift: [0, 0.8] } as const satisfies Record<string, Band>;

/** Spodní kraj okna velikosti `size`, posunutý jen tolik, aby `at` ležel v pásu `band`. */
const follow = (lo: number, size: number, at: number, band: Band): number => Math.min(at - band[0] * size, Math.max(at - band[1] * size, lo));

/**
 * Okno dioramy nad hřištěm. Měřítko je pevné po celou hru (zoom za běhu by se houpal); okno jede za kresleným
 * hrdinou snímek po snímku (`frame`) – plynule, protože scény hrdinu mezi tiky prolínají. Stav okna je jen kresba.
 */
export function createDiorama(area: Box) {
  const scale = dioramaScale(area);
  const size = { x: TABLE.width / scale, y: TABLE.height / scale, z: TABLE.depth / scale };
  const fitsY = area.maxY - area.minY <= size.y;
  const fitsZ = area.maxZ - area.minZ <= size.z;
  const band = { x: BAND.fit, y: fitsY ? BAND.fit : BAND.lift, z: fitsZ ? BAND.fit : BAND.ahead };
  const lo = { x: (area.minX + area.maxX - size.x) / 2, y: area.minY, z: fitsZ ? (area.minZ + area.maxZ - size.z) / 2 : area.minZ };
  return {
    scale,
    /** Další snímek: `hero` je kreslený hrdina v metrech scény, `null` = scéna ho nekreslí (okno stojí). */
    frame(hero: Point | null): DioramaView {
      if (hero !== null) {
        lo.x = follow(lo.x, size.x, hero.x, band.x);
        // Zem nikdy nad desku: hrdina pod zemí (pád do jámy) zmizí pod deskou, svět se za ním nepropadá.
        lo.y = Math.max(area.minY, follow(lo.y, size.y, hero.y, band.y));
        lo.z = follow(lo.z, size.z, hero.z, band.z);
      }
      return { scale, center: { x: lo.x + size.x / 2, y: lo.y, z: lo.z + size.z / 2 } };
    },
  };
}

/** Bod scény na desce (m, osy desky): obal světa je otočený o půl kruhu, hráč stojí na straně −z scény. */
export const deskPointOf = ({ scale, center }: DioramaView, at: Point): Point => ({
  x: scale * (center.x - at.x),
  y: scale * (at.y - center.y),
  z: scale * (center.z - at.z),
});

/** Leží bod desky v prostoru nad ní (`TABLE`)? `slack` (m) povolí přesah, třeba o půl hrdiny. */
export const onDesk = (at: Point, slack = 0): boolean =>
  Math.abs(at.x) <= TABLE.width / 2 + slack && Math.abs(at.z) <= TABLE.depth / 2 + slack && at.y >= -slack && at.y <= TABLE.height + slack;

/** Poloha desky v prostoru: střed plochy a otočení kolem svislé osy (rad). Levý grip ji nese (`carried`). */
export interface DeskPose {
  readonly x: number;
  readonly top: number;
  readonly z: number;
  readonly yaw: number;
}

export const DESK: DeskPose = { x: TABLE.x, top: TABLE.top, z: TABLE.z, yaw: 0 };

/** Bod desky → skutečný prostor (otočení kolem y jako three.js: (x, z) → (x cos + z sin, −x sin + z cos)). */
export function worldOfDesk(desk: DeskPose, at: Point): Point {
  const cos = Math.cos(desk.yaw);
  const sin = Math.sin(desk.yaw);
  return { x: desk.x + at.x * cos + at.z * sin, y: desk.top + at.y, z: desk.z - at.x * sin + at.z * cos };
}

/** Skutečný prostor → bod desky (inverze `worldOfDesk`). */
export function deskOfWorld(desk: DeskPose, at: Point): Point {
  const cos = Math.cos(desk.yaw);
  const sin = Math.sin(desk.yaw);
  const dx = at.x - desk.x;
  const dz = at.z - desk.z;
  return { x: dx * cos - dz * sin, y: at.y - desk.top, z: dx * sin + dz * cos };
}

/** Ruka v prostoru: poloha a otočení kolem svislé osy (rad). */
export interface HandPose extends Point {
  readonly yaw: number;
}

/**
 * Deska nesená levým gripem: drží se ruky jako tuhé těleso, ale jen posunem a otočením kolem svislé osy –
 * naklopená deska by svět vysypala. `desk` a `from` jsou z chvíle stisku gripu, `to` je ruka teď.
 */
export function carried(desk: DeskPose, from: HandPose, to: HandPose): DeskPose {
  const turn = to.yaw - from.yaw;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const dx = desk.x - from.x;
  const dz = desk.z - from.z;
  return { x: to.x + dx * cos + dz * sin, top: desk.top + to.y - from.y, z: to.z - dx * sin + dz * cos, yaw: desk.yaw + turn };
}

/** Je bod skutečného prostoru v zorném poli hlavy (`HEAD`), která se dívá na střed desky `desk`? */
export function inHeadView(at: Point, desk: DeskPose = DESK): boolean {
  const eye = { x: 0, y: HEAD.y, z: 0 };
  const look = { x: desk.x - eye.x, y: desk.top - eye.y, z: desk.z - eye.z };
  const length = Math.hypot(look.x, look.y, look.z);
  const forward = { x: look.x / length, y: look.y / length, z: look.z / length };
  // Vpravo = vpřed × nahoru, nahoru pohledu = vpravo × vpřed.
  const side = Math.hypot(forward.z, forward.x);
  const right = { x: -forward.z / side, y: 0, z: forward.x / side };
  const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x };
  const v = { x: at.x - eye.x, y: at.y - eye.y, z: at.z - eye.z };
  const ahead = v.x * forward.x + v.y * forward.y + v.z * forward.z;
  if (ahead <= 0) return false;
  const edge = Math.tan(((HEAD.fov / 2) * Math.PI) / 180);
  return Math.abs((v.x * right.x + v.y * right.y + v.z * right.z) / ahead) <= edge && Math.abs((v.x * up.x + v.y * up.y + v.z * up.z) / ahead) <= edge;
}
