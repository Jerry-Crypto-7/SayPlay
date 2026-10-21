/**
 * Záběr kamery arény (P56B T9): kam kamera míří a jak daleko stojí. Vytaženo
 * z `ArenaScene.tsx` (vzor `track-camera.ts`), ať jde záběr spočítat v testu
 * bez plátna. Jen kresba: stav, hash ani robot se nemění.
 */

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
/** Hrozba blíž než tolik metrů táhne záběr k sobě, ať je vidět hráč i ona. */
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
 * Hrdina větší (strop 0,1 → 0,14, na výšku 0,11 → 0,16: kamera o ~30 % blíž) a blízká hrozba
 * v záběru i nad strop, nejvýš 2,5× – hrdina pak pořád ≥ 5,6 % výšky obrazu (P35 T2 měl 4,7 %).
 * `nearest` se neměnil: s hrdinou do 1,3 m vždy rozhoduje strop pod ním (`arena-camera.test.ts`).
 */
export const ARENA_FRAMING: ArenaFraming = { nearest: 16, see: 9, seeTall: 5, heroShare: 0.14, heroShareTall: 0.16, stretch: 2.5, stretchTall: 2.5 };

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
  /** Nejbližší viditelná hrozba (pronásledovatel, nepřítel), nebo `null`. */
  readonly threat: { readonly at: Spot; readonly size: Size } | null;
  readonly tan: number;
  readonly aspect: number;
  readonly tilt: Tilt;
}

const heroReach = (view: ArenaView, from: Spot): number =>
  reachOf(view.hero.x - from.x, view.heroSize.h / 2, view.hero.z - from.z, Math.max(view.heroSize.w, view.heroSize.d) / 2, view.tan, view.aspect, HERO_EDGE, view.tilt);

const threatReach = (view: ArenaView, from: Spot): number => {
  const threat = view.threat!;
  return reachOf(threat.at.x - from.x, threat.size.h / 2, threat.at.z - from.z, Math.max(threat.size.w, threat.size.d) / 2, view.tan, view.aspect, THREAT_EDGE, view.tilt);
};

/** Strop vzdálenosti: hrdina drží `heroShare` výšky obrazu. */
function capOf(view: ArenaView, framing: ArenaFraming): number {
  const { heroSize: hero, tilt } = view;
  return (hero.h * tilt.cos + Math.max(hero.w, hero.d) * tilt.sin) / (2 * view.tan * (view.aspect < 1 ? framing.heroShareTall : framing.heroShare));
}

/** Kam smí kamera s taženou hrozbou: strop krát `stretch`. */
const limitOf = (view: ArenaView, framing: ArenaFraming): number => capOf(view, framing) * (view.aspect < 1 ? framing.stretchTall : framing.stretch);

/**
 * Kam kamera míří: předstih hrdiny, a když je hrozba blíž než `THREAT_M` a vejde se s hrdinou
 * pod strop krát `stretch`, půl cesty k ní. `framed` = hrozba táhne záběr.
 */
export function arenaGoal(view: ArenaView, framing: ArenaFraming): { readonly goal: Spot; readonly framed: boolean } {
  const threat = view.threat;
  if (threat === null || Math.hypot(threat.at.x - view.hero.x, threat.at.z - view.hero.z) >= THREAT_M) return { goal: view.lead, framed: false };
  const mid = { x: (view.lead.x + threat.at.x) / 2, z: (view.lead.z + threat.at.z) / 2 };
  const framed = Math.max(heroReach(view, mid), threatReach(view, mid)) <= limitOf(view, framing);
  return framed ? { goal: mid, framed } : { goal: view.lead, framed };
}

/**
 * Jak daleko od bodu pohledu `aim` kamera stojí: aspoň `see` do strany, dál, dokud se hrdina
 * (a tažená hrozba) nevejdou, nejvýš po strop – s taženou hrozbou po strop krát `stretch`.
 */
export function arenaDistance(view: ArenaView, aim: Spot, framed: boolean, framing: ArenaFraming): number {
  const need = Math.max(heroReach(view, aim), framed ? threatReach(view, aim) : 0);
  const least = Math.max(framing.nearest, (view.aspect < 1 ? framing.seeTall : framing.see) / (view.tan * Math.min(1, view.aspect)));
  const cap = capOf(view, framing);
  return framed ? Math.min(limitOf(view, framing), Math.max(Math.min(cap, least), need)) : Math.min(cap, Math.max(least, need));
}
