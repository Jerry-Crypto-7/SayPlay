/**
 * Záběr kamery arény (P56B T9): kam kamera míří a jak daleko stojí. Vytaženo
 * z `ArenaScene.tsx` (vzor `track-camera.ts`), ať jde záběr spočítat v testu
 * bez plátna. Jen kresba: stav, hash ani robot se nemění.
 */

import { Box3, type Matrix4, type Mesh, type Object3D, Vector3 } from 'three';

import { isInk } from '../look/rig/InkOutline';

/** Sklon kamery nad vodorovnou (sin, cos). */
export interface Tilt {
  readonly sin: number;
  readonly cos: number;
}
const tiltOf = (degrees: number): Tilt => ({ sin: Math.sin((degrees * Math.PI) / 180), cos: Math.cos((degrees * Math.PI) / 180) });
/**
 * Kamera 3/4 shora. P35 T2: 50° → 40°. Při 50° byla kočka shora zezadu jen hřbet
 * a uši a astra ji naslepo nepoznala (O10); při 40° je vidět hlava a bok.
 */
export const STYLED_TILT = tiltOf(40);
/**
 * Souboj strměji (P32E T6): soupeř jde na hrdinu podél osy kamery a při 50°
 * ho hrdina i jeho lišta HP zakryly, zásah i pád se ztratily za zády.
 */
export const FIGHT_TILT = tiltOf(60);
/** Předstih: pohled míří tam, kam hráč dojede za tolik sekund. */
export const LEAD_S = 0.35;
/** Hrozba blíž než tolik metrů táhne záběr k sobě, ať je vidět hráč i ona. Jen na šířku – na výšku rozhoduje strop (`arenaGoal`). */
export const THREAT_M = 22;
/** Kam do obrazu (NDC) se musí vejít hrdina a nejbližší hrozba. */
const HERO_EDGE = 0.8;
const THREAT_EDGE = 0.9;
/** Jak rychle kamera dojíždí za cílem (1/s). */
export const FOLLOW = 5;

/** Kvádr, do kterého scéna kreslí tělo (m). */
export interface Size {
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/** Bod na zemi scény (m). */
export interface Spot {
  readonly x: number;
  readonly z: number;
}

/** Páky záběru. P56B T9 je posunula blíž; test je porovná se stavem `72665fdc`. */
export interface ArenaFraming {
  /** Kamera nikdy blíž než tolik metrů. */
  readonly nearest: number;
  /** Kolik metrů od hráče do strany je vidět vždy – na šířku a na výšku (mobil). */
  readonly see: number;
  readonly seeTall: number;
  /**
   * Hrdina drží aspoň tenhle podíl výšky obrazu – strop vzdálenosti kamery; na výšku víc.
   * P35 T2: dřív 5 % všude a hrozba za zády kameru oddálila až k němu (čaroděj 4,7 %, O10).
   * Kvádr těla je o ~30 % vyšší než model, který do něj sonda záběru měří: 0,085 dalo kočce 6,5 % (1. 10.).
   */
  readonly heroShare: number;
  readonly heroShareTall: number;
  /**
   * Hrozba do `THREAT_M` smí kameru oddálit až na tenhle násobek stropu, ať je s hrdinou v obraze;
   * hrozbu, která se nevejde ani tam, ukáže šipka na okraji. 1 = jen pod strop. Na šířku, na výšku.
   */
  readonly stretch: number;
  readonly stretchTall: number;
}

/**
 * Audit 21. 10.: hrdina malý a daleko, na telefonu nepřítel za okrajem obrazu (08-gems: v 0 % tiků).
 * Hrdina větší (strop 0,1 → 0,14, na výšku 0,11 → 0,18: kamera o ~30–40 % blíž) a blízká hrozba
 * v záběru i nad strop, nejvýš 1,8×, na výšku 2,1× – hrdina pak pořád ≥ 7,8 % výšky obrazu, na výšku
 * 8,6 % (podlaha `e2e/p32-arena.spec.ts` 7 a 8 %; 2,5× dalo kočce na telefonu 6,4 %).
 * `nearest` se neměnil: s hrdinou do 1,3 m vždy rozhoduje strop pod ním (`arena-camera.test.ts`).
 * P58A T4 zkusil tažení 1,4×, na výšku 1,8× (hrdina při 1× ≥ 10 %, čitelnost by ho vždy dotáhla na 20 %): 08-gems
 * na výšku pak měl nepřítele v obraze jen 41 % tiků (podlaha 65 %). Nepřítel v záběru má přednost.
 */
export const ARENA_FRAMING: ArenaFraming = { nearest: 16, see: 9, seeTall: 5, heroShare: 0.14, heroShareTall: 0.18, stretch: 1.8, stretchTall: 2.1 };

/** Nejmenší vzdálenost kamery od cíle pohledu, aby bod (m vůči cíli, poloměr `r`) promítl do ±`edge` NDC. */
export function reachOf(qx: number, qy: number, qz: number, r: number, tan: number, aspect: number, edge: number, tilt: Tilt): number {
  const along = qz * tilt.cos - qy * tilt.sin;
  const up = qy * tilt.cos + qz * tilt.sin;
  return Math.max((Math.abs(qx) + r) / (edge * tan * aspect), (Math.abs(up) + r) / (edge * tan)) - along;
}

/** Co záběr potřebuje vědět o snímku. `tan` = tangenta poloviny svislého zorného úhlu. */
export interface ArenaView {
  readonly hero: Spot;
  readonly heroSize: Size;
  /** Kam hrdina dojede za `LEAD_S`. */
  readonly lead: Spot;
  /**
   * Nejbližší viditelná hrozba (pronásledovatel, nepřítel; na výšku i nepřítel průběhu), nebo `null`.
   * `scale` = kolikrát ji zvětšila čitelnost (`foeScale`); záběr na výšku rámuje tělo, jak je nakreslené.
   */
  readonly threat: { readonly at: Spot; readonly size: Size; readonly scale?: number } | null;
  /** Kolikrát čitelnost zvětšila hrdinu (`legibleScale`); jen pro rámování celým tělem na výšku. */
  readonly heroScale?: number;
  readonly tan: number;
  readonly aspect: number;
  readonly tilt: Tilt;
}

const heroReach = (view: ArenaView, from: Spot): number =>
  reachOf(view.hero.x - from.x, view.heroSize.h / 2, view.hero.z - from.z, Math.max(view.heroSize.w, view.heroSize.d) / 2, view.tan, view.aspect, HERO_EDGE, view.tilt);

/** Na šířku se hrozba rámuje středem (P56B T9). */
const centreReach = (view: ArenaView, from: Spot): number => {
  const threat = view.threat!;
  return reachOf(threat.at.x - from.x, threat.size.h / 2, threat.at.z - from.z, 0, view.tan, view.aspect, THREAT_EDGE, view.tilt);
};

/** Horní okraj (NDC) pro celé tělo na výšku: pod pruhem HUD (10 % výšky, bezpečná zóna `e2e/p58a-framing`). */
const TALL_TOP = 0.8;

/** Nejmenší vzdálenost kamery, aby všechny rohy kvádru (zvětšeného `scale`, stojí na zemi) ležely v obraze na výšku. */
function boxReach(view: ArenaView, from: Spot, at: Spot, size: Size, scale: number): number {
  const w = (size.w * scale) / 2;
  const d = (size.d * scale) / 2;
  const { tan, aspect, tilt } = view;
  let reach = -Infinity;
  for (const x of [at.x - from.x - w, at.x - from.x + w]) {
    for (const y of [0, size.h * scale]) {
      for (const z of [at.z - from.z - d, at.z - from.z + d]) {
        const along = z * tilt.cos - y * tilt.sin;
        const up = y * tilt.cos + z * tilt.sin;
        reach = Math.max(reach, Math.max(Math.abs(x) / (THREAT_EDGE * tan * aspect), up >= 0 ? up / (TALL_TOP * tan) : -up / (THREAT_EDGE * tan)) - along);
      }
    }
  }
  return reach;
}

/**
 * Na výšku celým tělem (P62 T5-R1): hrdina i hrozba všemi rohy kvádru, jak je kreslí čitelnost, pod pruhem HUD.
 * Středem byl duch útěku za zády hrdiny useknutý spodní hranou v 60–96 % snímků; hrdina rámovaný středem by se
 * s hrozbou dole vytlačil hlavou pod HUD.
 */
const bodyReach = (view: ArenaView, from: Spot): number => {
  const threat = view.threat!;
  return Math.max(boxReach(view, from, view.hero, view.heroSize, view.heroScale ?? 1), boxReach(view, from, threat.at, threat.size, threat.scale ?? 1));
};

/** Kroky hledání bodu pohledu mezi hrdinou a hrozbou na výšku (`tallAim`). */
const AIM_STEPS = 10;

/**
 * Bod pohledu na výšku: místo na úsečce předstih → hrozba, odkud se hrdina i celé tělo hrozby vejdou s kamerou
 * nejblíž. Půl cesty nestačí: hrozba u kamery (útěk, duch za zády) je na snímku větší a níž, než je hrdina výš.
 */
function tallAim(view: ArenaView): { readonly aim: Spot; readonly need: number } {
  const threat = view.threat!;
  let best = { aim: view.lead, need: Infinity };
  for (let step = 0; step <= AIM_STEPS; step += 1) {
    const t = step / AIM_STEPS;
    const aim = { x: view.lead.x + (threat.at.x - view.lead.x) * t, z: view.lead.z + (threat.at.z - view.lead.z) * t };
    const need = bodyReach(view, aim);
    if (need < best.need) best = { aim, need };
  }
  return best;
}

/** Strop vzdálenosti: hrdina drží `heroShare` výšky obrazu. */
function capOf(view: ArenaView, framing: ArenaFraming): number {
  const { heroSize: hero, tilt } = view;
  return (hero.h * tilt.cos + Math.max(hero.w, hero.d) * tilt.sin) / (2 * view.tan * (view.aspect < 1 ? framing.heroShareTall : framing.heroShare));
}

/** Kam smí kamera s taženou hrozbou: strop krát `stretch`. */
const limitOf = (view: ArenaView, framing: ArenaFraming): number => capOf(view, framing) * (view.aspect < 1 ? framing.stretchTall : framing.stretch);

/** Jak hrozba táhne záběr: celým tělem (jen na výšku), středem, nebo vůbec. */
export type Framed = 'body' | 'centre' | false;

/**
 * Kam kamera míří: předstih hrdiny, a když je hrozba blíž než `THREAT_M` a vejde se s hrdinou
 * pod strop krát `stretch`, půl cesty k ní. `framed` = jak hrozba táhne záběr.
 * Na výšku (P62 T5-R1) napřed celé tělo z bodu `tallAim` a bez `THREAT_M`, rozhoduje jen strop: úzký obraz sahá do
 * hloubky dál než do stran a přepadník sběru, který čeká v rohu arény 15–37 m od hrdiny, byl v obraze v 1–4 z 30
 * snímků. Celé tělo, které se nevejde, rámuje středem jako na šířku – stráž úkolu 8 m do strany by jinak z obrazu
 * zmizela úplně.
 */
export function arenaGoal(view: ArenaView, framing: ArenaFraming): { readonly goal: Spot; readonly framed: Framed } {
  const threat = view.threat;
  if (threat === null) return { goal: view.lead, framed: false };
  const limit = limitOf(view, framing);
  if (view.aspect < 1) {
    const { aim, need } = tallAim(view);
    if (need <= limit) return { goal: aim, framed: 'body' };
  }
  if (Math.hypot(threat.at.x - view.hero.x, threat.at.z - view.hero.z) >= THREAT_M) return { goal: view.lead, framed: false };
  const mid = { x: (view.lead.x + threat.at.x) / 2, z: (view.lead.z + threat.at.z) / 2 };
  return Math.max(heroReach(view, mid), centreReach(view, mid)) <= limit ? { goal: mid, framed: 'centre' } : { goal: view.lead, framed: false };
}

const corner = new Vector3();
const meshBox = new Box3();

/**
 * Kvádr viditelných sítí těla ve světě – tytéž sítě jako sonda `__playFrame` (bez obrysu). Kvádr kreslení krát
 * `legible` model podcení: hrdina úkolu na iPhonu s měřítkem 1 přečníval o 0,1 NDC. Riggovaná síť klidovou geometrií,
 * ne pózou kostí (`posedBox` sondy stojí na telefonu jednotky ms za snímek): u hrdiny úkolu o ~0,05 NDC výš než póza,
 * hrdina tak stojí o kousek níž, nikdy pod lištou.
 */
export function shownBox(object: Object3D, out: Box3): Box3 {
  out.makeEmpty();
  object.updateWorldMatrix(true, true);
  object.traverseVisible((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true || isInk(mesh)) return;
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    out.union(meshBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld));
  });
  return out;
}

/**
 * Pro rohy kvádru (prostor kamery `view`, −z dopředu) nejvyšší a nejnižší `y + edge · tan · z`: o tolik metrů vyjet
 * kamerou po její ose nahoru, aby roh ležel na `edge` NDC. `null` = prázdný kvádr nebo roh za kamerou.
 */
function liftsOf(box: Box3, view: Matrix4, tan: number, edge: number): { readonly most: number; readonly least: number } | null {
  if (box.isEmpty()) return null;
  let most = -Infinity;
  let least = Infinity;
  for (let i = 0; i < 8; i += 1) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view);
    if (corner.z >= 0) return null;
    const lift = corner.y + edge * tan * corner.z;
    most = Math.max(most, lift);
    least = Math.min(least, lift);
  }
  return { most, least };
}

/**
 * Na výšku (P64): o kolik metrů vyjet kamerou po její ose nahoru (obraz jede dolů, vzdálenost ani hrdina se nemění),
 * aby celý kvádr hrdiny (`shownBox`) ležel pod horním pásem HUD `band.top` (NDC) – řešič záběru počítá s pevným
 * `TALL_TOP` 0,8 a lišta cíle končí níž (iPhone 15 v 0,70), hrozba u kamery pak temeno úkolu vytlačila pod ni. Tažená
 * hrozba (`threat`) se dostane pod pás jen tak daleko, dokud pata hrdiny zůstane nad dolním `band.bottom`. Nikdy
 * dolů: hrdina pod ovládáním palce je věc vzdálenosti, ne posunu.
 */
export function bandLift(hero: Box3, threat: Box3 | null, view: Matrix4, tan: number, band: { readonly top: number; readonly bottom: number }): number {
  const head = liftsOf(hero, view, tan, band.top);
  const feet = liftsOf(hero, view, tan, band.bottom);
  if (head === null || feet === null) return 0;
  const lift = Math.max(0, head.most);
  const far = threat === null ? null : liftsOf(threat, view, tan, band.top);
  return far === null ? lift : Math.max(lift, Math.min(far.most, feet.least));
}

/**
 * Jak daleko od bodu pohledu `aim` kamera stojí: aspoň `see` do strany, dál, dokud se hrdina
 * (a tažená hrozba) nevejdou, nejvýš po strop – s taženou hrozbou po strop krát `stretch`.
 */
export function arenaDistance(view: ArenaView, aim: Spot, framed: Framed, framing: ArenaFraming): number {
  const need = Math.max(heroReach(view, aim), framed === 'body' ? bodyReach(view, aim) : framed === 'centre' ? centreReach(view, aim) : 0);
  const least = Math.max(framing.nearest, (view.aspect < 1 ? framing.seeTall : framing.see) / (view.tan * Math.min(1, view.aspect)));
  const cap = capOf(view, framing);
  return framed !== false ? Math.min(limitOf(view, framing), Math.max(Math.min(cap, least), need)) : Math.min(cap, Math.max(least, need));
}
