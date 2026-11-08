/**
 * Orientační bod a rámující kusy sady (P54B T8) – čistá část `Landmark.tsx`.
 *
 * Orientační bod: jeden model z `look.landmark`, vybraný z vlastního streamu `pure-rand`
 * nasoleného semínkem hry. Stojí podle herní kamery žánru do středu záběru za hrou:
 * 25–60 m od kamery, měřítko 1,5–3×, mimo hrací plochu, celý dál od kamery než hrdina
 * a před koncem mlhy. Místo se hledá na mřížce (vzdálenost × posun do strany × měřítko):
 * nejvíc v záběru, nejblíž středu obrazu, co nejméně v mlze a vysoký asi třetinu obrazu.
 *
 * Rámující kusy: 1–2 rekvizity sady u levého a pravého kraje obrazu v popředí – blíž
 * kameře než hrdina, zčásti za krajem obrazu, mimo hrací plochu a mimo kruh hrdiny.
 *
 * Obdélník bodu ani kusu na obrazovce se nepotká s obdélníkem žádného hracího objemu
 * (P54B T15a): hrdina, postavy a předměty, které scéna označí, a pásy žánru (trubky
 * poletování, pruhy rytmu, koridor přistání). Kde se nic nevejde, bod se nepostaví.
 *
 * Jen vzhled: jádro o nich neví a z běhových streamů se neodebere ani jedna hodnota.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { type PerspectiveCamera, Vector3 } from 'three';

import { isSceneryModel, landmarks, type Look, modelHeight, type SceneryModel } from '@/play/arcade/look';

import type { Box } from './ground';

/** Pásmo vzdálenosti orientačního bodu od kamery (m, po zemi). */
export const LANDMARK_NEAR_M = 25;
export const LANDMARK_FAR_M = 60;
/** Měřítka orientačního bodu (násobek výšky kulisy v `SCENERY_MODELS`). */
const LANDMARK_SCALES = [1.5, 2, 2.5, 3] as const;
/** Měřítka rámujícího kusu. */
const FRAMING_SCALES = [0.8, 1, 1.25] as const;
/** Poloměr paty jako podíl výšky modelu: odhad, místo se hledá dřív, než se model načte. */
const FOOT = 0.35;
/** Odstup od hrací plochy (m). */
const AREA_GAP_M = 1;
/** Kruh hrdiny: tolik metrů od kraje jeho těla nic nestojí. */
const HERO_KEEP_M = 2;
/** Orientační bod vysoký asi takový podíl kratší strany obrazu: na výšku třetina výšky telefonu = dvě třetiny šířky a bod zabral popředí (T15a). */
const TARGET_TALL = 0.3;
/** Bod je „v záběru“, když je v obraze aspoň tolik z jeho kvádru (sonda `__playLandmark`, výběr kandidáta). */
export const IN_VIEW_SHARE = 0.5;
/**
 * Strmější kamera (° pod vodorovnou) orientační bod nedostane: svislice se v ní rozbíhají od středu a stojící
 * kámen leží – bludiště 63–70° („zbloudilý šedý sloup“ v soudu T15a) ano, souboj v aréně 60° (svatyně v záběru
 * 0,73, soud bez výtky) a aréna 40° ne. simplified: práh mezi dvěma pevnými kamerami, novou kameru 60–65° posoudit snímkem.
 */
const STEEPEST_DEG = 62;
/** Rezerva, se kterou výběr kandidáta bere bod jako v záběru. */
const IN_VIEW_MARGIN = 0.15;
/** Rámující kus jen z rekvizit do téhle výšky (m): v popředí by vyšší zakryl půl obrazu. */
const FRAMING_TALLEST_M = 3.5;
/** Kraj obrazu (NDC) a výšky, přes které paprsek hledá zem pod rámujícím kusem. */
const FRAMING_EDGES = [0.8, 0.9, 1, 1.1, 1.2] as const;
const FRAMING_ROWS = [-1.1, -0.9, -0.7, -0.5, -0.3, -0.1] as const;
/** Odstup obdélníku bodu a rámujícího kusu od obdélníku hracího objemu na obrazovce (NDC). */
const PLAY_PAD = 0.08;

/** Sůl semínka – stream orientačního bodu je jiný než každý stream jádra i výzdoby. */
const SALT = 0x1a4d3a7c;

/** Hrdina ve scéně: pata (m), poloměr těla a výška. */
export interface HeroBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly h: number;
}

/** Kus postavený do scény: pata (m), měřítko a natočení (rad, kolem svislé osy). */
export interface Placed {
  readonly id: SceneryModel;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly turn: number;
}

export interface PlaceInput {
  /** Herní kamera žánru (bez průletu, `restCamera`) s aktuálními maticemi. */
  readonly camera: PerspectiveCamera;
  readonly look: Look;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Hrací plocha (m ve scéně), nic na ní nestojí; pás trati má `z0`/`z1` nekonečné. */
  readonly area: readonly Box[];
  /** Hrdina; `null` = scéna ho (zatím) nemá. */
  readonly hero: HeroBox | null;
  /** Hrací objemy kromě hrdiny (postavy, předměty, pásy žánru): bod ani kus je na obrazovce nezakryje. */
  readonly play?: readonly Volume[];
  /** Výška terénu (m); bez ní rovina y = 0. */
  readonly ground?: (x: number, z: number) => number;
}

/** Kvádr ve scéně (m, min–max); nekonečná osa = pás bez konce (trať, koridor letu). */
export interface Volume {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
}

/** Obdélník v obraze (NDC). */
export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Obdélník kvádru v obraze (NDC) a hloubka jeho nejbližšího a nejvzdálenějšího rohu před kamerou (m). */
export interface ScreenRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly near: number;
  readonly far: number;
  /** Některý roh je za kamerou – promítnutí neplatí. */
  readonly behind: boolean;
}

const corner = new Vector3();

/** Kvádr (min, max ve scéně) promítnutý kamerou s aktuálními maticemi. */
export function screenRect(camera: PerspectiveCamera, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ScreenRect {
  let [minX, maxX, minY, maxY, near, far, behind] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity, false];
  for (let i = 0; i < 8; i += 1) {
    corner.set(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0).applyMatrix4(camera.matrixWorldInverse);
    const depth = -corner.z;
    if (depth <= camera.near) behind = true;
    near = Math.min(near, depth);
    far = Math.max(far, depth);
    corner.applyMatrix4(camera.projectionMatrix);
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  return { minX, maxX, minY, maxY, near, far, behind };
}

/** Podíl obdélníku uvnitř obrazu; za kamerou 0. */
export function frameShare(rect: ScreenRect): number {
  if (rect.behind) return 0;
  const w = Math.max(0, Math.min(rect.maxX, 1) - Math.max(rect.minX, -1));
  const h = Math.max(0, Math.min(rect.maxY, 1) - Math.max(rect.minY, -1));
  return (w * h) / Math.max(1e-9, (rect.maxX - rect.minX) * (rect.maxY - rect.minY));
}

/** Hrany kvádru jako dvojice rohů (bit 1 = x, 2 = y, 4 = z). */
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as const;
const corners = Array.from({ length: 8 }, () => new Vector3());
const onEdge = new Vector3();

/**
 * Obdélník části kvádru mezi blízkou rovinou kamery a hloubkou `far` (konec mlhy); `null` = celý mimo.
 * Vrcholy oříznutého kvádru leží na jeho hranách, takže stačí oříznout dvanáct hran a promítnout jejich konce:
 * pás trati, který začíná za kamerou, tak dostane obdélník viditelného kusu, ne nekonečno.
 */
export function volumeRect(camera: PerspectiveCamera, volume: Volume, far: number): Rect | null {
  // Nekonečnou osu stačí utnout kus za koncem mlhy: dál je všechno za `far`.
  const reach = 3 * far;
  const eye = camera.position;
  const lo = [Math.max(volume.x0, eye.x - reach), Math.max(volume.y0, eye.y - reach), Math.max(volume.z0, eye.z - reach)] as const;
  const hi = [Math.min(volume.x1, eye.x + reach), Math.min(volume.y1, eye.y + reach), Math.min(volume.z1, eye.z + reach)] as const;
  if (lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) return null;
  corners.forEach((point, i) => point.set(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]).applyMatrix4(camera.matrixWorldInverse));
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [a, b] of EDGES) {
    const [p, q] = [corners[a]!, corners[b]!];
    // Hloubka podél hrany je lineární: úsek, kde leží mezi `near` a `far`.
    const [dp, dq] = [-p.z, -q.z];
    let [t0, t1] = [0, 1];
    if (dq === dp) {
      if (dp < camera.near || dp > far) continue;
    } else {
      const [tNear, tFar] = [(camera.near - dp) / (dq - dp), (far - dp) / (dq - dp)];
      [t0, t1] = [Math.max(0, Math.min(tNear, tFar)), Math.min(1, Math.max(tNear, tFar))];
      if (t0 > t1) continue;
    }
    for (const t of [t0, t1]) {
      onEdge.copy(p).lerp(q, t).applyMatrix4(camera.projectionMatrix);
      minX = Math.min(minX, onEdge.x);
      maxX = Math.max(maxX, onEdge.x);
      minY = Math.min(minY, onEdge.y);
      maxY = Math.max(maxY, onEdge.y);
    }
  }
  return minX > maxX ? null : { minX, maxX, minY, maxY };
}

/** Obdélníky se potkají, i s odstupem `PLAY_PAD`. */
const meets = (a: Rect, b: Rect): boolean => a.minX < b.maxX + PLAY_PAD && b.minX - PLAY_PAD < a.maxX && a.minY < b.maxY + PLAY_PAD && b.minY - PLAY_PAD < a.maxY;

/** Obdélníky hracích objemů a hrdiny v obraze kamery. */
function playRects(camera: PerspectiveCamera, look: Look, hero: HeroBox | null, play: readonly Volume[]): Rect[] {
  const volumes = hero === null ? play : [...play, { x0: hero.x - hero.r, y0: hero.y, z0: hero.z - hero.r, x1: hero.x + hero.r, y1: hero.y + hero.h, z1: hero.z + hero.r }];
  return volumes.map((volume) => volumeRect(camera, volume, look.fog[1])).filter((rect): rect is Rect => rect !== null);
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const flat = (): number => 0;
const onArea = (area: readonly Box[], x: number, z: number, r: number): boolean => area.some((box) => x + r > box.x0 && x - r < box.x1 && z + r > box.z0 && z - r < box.z1);
/** Pata stojí na nejnižším bodě pod sebou, ať na svahu nevisí. */
const footY = (ground: (x: number, z: number) => number, x: number, z: number, r: number): number => Math.min(ground(x, z), ground(x - r, z), ground(x + r, z), ground(x, z - r), ground(x, z + r));
const rectOf = (camera: PerspectiveCamera, x: number, y: number, z: number, r: number, h: number): ScreenRect => screenRect(camera, x - r, y, z - r, x + r, y + h, z + r);
const heroRect = (camera: PerspectiveCamera, hero: HeroBox): ScreenRect => rectOf(camera, hero.x, hero.y, hero.z, hero.r, hero.h);

/** Rekvizity sady, které smí rámovat: modely gen3d (jedno volání) do `FRAMING_TALLEST_M`, kromě orientačního bodu. */
function framingPool(look: Look, landmark: SceneryModel | null): SceneryModel[] {
  const models = [...new Set(landmarks(look))].filter((kind): kind is SceneryModel => isSceneryModel(kind) && kind !== landmark && modelHeight(kind) <= FRAMING_TALLEST_M);
  const single = models.filter((id) => id.startsWith('gen3d-'));
  return single.length > 0 ? single : models;
}

/**
 * Orientační bod a dva rámující kusy (levý, pravý) ze semínka hry. `landmark` je kandidát, kterého
 * semínko vybralo; `order` jsou kandidáti sady od něj dál – když se vybraný do záběru kamery žánru
 * nevejde (strmá kamera nad velkou arénou vidí za její hranou jen proužek), zkusí se další v tomhle
 * pořadí. Odebere se vždy stejný počet hodnot, takže sada bez kusů nezmění výběr orientačního bodu.
 */
export function landmarkPicks(look: Look, seed: number): { readonly landmark: SceneryModel | null; readonly order: readonly SceneryModel[]; readonly framing: readonly SceneryModel[] } {
  const rng = xoroshiro128plus((seed ^ SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  // První výstup xoroshiro nasoleného blízkými semínky je skoro stejný: dva se zahodí.
  next();
  next();
  const [a, b, c] = [next(), next(), next()];
  const count = look.landmark.length;
  const first = Math.floor(a * count);
  const order = look.landmark.map((_, index) => look.landmark[(first + index) % count]!);
  const landmark = order[0] ?? null;
  const pool = framingPool(look, landmark);
  return { landmark, order, framing: pool.length === 0 ? [] : [pool[Math.floor(b * pool.length)]!, pool[Math.floor(c * pool.length)]!] };
}

/** Poloměr paty kusu (m), se kterým hledání hlídá hrací plochu. */
export const footOf = (placed: Pick<Placed, 'id' | 'scale'>): number => FOOT * modelHeight(placed.id) * placed.scale;

/**
 * Bod, který jede s kamerou nad arénou nebo bludištěm, se z hrací plochy vysune k nejbližšímu
 * kraji (s odstupem `AREA_GAP_M`): nikdy nestojí tam, kde se hraje.
 */
export function keepOff(area: readonly Box[], x: number, z: number, r: number): { readonly x: number; readonly z: number } {
  let at = { x, z };
  for (const box of area) {
    const pad = r + AREA_GAP_M;
    if (!(at.x + pad > box.x0 && at.x - pad < box.x1 && at.z + pad > box.z0 && at.z - pad < box.z1)) continue;
    const exits = [
      { x: box.x0 - pad, z: at.z },
      { x: box.x1 + pad, z: at.z },
      { x: at.x, z: box.z0 - pad },
      { x: at.x, z: box.z1 + pad },
    ].filter((exit) => Number.isFinite(exit.x) && Number.isFinite(exit.z));
    at = exits.reduce((best, exit) => (Math.hypot(exit.x - x, exit.z - z) < Math.hypot(best.x - x, best.z - z) ? exit : best), exits[0] ?? at);
  }
  return at;
}

/** Natočení modelu (+z) ke kameře. */
const toward = (camera: PerspectiveCamera, x: number, z: number): number => Math.atan2(camera.position.x - x, camera.position.z - z);

const forward = new Vector3();

/**
 * Orientační bod podle herní kamery; `null` = sada žádný nemá, nebo se do záběru nevejde. Kandidáti
 * jdou v pořadí ze semínka (`landmarkPicks`): první, jehož nejlepší místo je v záběru i s rezervou,
 * vyhrává; jinak ten, kterého je v záběru nejvíc – ale aspoň `IN_VIEW_SHARE`. Bod z obrazu většinou
 * venku (bludiště shora, souboj, kluzák na výšku) byl jen „zbloudilý sloup“ u kraje (T15a).
 */
export function placeLandmark(input: PlaceInput): Placed | null {
  // Kamera, která kouká strmě dolů (bludiště), vidí bod jen shora – bez obrysu proti nebi je to šedý sloup na zemi.
  if (input.camera.getWorldDirection(forward).y < -Math.sin(STEEPEST_DEG * (Math.PI / 180))) return null;
  let best: { readonly placed: Placed; readonly share: number } | null = null;
  for (const id of landmarkPicks(input.look, input.seed).order) {
    const found = bestSpot(input, id);
    // S rezervou: pata se tu odhaduje (`FOOT`), sonda měří kvádr načteného modelu.
    if (found !== null && found.share >= IN_VIEW_SHARE + IN_VIEW_MARGIN) return found.placed;
    if (found !== null && (best === null || found.share > best.share)) best = found;
  }
  return best !== null && best.share >= IN_VIEW_SHARE ? best.placed : null;
}

/** Nejlepší místo jednoho kandidáta a kolik ho je v záběru. */
function bestSpot({ camera, look, area, hero, play = [], ground = flat }: PlaceInput, id: SceneryModel): { readonly placed: Placed; readonly share: number } | null {
  const height = modelHeight(id);
  const eye = camera.position;
  camera.getWorldDirection(forward).setY(0);
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
  forward.normalize();
  const [fogNear, fogFar] = look.fog;
  const heroFar = hero === null ? 0 : heroRect(camera, hero).far;
  const blocks = playRects(camera, look, hero, play);
  const target = TARGET_TALL * Math.min(1, camera.aspect);
  let best: { placed: Placed; share: number } | null = null;
  let bestScore = -Infinity;
  // simplified: mřížka 31 × 37 × 4 míst na kandidáta se projde jednou při stavbě scény (nejvýš ~14 tisíc promítnutí); hustší by nic nezměnila.
  // Vpřed od 0 m: strmá kamera (souboj, bludiště) vidí zem jen kousek před sebou, 25 m od ní je bod šikmo do strany.
  for (let along = 0; along <= LANDMARK_FAR_M; along += 2) {
    for (let aside = -36; aside <= 36; aside += 2) {
      const distance = Math.hypot(along, aside);
      if (distance < LANDMARK_NEAR_M || distance > LANDMARK_FAR_M) continue;
      const x = eye.x + forward.x * along - forward.z * aside;
      const z = eye.z + forward.z * along + forward.x * aside;
      for (const scale of LANDMARK_SCALES) {
        const h = height * scale;
        const r = FOOT * h;
        if (onArea(area, x, z, r + AREA_GAP_M)) continue;
        if (hero !== null && Math.hypot(x - hero.x, z - hero.z) < hero.r + HERO_KEEP_M + r) continue;
        const y = footY(ground, x, z, r);
        const rect = rectOf(camera, x, y, z, r, h);
        // Celý před koncem mlhy (tam končí i kamera, `FarAtFog`) a celý za hrou.
        if (rect.behind || rect.far >= fogFar || rect.near <= heroFar) continue;
        // Za hrou, ale ne za ní v obraze: hrdina, soupeř, trubky ani pruhy se bodem nepřekryjí.
        if (blocks.some((block) => meets(rect, block))) continue;
        const share = frameShare(rect);
        const centre = Math.abs(clamp((rect.minX + rect.maxX) / 2, -1, 1));
        const tall = Math.max(0, Math.min(rect.maxY, 1) - Math.max(rect.minY, -1)) / 2;
        const fog = clamp((distance - fogNear) / (fogFar - fogNear), 0, 1);
        // Záběr rozhoduje nejvíc: o desetinu víc v obraze váží víc než posun o pětinu obrazu ke středu.
        const score = 6 * share - 1.5 * centre - 1.5 * fog - 3 * Math.abs(tall - target);
        if (score > bestScore) {
          bestScore = score;
          best = { placed: { id, x, y, z, scale, turn: toward(camera, x, z) }, share };
        }
      }
    }
  }
  return best;
}

const ray = new Vector3();

/** Kde paprsek kamery bodem obrazu (NDC) protne zem; `null` = míří nad obzor. */
function groundHit(camera: PerspectiveCamera, ndcX: number, ndcY: number, ground: (x: number, z: number) => number): { x: number; z: number } | null {
  ray.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  if (ray.y >= -1e-3) return null;
  let level = ground(camera.position.x, camera.position.z);
  let hit = { x: camera.position.x, z: camera.position.z };
  // Dvakrát dopřesnit výšku terénu v místě dopadu – stačí na svahy údolí.
  for (let pass = 0; pass < 3; pass += 1) {
    const t = (level - camera.position.y) / ray.y;
    if (t <= 0) return null;
    hit = { x: camera.position.x + ray.x * t, z: camera.position.z + ray.z * t };
    level = ground(hit.x, hit.z);
  }
  return hit;
}

/**
 * 1–2 rámující kusy u kraje obrazu v popředí. Scéna, kde u kraje obrazu blíž než hrdina
 * žádná zem mimo hrací plochu není (aréna shora, střelnice s mýtinou), nedostane žádný.
 */
export function placeFraming({ camera, look, seed, area, hero, play = [], ground = flat }: PlaceInput): Placed[] {
  const { framing } = landmarkPicks(look, seed);
  if (framing.length === 0) return [];
  const heroBox = hero === null ? null : heroRect(camera, hero);
  const blocks = playRects(camera, look, hero, play);
  const placed: Placed[] = [];
  for (const [index, side] of [[0, -1], [1, 1]] as const) {
    const id = framing[index]!;
    const height = modelHeight(id);
    let best: Placed | null = null;
    let bestScore = -Infinity;
    for (const edge of FRAMING_EDGES) {
      for (const row of FRAMING_ROWS) {
        const hit = groundHit(camera, edge * side, row, ground);
        if (hit === null || Math.hypot(hit.x - camera.position.x, hit.z - camera.position.z) < 2.5) continue;
        for (const scale of FRAMING_SCALES) {
          const h = height * scale;
          const r = FOOT * h;
          if (onArea(area, hit.x, hit.z, r + AREA_GAP_M)) continue;
          if (hero !== null && Math.hypot(hit.x - hero.x, hit.z - hero.z) < hero.r + HERO_KEEP_M + r) continue;
          const y = footY(ground, hit.x, hit.z, r);
          const rect = rectOf(camera, hit.x, y, hit.z, r, h);
          if (rect.behind) continue;
          // Popředí: blíž kameře než hrdina; na obrazovce se nepotká s ním ani s jiným hracím objemem.
          if ((heroBox !== null && (rect.near + rect.far) / 2 >= heroBox.near) || blocks.some((block) => meets(rect, block))) continue;
          const share = frameShare(rect);
          const tall = Math.max(0, Math.min(rect.maxY, 1) - Math.max(rect.minY, -1)) / 2;
          // Zčásti za krajem obrazu a nejvýš tři čtvrtiny výšky obrazu – rám, ne zeď.
          if (share < 0.2 || share > 0.9 || tall > 0.75) continue;
          const score = Math.min(tall, 0.45) - Math.abs(share - 0.6);
          if (score > bestScore) {
            bestScore = score;
            best = { id, x: hit.x, y, z: hit.z, scale, turn: toward(camera, hit.x, hit.z) + side * 0.6 };
          }
        }
      }
    }
    if (best !== null) placed.push(best);
  }
  return placed;
}

/**
 * Rámující kusy u kamery po trati (P77 T4): hledání pevné kamery (`placeFraming`) chce kus blíž kameře než hrdina,
 * a tam běžci trať zabere skoro celou šířku obrazu – vešel se jen malý model (5 z 18 míst). Kopie řady (`framingRow`)
 * rohem obrazu projedou samy, takže stačí stát těsně vedle hrací plochy: vlevo vedle hrdiny, vpravo o půl rozteče
 * dál (řada nepůsobí jako brána). Plocha (`area`) jsou pásy trati s nekonečným z; hrdina stojí uvnitř.
 * Kusy jsou dva nejvyšší modely z řad kulis místa (`look.props` – stromy, skály), zvětšené k `FRAMING_TREE_M`:
 * nízký kus (lavička z `framingPool`) by u kraje obrazu stál jako další kulisa, ne jako rám (první pokus T4).
 */
export function placeTrackFraming({ camera, look, area, hero, ground = flat }: PlaceInput): Placed[] {
  const tall = [...new Set(look.props)].filter((kind): kind is SceneryModel => isSceneryModel(kind)).sort((a, b) => modelHeight(b) - modelHeight(a));
  if (tall.length === 0) return [];
  // Druhý kus jiný, jen když není o víc než čtvrtinu nižší – jinak by vpravo rámoval keřík.
  const framing = [tall[0]!, tall.find((id, i) => i > 0 && modelHeight(id) >= 0.75 * modelHeight(tall[0]!)) ?? tall[0]!];
  const dir = camera.getWorldDirection(new Vector3()).z < 0 ? -1 : 1;
  const z0 = hero?.z ?? camera.position.z + dir * 6;
  const lanes = area.filter((box) => box.z0 <= z0 && z0 <= box.z1);
  const left = Math.min(...lanes.map((box) => box.x0));
  const right = Math.max(...lanes.map((box) => box.x1));
  return ([[0, -1], [1, 1]] as const).map(([index, side]) => {
    const id = framing[index]!;
    const scale = Math.min(FRAMING_GROW_MAX, Math.max(1, FRAMING_TREE_M / modelHeight(id)));
    const r = FOOT * modelHeight(id) * scale;
    const x = side < 0 ? left - AREA_GAP_M - r : right + AREA_GAP_M + r;
    const z = z0 + (side > 0 ? dir * FRAMING_PERIOD_M / 2 : 0);
    return { id, x, y: footY(ground, x, z, r), z, scale, turn: toward(camera, x, z) + side * 0.6 };
  });
}

/** Cílová výška rámujícího kusu u trati (m) a nejvyšší zvětšení modelu, ať strom nepřeroste v obra. */
const FRAMING_TREE_M = 4;
const FRAMING_GROW_MAX = 1.6;

/** Rozteč kopií rámujícího kusu po trati (m): kopie zmizí za kamerou dřív, než další dojede do rohu obrazu. */
export const FRAMING_PERIOD_M = 14;
/** Kopií jednoho rámujícího kusu najednou: počítač, telefon (P77 T4 – na telefonu méně kusů). */
export const FRAMING_COPIES = { desktop: 4, phone: 2 } as const;

/**
 * Rámující kus u kamery, která jede po trati (P77 T4, koncept: velké stromy v rozích popředí ubíhají s tratí).
 * Jeden kus by s kamerou buď ujel z obrazu, nebo klouzal po zemi; proto řada kopií s roztečí `FRAMING_PERIOD_M`
 * ve stejném odstupu od středu trati jako nalezené místo (`placeFraming` u kamery v klidu; `ground` tatáž jako tam). Každá kopie stojí
 * na zemi, dokud ji kamera nemine; nová přibude `count` roztečí vpředu – daleko a malá. `advance` = kolik metrů
 * kamera ujela ve směru `dir` (±z) od místa, kde se kus hledal. Odstup od trati drží i v zatáčce (`bend`).
 */
export function framingRow(placed: Placed, advance: number, dir: 1 | -1, count: number, bend?: (z: number) => { readonly x: number }, ground?: (x: number, z: number) => number): Placed[] {
  const first = Math.floor(advance / FRAMING_PERIOD_M);
  const row: Placed[] = [];
  for (let m = first; m < first + count; m++) {
    const z = placed.z + dir * FRAMING_PERIOD_M * m;
    const x = bend === undefined ? placed.x : placed.x + bend(z).x - bend(placed.z).x;
    // Pata jako u nalezeného místa (`placeFraming`): nejnižší bod pod kusem.
    row.push({ ...placed, x, y: ground === undefined ? placed.y : footY(ground, x, z, footOf(placed)), z });
  }
  return row;
}
