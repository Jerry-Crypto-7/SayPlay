/**
 * Vyhodnocovač pole vzdáleností — z `ShapeProgram` udělá funkci
 * `(x, y, z) → vzdálenost k povrchu`.
 *
 * `types.ts` říká, **co** model smí napsat. Tenhle soubor říká, **co to
 * znamená**. Meshovač (`surface-nets.ts`) pak nad výsledkem hledá nulovou
 * hladinu, takže tady se rozhoduje o tvaru — chyba se neprojeví výjimkou, ale
 * tiše ošklivým tělesem.
 *
 * ## Tři pravidla, která tenhle soubor drží a bez kterých mesh praská
 *
 * 1. **Vzdálenost se nikdy nesmí nadstřelit.** Meshovač i každý budoucí
 *    raymarcher smí udělat krok dlouhý jako vrácená hodnota. Když je hodnota
 *    větší než skutečná vzdálenost, krok přeskočí povrch a do tvaru se udělá
 *    díra. Podstřelit se smí — stojí to jen čas. Proto každá deformace, která
 *    prostor natahuje, dělí výsledek svou **Lipschitzovou konstantou** (číslo,
 *    kolikrát nejvíc ta deformace protáhne vzdálenost). Dělení kladným číslem
 *    **nulovou hladinu neposune**, takže tvar zůstane týž a jen se zpomalí
 *    hledání — to je celá cena za jistotu.
 *
 * 2. **V horké smyčce se nealokuje.** Pole se vyhodnotí v každé buňce mřížky,
 *    tedy 274 625× při 64³. Souřadnice se proto předávají jako tři čísla, ne
 *    jako pole, a mezivýsledky rotací žijí v lokálních proměnných. Jedno
 *    `[x, y, z]` navíc je čtvrt milionu objektů na jeden tvar.
 *
 * 3. **`NaN` se ven nedostane.** Jediné `NaN` v jedné buňce otráví přes `min`
 *    a `max` celý podstrom a mesh zmizí beze slova. Místa, kde vzniknout může
 *    (nulová normála roviny, elipsoid přesně v počátku), ho vyrábět nesmějí
 *    a `evaluate()` navíc kontroluje výsledek na hranici.
 *
 * ## Náhoda
 *
 * `displace` je jediný uzel, který losuje. Stream je `pure-rand`
 * (`xoroshiro128plus`), odvozený ze `sessionSeed` **a** ze `seed` toho uzlu, a
 * tabulka se staví jednou při `createField()`, ne za běhu. Dvakrát tentýž
 * program tedy dá bitově tentýž tvar — bez toho by přestala platit cache, hash
 * i přetáčení času.
 */

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import type { Axis, ShapeNode, ShapeProgram, Vec3 } from './types';

/**
 * Hodnota, kterou vyhodnocovač vrátí místo `NaN` nebo `Infinity`.
 *
 * Je konečná a velká kladná, tedy „daleko vně". Meshovač ji přečte jako
 * prázdný prostor a udělá díru — což je viditelné a laditelné, na rozdíl od
 * `NaN`, které přes `Math.min` zamoří celý strom a nechá scénu prázdnou.
 */
export const FAR_DISTANCE = 1e6;

/** Krok centrální diference pro gradient. Zlomek nejmenší buňky mřížky. */
const DEFAULT_GRADIENT_EPSILON = 1e-3;

/* ------------------------------------------------------------------ *
 * Šum pro `displace`.
 * ------------------------------------------------------------------ */

/** Dvanáct směrů klasického Perlinova šumu. Každý má délku √2. */
const NOISE_GRADIENTS = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

const NOISE_TABLE_SIZE = 256;

/**
 * Horní odhad velikosti gradientu šumu na jednotkové mřížce.
 *
 * Perlinův šum se směry délky √2 a kvintickou náběhovou funkcí má gradient
 * omezený zhruba 2,2. Bereme 3, protože **nadstřelený odhad Lipschitzovy
 * konstanty je bezpečný** (výsledek se jen víc podstřelí), zatímco podstřelený
 * by pustil krok přes povrch. Test `field.test.ts` to připíná měřením.
 */
const NOISE_GRADIENT_BOUND = 3;

/**
 * Permutační tabulka jednoho `displace` uzlu.
 *
 * Míchá se Fisher–Yatesem nad `pure-rand`. Druhá polovina je kopie první, aby
 * se v horké smyčce nemuselo počítat modulo — index `i + 1` nikdy nepřeteče.
 */
function createPermutation(seed: number): Uint8Array {
  const table = new Uint8Array(NOISE_TABLE_SIZE * 2);
  for (let i = 0; i < NOISE_TABLE_SIZE; i += 1) table[i] = i;

  const stream = xoroshiro128plus(seed);
  for (let i = NOISE_TABLE_SIZE - 1; i > 0; i -= 1) {
    const j = uniformInt(stream, 0, i);
    const swap = table[i];
    table[i] = table[j];
    table[j] = swap;
  }

  table.copyWithin(NOISE_TABLE_SIZE, 0, NOISE_TABLE_SIZE);
  return table;
}

/** Kvintická náběhová funkce `6t⁵ − 15t⁴ + 10t³`. Má nulovou první i druhou derivaci v 0 a 1. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Skalární součin bodu se směrem číslo `hash % 12`. */
function gradientDot(hash: number, x: number, y: number, z: number): number {
  const base = (hash % 12) * 3;
  return NOISE_GRADIENTS[base] * x + NOISE_GRADIENTS[base + 1] * y + NOISE_GRADIENTS[base + 2] * z;
}

/**
 * Perlinův šum ve třech rozměrech. Vrací zhruba ⟨−1, 1⟩.
 *
 * Rozsah se **neořezává**: ořez by do funkce vnesl zlom, a přes ten zlom vede
 * povrch tvaru pokaždé, když `amplitude` sáhne k okraji. Skutečný naměřený
 * rozsah pinuje test.
 */
function perlin(perm: Uint8Array, x: number, y: number, z: number): number {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const floorZ = Math.floor(z);

  const cellX = floorX & 255;
  const cellY = floorY & 255;
  const cellZ = floorZ & 255;

  const fx = x - floorX;
  const fy = y - floorY;
  const fz = z - floorZ;

  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);

  const a = perm[cellX] + cellY;
  const aa = perm[a] + cellZ;
  const ab = perm[a + 1] + cellZ;
  const b = perm[cellX + 1] + cellY;
  const ba = perm[b] + cellZ;
  const bb = perm[b + 1] + cellZ;

  const x1 = lerp(gradientDot(perm[aa], fx, fy, fz), gradientDot(perm[ba], fx - 1, fy, fz), u);
  const x2 = lerp(
    gradientDot(perm[ab], fx, fy - 1, fz),
    gradientDot(perm[bb], fx - 1, fy - 1, fz),
    u,
  );
  const y1 = lerp(x1, x2, v);

  const x3 = lerp(
    gradientDot(perm[aa + 1], fx, fy, fz - 1),
    gradientDot(perm[ba + 1], fx - 1, fy, fz - 1),
    u,
  );
  const x4 = lerp(
    gradientDot(perm[ab + 1], fx, fy - 1, fz - 1),
    gradientDot(perm[bb + 1], fx - 1, fy - 1, fz - 1),
    u,
  );
  const y2 = lerp(x3, x4, v);

  return lerp(y1, y2, w);
}

/* ------------------------------------------------------------------ *
 * Drobná aritmetika. Všechno jen nad čísly, žádné vektory.
 * ------------------------------------------------------------------ */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampNumber(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Plynulé minimum. `k` je šířka přechodu; schéma nulu nepustí, takže se nedělí nulou. */
function smoothMin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Plynulé maximum — průnik. */
function smoothMax(a: number, b: number, k: number): number {
  const h = clamp01(0.5 - (0.5 * (b - a)) / k);
  return b * (1 - h) + a * h + k * h * (1 - h);
}

/** Plynulý rozdíl: od `base` se odečítá `removed`. */
function smoothSubtract(base: number, removed: number, k: number): number {
  const h = clamp01(0.5 - (0.5 * (base + removed)) / k);
  return base * (1 - h) - removed * h + k * h * (1 - h);
}

/* ------------------------------------------------------------------ *
 * Primitiva. Všechna stojí v počátku — umístění dělá `translate`.
 * ------------------------------------------------------------------ */

function sdSphere(x: number, y: number, z: number, radius: number): number {
  return Math.sqrt(x * x + y * y + z * z) - radius;
}

/** `hx`/`hy`/`hz` jsou **poloviční** rozměry; `size` v uzlu je plný, dělí se výš. */
function sdBox(x: number, y: number, z: number, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  const qz = Math.abs(z) - hz;
  const mx = qx > 0 ? qx : 0;
  const my = qy > 0 ? qy : 0;
  const mz = qz > 0 ? qz : 0;
  const outside = Math.sqrt(mx * mx + my * my + mz * mz);
  const inside = Math.min(Math.max(qx, qy, qz), 0);
  return outside + inside;
}

/** Kapsle podél `y`. `height` je vzdálenost středů čepiček, ne celková výška. */
function sdCapsule(x: number, y: number, z: number, height: number, radius: number): number {
  const half = height / 2;
  const t = clampNumber(y, -half, half);
  const dy = y - t;
  return Math.sqrt(x * x + dy * dy + z * z) - radius;
}

/** Válec podél `y`, `height` je celá výška. */
function sdCylinder(x: number, y: number, z: number, height: number, radius: number): number {
  const dr = Math.sqrt(x * x + z * z) - radius;
  const dy = Math.abs(y) - height / 2;
  const outsideR = dr > 0 ? dr : 0;
  const outsideY = dy > 0 ? dy : 0;
  return Math.min(Math.max(dr, dy), 0) + Math.sqrt(outsideR * outsideR + outsideY * outsideY);
}

/**
 * Kužel podél `y`, podstavou dolů. Je to uříznutý kužel s horním poloměrem 0,
 * takže vzorec zvládne i špičku, kde by naivní „vzdálenost k plášti" selhala.
 */
function sdCone(x: number, y: number, z: number, height: number, radius: number): number {
  const half = height / 2;
  const qr = Math.sqrt(x * x + z * z);

  // Hrana pláště jde z (radius, −half) do (0, +half).
  const k2r = -radius;
  const k2y = 2 * half;
  const denominator = k2r * k2r + k2y * k2y;

  const caR = qr - Math.min(qr, y < 0 ? radius : 0);
  const caY = Math.abs(y) - half;

  const t = clamp01(((0 - qr) * k2r + (half - y) * k2y) / denominator);
  const cbR = qr - 0 + k2r * t;
  const cbY = y - half + k2y * t;

  const sign = cbR < 0 && caY < 0 ? -1 : 1;
  return sign * Math.sqrt(Math.min(caR * caR + caY * caY, cbR * cbR + cbY * cbY));
}

/** Prstenec v rovině `xz`, osa `y`. */
function sdTorus(
  x: number,
  y: number,
  z: number,
  majorRadius: number,
  minorRadius: number,
): number {
  const qr = Math.sqrt(x * x + z * z) - majorRadius;
  return Math.sqrt(qr * qr + y * y) - minorRadius;
}

/**
 * Poloprostor. `offset` je vzdálenost roviny od počátku **po normalizaci**
 * normály, takže na délce zapsaného vektoru nezáleží.
 */
function sdPlane(x: number, y: number, z: number, normal: Vec3, offset: number): number {
  const [nx, ny, nz] = normal;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  // Nulová normála nepopisuje rovinu. Dělení by dalo `NaN`, které by se přes
  // `min` rozlilo do celého tvaru — schéma ji nepustí, ale vyhodnocovač je
  // druhá obrana a nesmí spoléhat na to, že první drží.
  if (length < 1e-12) return FAR_DISTANCE;
  return (x * nx + y * ny + z * nz) / length - offset;
}

/**
 * Pravidelný `sides`-boký hranol podél `y`, `radius` je poloměr opsané kružnice.
 *
 * Úhel se přeloží do jednoho výseku, takže se počítá vzdálenost k **jedné**
 * hraně místo k `sides` hranám. Uvnitř výseku je hrana svislá úsečka, což dělá
 * ze vzdálenosti dva případy: podél hrany a za rohem.
 */
function sdPrism(
  x: number,
  y: number,
  z: number,
  sides: number,
  radius: number,
  height: number,
): number {
  const segment = (2 * Math.PI) / sides;
  const r = Math.sqrt(x * x + z * z);
  const angle = Math.atan2(z, x);

  // Výsek se překládá kolem **středu strany**, ne kolem vrcholu. Vrchol číslo 0
  // leží na `+x`, takže středy stran jsou na `segment/2 + k·segment` — o ten
  // půlkrok se úhel posune, než se přeloží.
  //
  // Bez posunu vyjde `u` ve směru vrcholu a vzorec ho pak porovná s apotémou,
  // tedy s poloměrem vepsané kružnice. Naměřeno nezávislým vzorcem: hranol byl
  // pootočený o půl výseku a v bodě (2,05, 1,21) vracel 1,279 místo 1,426.
  const shifted = angle - segment / 2;
  const folded = shifted - segment * Math.round(shifted / segment);

  const u = r * Math.cos(folded);
  const v = r * Math.sin(folded);

  const apothem = radius * Math.cos(Math.PI / sides);
  const halfEdge = radius * Math.sin(Math.PI / sides);

  const du = u - apothem;
  const dv = Math.abs(v) - halfEdge;
  // Za rohem (`dv > 0`) je `du` po přeložení vždy kladné, takže znaménko nese `du`.
  const dPlane = dv <= 0 ? du : Math.sqrt(du * du + dv * dv);

  const dy = Math.abs(y) - height / 2;
  const outsidePlane = dPlane > 0 ? dPlane : 0;
  const outsideY = dy > 0 ? dy : 0;
  return (
    Math.min(Math.max(dPlane, dy), 0) + Math.sqrt(outsidePlane * outsidePlane + outsideY * outsideY)
  );
}

/**
 * Elipsoid. Je to **odhad**, ne přesná vzdálenost — přesná nemá uzavřený tvar.
 *
 * Bere se elipsoid jako jednotková koule zvětšená o `radii`, tedy táž úvaha
 * jako u uzlu `scale`: vzdálenost v souřadnicích koule se násobí **nejmenší**
 * poloosou, což je jediný činitel, který zaručeně nenadstřelí.
 *
 * **Známý ostřejší odhad `k0·(k0−1)/k1` je tu schválně nepoužitý.** Naměřeno
 * 29. 8. 2026 nad `radii = [1,5, 0,7, 1,0]`: v 31 z 625 zkoušených bodů
 * nadstřelil skutečnou vzdálenost, takže povrch ležel blíž, než tvrdil. Ostřejší
 * odhad, který občas nadstřelí, je horší než tupý, který nikdy — díra v meshi
 * se neopraví tím, že je jinde tvar hezčí.
 */
function sdEllipsoid(x: number, y: number, z: number, radii: Vec3): number {
  const [rx, ry, rz] = radii;
  const ax = x / rx;
  const ay = y / ry;
  const az = z / rz;
  const normalized = Math.sqrt(ax * ax + ay * ay + az * az);
  return (normalized - 1) * Math.min(rx, ry, rz);
}

/* ------------------------------------------------------------------ *
 * Vyhodnocovač.
 * ------------------------------------------------------------------ */

/** Osa jako index 0/1/2 — v horké smyčce se nesmí porovnávat řetězce. */
function axisIndex(axis: Axis): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

export interface Field {
  /** Vzdálenost k povrchu. Záporná uvnitř, kladná vně, nikdy `NaN`. */
  at(x: number, y: number, z: number): number;
  /**
   * Gradient centrální diferencí, zapsaný do `out[0..2]`. Není normalizovaný —
   * normalizuje si ho, kdo ho potřebuje jako normálu.
   */
  gradientInto(
    x: number,
    y: number,
    z: number,
    out: Float32Array | Float64Array | number[],
  ): void;
}

/**
 * Postaví vyhodnocovač nad programem.
 *
 * Šumové tabulky se staví **tady**, jednou na program, ne při každém
 * vyhodnocení. Míchání permutace je 256 losů; při 64³ buňkách by to jinak bylo
 * sedmdesát milionů losů na jeden `displace`.
 */
export function createField(
  program: Pick<ShapeProgram, 'nodes' | 'root'>,
  sessionSeed: number,
): Field {
  const { nodes, root } = program;

  // Jedna tabulka na `displace` uzel. Klíč je index řádku, ne `seed`: dva uzly
  // se stejným `seed` mají být stejné, a to zařídí shodný odvozený stream.
  const permutations = new Map<number, Uint8Array>();
  nodes.forEach((node, index) => {
    if (node.kind === 'displace') {
      // Stream se odvozuje ze **sessionSeed i ze seedu uzlu**. Sám `node.seed`
      // by dal dvěma relacím tentýž šum, sám `sessionSeed` by dal všem uzlům
      // programu jeden a týž.
      const derived = (Math.imul(sessionSeed | 0, 0x9e3779b1) ^ Math.imul(node.seed | 0, 0x85ebca6b)) | 0;
      permutations.set(index, createPermutation(derived));
    }
  });

  function evaluate(index: number, x: number, y: number, z: number): number {
    const node = nodes[index];

    switch (node.kind) {
      /* -------- primitiva -------- */
      case 'sphere':
        return sdSphere(x, y, z, node.radius);
      case 'box':
        return sdBox(x, y, z, node.size[0] / 2, node.size[1] / 2, node.size[2] / 2);
      case 'roundBox':
        return (
          sdBox(x, y, z, node.size[0] / 2, node.size[1] / 2, node.size[2] / 2) - node.radius
        );
      case 'capsule':
        return sdCapsule(x, y, z, node.height, node.radius);
      case 'cylinder':
        return sdCylinder(x, y, z, node.height, node.radius);
      case 'cone':
        return sdCone(x, y, z, node.height, node.radius);
      case 'torus':
        return sdTorus(x, y, z, node.majorRadius, node.minorRadius);
      case 'plane':
        return sdPlane(x, y, z, node.normal, node.offset);
      case 'prism':
        return sdPrism(x, y, z, node.sides, node.radius, node.height);
      case 'ellipsoid':
        return sdEllipsoid(x, y, z, node.radii);

      /* -------- kombinace -------- */
      case 'union': {
        const { children, k } = node;
        let result = evaluate(children[0], x, y, z);
        for (let i = 1; i < children.length; i += 1) {
          const next = evaluate(children[i], x, y, z);
          result = k === undefined ? Math.min(result, next) : smoothMin(result, next, k);
        }
        return result;
      }
      case 'intersect': {
        const { children, k } = node;
        let result = evaluate(children[0], x, y, z);
        for (let i = 1; i < children.length; i += 1) {
          const next = evaluate(children[i], x, y, z);
          result = k === undefined ? Math.max(result, next) : smoothMax(result, next, k);
        }
        return result;
      }
      case 'subtract': {
        // První potomek je základ, zbytek se odečítá — tady pořadí nese význam.
        const { children, k } = node;
        let result = evaluate(children[0], x, y, z);
        for (let i = 1; i < children.length; i += 1) {
          const next = evaluate(children[i], x, y, z);
          result = k === undefined ? Math.max(result, -next) : smoothSubtract(result, next, k);
        }
        return result;
      }

      /* -------- transformace: mění se souřadnice, ne těleso -------- */
      case 'translate':
        return evaluate(node.child, x - node.offset[0], y - node.offset[1], z - node.offset[2]);

      case 'rotate': {
        // Dopředu se skládá yaw, pak pitch, pak roll. Bod se tedy převádí do
        // souřadnic potomka opačným pořadím a opačnými znaménky.
        const cr = Math.cos(-node.roll);
        const sr = Math.sin(-node.roll);
        const x1 = x * cr - y * sr;
        const y1 = x * sr + y * cr;

        const cp = Math.cos(-node.pitch);
        const sp = Math.sin(-node.pitch);
        const y2 = y1 * cp - z * sp;
        const z2 = y1 * sp + z * cp;

        const cy = Math.cos(-node.yaw);
        const sy = Math.sin(-node.yaw);
        const x3 = x1 * cy + z2 * sy;
        const z3 = -x1 * sy + z2 * cy;

        return evaluate(node.child, x3, y2, z3);
      }

      case 'scale': {
        const [fx, fy, fz] = node.factor;
        // Nejmenší složka je jediný činitel, který vzdálenost zaručeně
        // nenadstřelí. Zdůvodnění je v `types.ts` u `ScaleNode`.
        const smallest = Math.min(fx, fy, fz);
        return evaluate(node.child, x / fx, y / fy, z / fz) * smallest;
      }

      case 'mirror': {
        const about = node.about ?? 0;
        const axis = axisIndex(node.axis);
        // Přeložení souřadnice, ne kopie: stojí jedno vyhodnocení místo dvou.
        const fx = axis === 0 ? about + Math.abs(x - about) : x;
        const fy = axis === 1 ? about + Math.abs(y - about) : y;
        const fz = axis === 2 ? about + Math.abs(z - about) : z;
        return evaluate(node.child, fx, fy, fz);
      }

      /* -------- deformace: ohýbají prostor, a proto dělí Lipschitzem -------- */
      case 'twist': {
        const axis = axisIndex(node.axis);
        const along = axis === 0 ? x : axis === 1 ? y : z;
        const angle = -node.radiansPerUnit * along;
        const c = Math.cos(angle);
        const s = Math.sin(angle);

        let tx = x;
        let ty = y;
        let tz = z;
        let radial: number;
        if (axis === 0) {
          ty = y * c - z * s;
          tz = y * s + z * c;
          radial = Math.sqrt(y * y + z * z);
        } else if (axis === 1) {
          tx = x * c + z * s;
          tz = -x * s + z * c;
          radial = Math.sqrt(x * x + z * z);
        } else {
          tx = x * c - y * s;
          ty = x * s + y * c;
          radial = Math.sqrt(x * x + y * y);
        }

        // Zkroucení natahuje obvod tím víc, čím dál od osy. Bod ve vzdálenosti
        // `r` se posune o `radiansPerUnit · r` na metr podél osy.
        const stretch = Math.sqrt(1 + node.radiansPerUnit * node.radiansPerUnit * radial * radial);
        return evaluate(node.child, tx, ty, tz) / stretch;
      }

      case 'bend': {
        // `axis` je osa oblouku. Těleso běží podél **následující** osy v pořadí
        // x → y → z → x a zahýbá do té další. Pro `axis = 'z'` tedy: délka
        // podél `x`, ohyb do `y`.
        //
        // Trojice se rozepisuje do tří větví místo do pole schválně: `[x, y, z]`
        // je alokace, a tenhle uzel se vyhodnocuje v každé buňce mřížky.
        const axis = axisIndex(node.axis);
        const along = axis === 0 ? y : axis === 1 ? z : x;
        const across = axis === 0 ? z : axis === 1 ? x : y;

        const angle = -node.curvature * along;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const bentAlong = along * c - across * s;
        const bentAcross = along * s + across * c;

        const stretch = 1 + Math.abs(node.curvature) * Math.sqrt(along * along + across * across);

        const tx = axis === 0 ? x : axis === 1 ? bentAcross : bentAlong;
        const ty = axis === 0 ? bentAlong : axis === 1 ? y : bentAcross;
        const tz = axis === 0 ? bentAcross : axis === 1 ? bentAlong : z;
        return evaluate(node.child, tx, ty, tz) / stretch;
      }

      case 'taper': {
        const axis = axisIndex(node.axis);
        const along = axis === 0 ? x : axis === 1 ? y : z;
        const raw = 1 + node.amount * along;
        const scale = clampNumber(raw, 0.05, 20);
        // Za sevřením je průřez konstantní, takže derivace zúžení je nulová.
        const slope = raw === scale ? node.amount : 0;

        let tx = x;
        let ty = y;
        let tz = z;
        let radial: number;
        if (axis === 0) {
          ty = y / scale;
          tz = z / scale;
          radial = Math.sqrt(y * y + z * z);
        } else if (axis === 1) {
          tx = x / scale;
          tz = z / scale;
          radial = Math.sqrt(x * x + z * z);
        } else {
          tx = x / scale;
          ty = y / scale;
          radial = Math.sqrt(x * x + y * y);
        }

        // Frobeniova norma Jacobiánu je horní odhad té operátorové, a počítá se
        // ze tří čísel. Přesnější odhad by tvar nezměnil, jen zrychlil hledání.
        const stretch = Math.sqrt(
          2 / (scale * scale) + 1 + (slope * slope * radial * radial) / scale ** 4,
        );
        return evaluate(node.child, tx, ty, tz) / stretch;
      }

      case 'revolve': {
        // Rovina profilu: osa a **první** zbylá souřadnice v pořadí x, y, z.
        // Pro 'y' je to rovina x–y, tedy profil na `x = radius` — to je ta
        // orientace, ve které klenba stojí a nekouká naležato.
        const axis = axisIndex(node.axis);
        const a = axis === 0 ? y : x;
        const b = axis === 2 ? y : z;
        const along = axis === 0 ? x : axis === 1 ? y : z;

        const radial = Math.sqrt(a * a + b * b);
        const angle = Math.atan2(b, a);
        // Sevření je **půlka** `sweep`, protože výsek je symetrický kolem
        // profilu. Odečet poloroviny by tu byl špatně: řezal by celé pole, tedy
        // i to, co leží za osou, a z klenby by ukrojil i její druhou patku.
        const half = node.sweep / 2;
        const clamped = angle < -half ? -half : angle > half ? half : angle;
        const rest = angle - clamped;

        // Zbytek úhlu se nese jako poloha **v rovině profilu**: uvnitř výseku je
        // nulový a uzel se chová jako celý prstenec, za koncem odnáší bod od
        // čela oblouku po kružnici. Otáčení je izometrie, takže se tu na rozdíl
        // od ostatních deformací nedělí Lipschitzem.
        const profileA = radial * Math.cos(rest) - node.radius;
        const profileB = radial * Math.sin(rest);

        const tx = axis === 0 ? along : profileA;
        const ty = axis === 0 ? profileA : axis === 1 ? along : profileB;
        const tz = axis === 2 ? along : profileB;
        return evaluate(node.child, tx, ty, tz);
      }

      case 'displace': {
        const perm = permutations.get(index);
        // Bez tabulky by uzel tiše nedělal nic. Program bez ní sem nedojde,
        // ale mlčení by z chyby stavby udělalo neviditelný rozdíl v tvaru.
        if (perm === undefined) return evaluate(node.child, x, y, z);
        const f = node.frequency;
        const wave = perlin(perm, x * f, y * f, z * f);
        const stretch = 1 + node.amplitude * f * NOISE_GRADIENT_BOUND;
        return (evaluate(node.child, x, y, z) + node.amplitude * wave) / stretch;
      }

      /* -------- pole -------- */
      case 'repeat': {
        const [sx, sy, sz] = node.step;
        let best = evaluate(node.child, x, y, z);
        for (let i = 1; i < node.count; i += 1) {
          const next = evaluate(node.child, x - sx * i, y - sy * i, z - sz * i);
          if (next < best) best = next;
        }
        return best;
      }

      case 'radialArray': {
        // Otáčí se v rovině dvou os, které nejsou `axis`. Kopie číslo 0 sedí na
        // **následující** ose v pořadí x → y → z → x, ve vzdálenosti `radius`
        // od osy otáčení — to je zároveň ta osa, o kterou se pak posouvá.
        //
        // Tři větve místo pole ze stejného důvodu jako u `bend`: žádná alokace.
        const axis = axisIndex(node.axis);
        const a0 = axis === 0 ? y : axis === 1 ? z : x;
        const b0 = axis === 0 ? z : axis === 1 ? x : y;
        const fixed = axis === 0 ? x : axis === 1 ? y : z;

        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < node.count; i += 1) {
          const angle = (-2 * Math.PI * i) / node.count;
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const a = a0 * c - b0 * s - node.radius;
          const b = a0 * s + b0 * c;

          const tx = axis === 0 ? fixed : axis === 1 ? b : a;
          const ty = axis === 0 ? a : axis === 1 ? fixed : b;
          const tz = axis === 0 ? b : axis === 1 ? a : fixed;

          const next = evaluate(node.child, tx, ty, tz);
          if (next < best) best = next;
        }
        return best;
      }

      case 'arrayAlongCurve': {
        const { points, count } = node;
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < count; i += 1) {
          const t = count === 1 ? 0 : i / (count - 1);
          const px = catmullRomComponent(points, t, 0);
          const py = catmullRomComponent(points, t, 1);
          const pz = catmullRomComponent(points, t, 2);
          const next = evaluate(node.child, x - px, y - py, z - pz);
          if (next < best) best = next;
        }
        return best;
      }

      /* -------- maskování -------- */
      case 'clip': {
        const inner = evaluate(node.child, x, y, z);
        const region = node.region;
        if (region.kind === 'halfSpace') {
          return Math.max(inner, sdPlane(x, y, z, region.normal, region.offset));
        }
        const [cx, cy, cz] = region.center;
        const [sx, sy, sz] = region.size;
        return Math.max(inner, sdBox(x - cx, y - cy, z - cz, sx / 2, sy / 2, sz / 2));
      }
    }
  }

  function at(x: number, y: number, z: number): number {
    const value = evaluate(root, x, y, z);
    // Poslední obrana. `NaN` ani `±Infinity` se přes tuhle hranici nedostane,
    // protože meshovač je přes `min`/`max` rozlije do celé mřížky.
    return Number.isFinite(value) ? value : FAR_DISTANCE;
  }

  function gradientInto(
    x: number,
    y: number,
    z: number,
    out: Float32Array | Float64Array | number[],
  ): void {
    const e = DEFAULT_GRADIENT_EPSILON;
    out[0] = at(x + e, y, z) - at(x - e, y, z);
    out[1] = at(x, y + e, z) - at(x, y - e, z);
    out[2] = at(x, y, z + e) - at(x, y, z - e);
  }

  return { at, gradientInto };
}

/**
 * Jedna složka bodu na Catmull-Rom křivce.
 *
 * Krajní body se zdvojují, takže křivka **prochází** prvním i posledním
 * kontrolním bodem. Se dvěma body vyjde úsečka.
 */
function catmullRomComponent(points: readonly Vec3[], t: number, component: 0 | 1 | 2): number {
  const last = points.length - 1;
  if (last === 0) return points[0][component];

  const scaled = clamp01(t) * last;
  const segment = Math.min(Math.floor(scaled), last - 1);
  const local = scaled - segment;

  const p0 = points[Math.max(segment - 1, 0)][component];
  const p1 = points[segment][component];
  const p2 = points[segment + 1][component];
  const p3 = points[Math.min(segment + 2, last)][component];

  const t2 = local * local;
  const t3 = t2 * local;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * local +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Vystavené jen pro test — pinuje odhad, na kterém stojí bezpečnost `displace`. */
export const NOISE_INTERNALS = {
  NOISE_GRADIENT_BOUND,
  createPermutation,
  perlin,
} as const;

/** Vystavené jen pro test — křivka je jinak vidět až přes hotový tvar. */
export const CURVE_INTERNALS = { catmullRomComponent } as const;

/** Typ uzlu, který se v programu nevyskytl. Drží vyčerpanost `switch`e. */
export type EvaluatedNodeKind = ShapeNode['kind'];
