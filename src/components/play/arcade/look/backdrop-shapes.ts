/**
 * Kulisa za mlhou (P46G T6). Cesta dřív mizela do prázdné mlhy. Teď za scénou
 * stojí 2–3 prstence siluet kolem kamery podle sady (`Look.skyline`): hory se
 * špičkami, oblé kopce, duny, linie jehličnanů nebo korun, stolové hory,
 * panorama domů, pobřeží s mysy.
 *
 * Barvy jsou z mlhy: barva mlhy (`horizon`, i po náladě a v noci) vynásobená
 * odstínem sady, takže silueta je vždy tmavší než mlha a „temný les“ má temnou
 * kulisu. Pata je světlejší (opar u země). Prstence stojí uvnitř mlhy
 * (`FAR`/`NEAR` na stupnici začátek–konec mlhy): vzdálená vrstva v ní mizí víc
 * než bližší. Nejbližší vrstva má nad cestou (+z) průsek, ať cesta nevede do zdi.
 *
 * Obrys je jedna výšková křivka kolem dokola (úhel od +z k +x, výška v m) a
 * vrstva jedna síť: kulisa přidá nejvýš tři volání kreslení. Paralaxa
 * (`layerAt`): vrstva jde s kamerou do strany jen z části (`follow`, bližší
 * míň) a za celou trať se přiblíží o `approach` metrů.
 *
 * Tvar je čistá funkce sady a semínka hry z vlastního streamu `pure-rand`
 * (jako vegetace): tatáž hra má tytéž hory a z běhových streamů jádra se nic
 * neodebere – hash se nehne. Kreslí `Backdrop.tsx`.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

import type { Look, Silhouette } from '@/play/arcade/look';

/** Sůl semínka – stream kulisy je jiný než stream jádra, výzdoby arény i vegetace. */
const SALT = 0x2b1d6e5f;
const TAU = 2 * Math.PI;

/**
 * Nejvzdálenější a nejbližší vrstva, mezi nimi se prokládá: kde v mlze stojí
 * (0 = začátek mlhy, 1 = konec), jakou část pohybu kamery do strany udělá s ní
 * a jak daleko je její barva od mlhy k barvě siluety.
 */
const FAR = { fog: 0.8, follow: 0.9, strength: 0.5 } as const;
const NEAR = { fog: 0.52, follow: 0.6, strength: 0.9 } as const;
/** Přiblížení za celou trať: podíl mezery mezi vrstvou a začátkem mlhy krát podíl, o který vrstva nejde s kamerou. */
const APPROACH = 0.6;
/** Pata: podíl cesty od barvy mlhy k barvě obrysu. */
const FOOT = 0.45;
/** Průsek nad cestou v nejbližší vrstvě: o kolik výšky ubere a do kolikanásobku `clear` náběh trvá. */
const NOTCH = { depth: 0.9, ramp: 1.8 } as const;
/** Body hladkých obrysů (kopce, hory, duny) na obvod: krok 1,5°. */
const SAMPLES = 240;

/** Bod obrysu: úhel od +z k +x (rad, 0–2π) a výška nad patou (m). */
export type ProfilePoint = readonly [angle: number, height: number];

export interface BackdropLayer {
  readonly kind: Silhouette;
  /** Poloměr prstence kolem kamery (m). */
  readonly radius: number;
  /** Jakou část pohybu kamery do strany vrstva udělá s ní (1 = stojí vůči kameře jako obloha). */
  readonly follow: number;
  /** O kolik metrů se vrstva za celou trať přiblíží. */
  readonly approach: number;
  /** Barva obrysu a paty (`#rrggbb`), před mlhou. */
  readonly top: string;
  readonly foot: string;
  /** Úhel roste od 0 do 2π; první a poslední bod mají tutéž výšku, prstenec je zavřený. */
  readonly profile: readonly ProfilePoint[];
}

/** Vrstva a její síť: komponenta z každé dělá právě jednu síť – jedno volání kreslení. */
export interface BackdropPart {
  readonly layer: BackdropLayer;
  readonly geometry: BufferGeometry;
}

export interface BackdropOptions {
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Půl šířky průseku nad cestou (m): půl cesty a kus okraje. */
  readonly clear: number;
  /** O kolik metrů pata sahá pod zem: v údolí běžce kryje kopce trati, na rovině závodu jen spáru. */
  readonly skirt: number;
  /** Nejmenší poloměr nejbližší vrstvy (m, `backdropLayers`); bez něj jen podle mlhy. */
  readonly beyond?: number;
}

type Next = () => number;

const between = (next: Next, lo: number, hi: number): number => lo + (hi - lo) * next();

/** Vlna kolem dokola s celým počtem period na obvod, ať se prstenec zavře. */
interface Wave {
  readonly k: number;
  readonly phase: number;
}
const waveOf = (next: Next, lo: number, hi: number): Wave => ({ k: lo + Math.floor(next() * (hi - lo + 1)), phase: TAU * next() });
/** 0–1, oblá. */
const sine = ({ k, phase }: Wave, angle: number): number => 0.5 + 0.5 * Math.sin(k * angle + phase);
/** 0–1, hřbet: 1 − |sin| má ostré vrcholy. */
const ridge = ({ k, phase }: Wave, angle: number): number => 1 - Math.abs(Math.sin((k * angle) / 2 + phase));
/** 0–1, duna: zešikmená vlna, dlouhá návětrná strana a prudký sesuv. */
const dune = ({ k, phase }: Wave, angle: number): number => {
  const x = k * angle + phase;
  return 0.5 + 0.5 * Math.sin(x + 0.7 * Math.sin(x));
};

const sampled = (height: (angle: number) => number): ProfilePoint[] =>
  Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const angle = (TAU * i) / SAMPLES;
    return [angle, height(angle)];
  });

/** Kusy obrysu za sebou kolem dokola: šířky (rad) se natáhnou, ať poslední končí přesně v 2π. */
function around<T extends { readonly width: number }>(make: () => T): { readonly item: T; readonly start: number; readonly width: number }[] {
  const items: T[] = [];
  let sum = 0;
  while (sum < TAU) {
    const item = make();
    items.push(item);
    sum += item.width;
  }
  let start = 0;
  return items.map((item) => {
    const width = (item.width * TAU) / sum;
    const placed = { item, start, width };
    start += width;
    return placed;
  });
}

/** Tvar `[podíl šířky, podíl výšky]` položený na kus obrysu. */
const shaped = (shape: readonly (readonly [number, number])[], start: number, width: number, height: (at: number, share: number) => number): ProfilePoint[] =>
  shape.map(([along, share]) => [start + along * width, height(start + along * width, share)]);

const CROWN = [[0, 0.35], [0.1, 0.65], [0.25, 0.88], [0.5, 1], [0.75, 0.88], [0.9, 0.65]] as const;
const MESA = [[0, 0], [0.06, 0.45], [0.14, 1], [0.86, 1], [0.94, 0.45]] as const;
const HEADLAND = [[0, 0], [0.05, 0.8], [0.2, 1], [0.45, 0.85], [0.7, 0.6], [0.88, 0.25]] as const;

/** Obrys druhu kolem dokola ve výškách na metr poloměru. Úhly i výšky nezávisí na poloměru – vrstva má v každé mlze tutéž velikost v obraze. */
function shapeOf(kind: Silhouette, next: Next): ProfilePoint[] {
  switch (kind) {
    case 'peaks': {
      const [big, mid, small, range] = [waveOf(next, 3, 5), waveOf(next, 7, 11), waveOf(next, 16, 24), waveOf(next, 1, 3)];
      return sampled((a) => 0.025 + (0.55 + 0.45 * sine(range, a)) * (0.2 * ridge(big, a) ** 1.5 + 0.08 * ridge(mid, a) + 0.03 * ridge(small, a)));
    }
    case 'hills': {
      const [big, mid, small] = [waveOf(next, 3, 6), waveOf(next, 8, 14), waveOf(next, 18, 30)];
      return sampled((a) => 0.025 + 0.08 * sine(big, a) ** 1.3 + 0.035 * sine(mid, a) + 0.012 * sine(small, a));
    }
    case 'dunes': {
      const [big, small] = [waveOf(next, 6, 10), waveOf(next, 13, 21)];
      return sampled((a) => 0.012 + 0.06 * dune(big, a) ** 1.4 + 0.025 * dune(small, a));
    }
    case 'pines': {
      const [slow, fast] = [waveOf(next, 2, 4), waveOf(next, 5, 9)];
      const band = (a: number) => 0.04 + 0.025 * sine(slow, a) + 0.01 * sine(fast, a);
      // Jehličnan: pata na pásu lesa, špička v půlce šířky, vysoký asi dvakrát víc než široký; občas mýtina.
      const trees = around(() => ({ width: between(next, 0.022, 0.045), tip: next() < 0.05 ? between(next, 0.004, 0.012) : between(next, 0.045, 0.1) }));
      return [...trees.flatMap(({ item, start, width }): ProfilePoint[] => [[start, band(start)], [start + width / 2, band(start + width / 2) + item.tip]]), [TAU, band(TAU)]];
    }
    case 'crowns': {
      const [slow, fast] = [waveOf(next, 2, 4), waveOf(next, 5, 9)];
      const band = (a: number) => 0.045 + 0.025 * sine(slow, a) + 0.01 * sine(fast, a);
      // Koruna je víc široká než vysoká a sousední se překrývají: les, ne řada sloupů.
      const crowns = around(() => ({ width: between(next, 0.07, 0.14), tip: between(next, 0.03, 0.065) }));
      return [...crowns.flatMap(({ item, start, width }) => shaped(CROWN, start, width, (at, share) => band(at) + share * item.tip)), [TAU, band(TAU) + CROWN[0][1] * crowns[0]!.item.tip]];
    }
    case 'mesas': {
      const [slow, fast] = [waveOf(next, 3, 6), waveOf(next, 9, 15)];
      const plain = (a: number) => 0.012 + 0.02 * sine(slow, a) + 0.01 * sine(fast, a);
      // Střídá se rovina a stolová hora s prudkými boky a sutí u paty.
      const items = around(() => (next() < 0.45 ? { width: between(next, 0.12, 0.35), top: between(next, 0.07, 0.17) } : { width: between(next, 0.1, 0.4), top: 0 }));
      const flat = (start: number, width: number): ProfilePoint[] => {
        const steps = Math.ceil(width / 0.05);
        return Array.from({ length: steps }, (_, j) => start + (j * width) / steps).map((at) => [at, plain(at)]);
      };
      return [...items.flatMap(({ item, start, width }) => (item.top === 0 ? flat(start, width) : shaped(MESA, start, width, (at, share) => plain(at) + share * (item.top - plain(at))))), [TAU, plain(TAU)]];
    }
    case 'blocks': {
      const [district, street] = [waveOf(next, 1, 3), waveOf(next, 3, 6)];
      // Centrum: vysoké domy se shlukují, na okraji nízká zástavba.
      const town = (a: number) => 0.35 + 0.65 * sine(district, a) ** 2 * (0.6 + 0.4 * sine(street, a));
      const blocks = around(() => ({ width: between(next, 0.03, 0.09), tall: next(), spire: next() < 0.1, gap: next() < 0.2 }));
      const points = blocks.flatMap(({ item, start, width }): ProfilePoint[] => {
        const roof = 0.035 + town(start + width / 2) * (0.05 + 0.25 * item.tall ** 2);
        const end = item.gap ? start + 0.85 * width : start + width;
        const spire: ProfilePoint[] = item.spire ? [[start + 0.46 * (end - start), roof], [start + 0.5 * (end - start), roof + 0.07], [start + 0.54 * (end - start), roof]] : [];
        return [[start, roof], ...spire, [end, roof], ...(item.gap ? ([[end, 0.015], [start + width, 0.015]] as ProfilePoint[]) : [])];
      });
      return [...points, [TAU, points[0]![1]]];
    }
    case 'coast': {
      const SEA = 0.005;
      const rough = waveOf(next, 20, 34);
      // Střídá se moře a mys, jednou prudký sráz vlevo, jindy vpravo.
      const items = around(() => (next() < 0.5 ? { width: between(next, 0.15, 0.6), top: 0, flip: false } : { width: between(next, 0.15, 0.55), top: between(next, 0.035, 0.11), flip: next() < 0.5 }));
      return [
        ...items.flatMap(({ item, start, width }): ProfilePoint[] =>
          item.top === 0 ? [[start, SEA]] : shaped(item.flip ? HEADLAND.map(([along, share]) => [1 - along, share] as const).reverse() : HEADLAND, start, width, (at, share) => SEA + share * item.top * (0.9 + 0.1 * ridge(rough, at))),
        ),
        [TAU, SEA],
      ];
    }
  }
}

/** Plynulý přechod 0 → 1 mezi `from` a `to`. */
function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Barva vrstvy z mlhy: mlha vynásobená odstínem sady, `strength` = podíl cesty od mlhy k tomu součinu. */
function colorsOf(look: Look, tone: string, strength: number): { readonly top: string; readonly foot: string } {
  const fog = new Color(look.horizon);
  const top = fog.clone().lerp(fog.clone().multiply(new Color(tone)), strength);
  const foot = fog.clone().lerp(top, FOOT);
  return { top: `#${top.getHexString()}`, foot: `#${foot.getHexString()}` };
}

/** Odstup sousedních vrstev (m), když je odsune `beyond`: vzdálenější vrstva zůstane za bližší. */
const BEYOND_STEP_M = 6;

/**
 * Vrstvy kulisy sady od nejvzdálenější po nejbližší; sada bez `skyline` nemá žádnou.
 * `beyond` (m) = nejmenší poloměr nejbližší vrstvy (P46G T7): scéna s hrací plochou
 * daleko před kamerou (aréna v jeskyni, hřiště, střelnice) by jinak měla kulisu
 * v mlze krátké sady uvnitř hry. Odsunutá vrstva může skončit za koncem mlhy – pak
 * není vidět, ale nikdy nestojí před hrou.
 */
export function backdropLayers(look: Look, seed: number, clear: number, beyond = 0): BackdropLayer[] {
  const skyline = look.skyline;
  if (skyline === undefined) return [];
  const rng = xoroshiro128plus((seed ^ SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  const [fogNear, fogFar] = look.fog;
  const last = skyline.layers.length - 1;
  return skyline.layers.map((kind, index) => {
    const u = last === 0 ? 1 : index / last;
    const toward = (far: number, near: number): number => far + (near - far) * u;
    const radius = Math.max(fogNear + toward(FAR.fog, NEAR.fog) * (fogFar - fogNear), beyond > 0 ? beyond + (last - index) * BEYOND_STEP_M : 0);
    const follow = toward(FAR.follow, NEAR.follow);
    const notch = index === last && last > 0 ? clear / radius : 0;
    const profile = shapeOf(kind, next).map(([angle, height]): ProfilePoint => {
      const off = Math.min(angle, TAU - angle);
      const keep = notch === 0 ? 1 : 1 - NOTCH.depth * (1 - smoothstep(notch, notch * NOTCH.ramp, off));
      return [angle, height * radius * keep];
    });
    return { kind, radius, follow, approach: APPROACH * (1 - follow) * (radius - fogNear), ...colorsOf(look, skyline.tone, toward(FAR.strength, NEAR.strength)), profile };
  });
}

/** Pás vrstvy: pata `skirt` m pod zemí v barvě paty, obrys v barvě obrysu; trojúhelníky mezi sousedními body. */
export function backdropGeometry(layer: BackdropLayer, skirt: number): BufferGeometry {
  const { profile, radius } = layer;
  const positions = new Float32Array(profile.length * 6);
  const colors = new Float32Array(profile.length * 6);
  const [top, foot] = [new Color(layer.top), new Color(layer.foot)];
  profile.forEach(([angle, height], i) => {
    const [x, z] = [radius * Math.sin(angle), radius * Math.cos(angle)];
    positions.set([x, -skirt, z, x, height, z], i * 6);
    colors.set([foot.r, foot.g, foot.b, top.r, top.g, top.b], i * 6);
  });
  const index: number[] = [];
  for (let i = 0; i + 1 < profile.length; i += 1) {
    const [low, high, nextLow, nextHigh] = [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3];
    index.push(low, high, nextHigh, low, nextHigh, nextLow);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  return geometry;
}

/** Celá kulisa sady: vrstvy a jejich sítě, jedna síť na vrstvu. */
export function buildBackdrop(look: Look, { seed, clear, skirt, beyond = 0 }: BackdropOptions): BackdropPart[] {
  return backdropLayers(look, seed, clear, beyond).map((layer) => ({ layer, geometry: backdropGeometry(layer, skirt) }));
}

/**
 * Střed prstence vrstvy pro kameru v (`x`, `z`): do strany jde s kamerou z `follow`
 * (bližší vrstva ujíždí víc – paralaxa), dopředu zaostává úměrně ujeté trati až
 * o `approach` na jejím konci. `length` = délka trati (m).
 */
export function layerAt(layer: BackdropLayer, x: number, z: number, length: number): { readonly x: number; readonly z: number } {
  const progress = Math.min(1, Math.max(0, z / Math.max(1, length)));
  return { x: x * layer.follow, z: z - layer.approach * progress };
}
