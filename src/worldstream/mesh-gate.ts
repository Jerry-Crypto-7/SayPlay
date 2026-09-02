/**
 * **Brána před připojením meshe** (P15 T19, design book §12).
 *
 * Poslední místo, kde se dá zastavit ošklivý svět. Za ní už je jen scéna, a
 * co se na ni dostane, to porotce uvidí — takže **všechny zajímavé cesty
 * tímhle souborem jsou failure cesty** a nic z toho, co odmítne, nesmí ani
 * krátce bliknout na plátně.
 *
 * ## Odmítnutí není konec objektu
 *
 * Když brána mesh odmítne, objekt **zůstane v hrubé podobě**. Není to výpadek:
 * hlína je použitelný svět (§27) a porotce v něm může dál hrát. Proto tenhle
 * soubor nic nezahazuje a nic nepřepisuje — vrátí verdikt a slot si podobu
 * ponechá tu, kterou má.
 *
 * ## Dvě brány, dva různé pohledy na tentýž kvádr
 *
 * `RepresentationRegistry` (T18) se ptá **po osách**: přerostl mesh kvádr,
 * který si slot objednal, o víc než čtvrtinu? Je to otázka identity — sedí ta
 * podoba do tohohle slotu?
 *
 * Tady se ptáme **objemem**: je ten mesh vůbec zdravý? Práh je dvojnásobek
 * cílového objemu, a ta dvě čísla spolu **schválně souhlasí**: 1,25³ = 1,95,
 * tedy skoro přesně 2. Je to jedno tvrzení viděné ze dvou stran, ne dvě
 * nezávislá čísla, která se rozejdou při prvním ladění. Kdo hne jedním, má
 * hnout druhým, a proto to tu stojí napsané.
 *
 * ## Proč se `SHAPE_LIMITS.maxEvaluations` **nemění** (naměřeno 2. 9. 2026)
 *
 * P13 `T5-evalcap` chtěl strop 512 srazit řádově na 30, protože při 64³ stojí
 * 10 vyhodnocení 233 ms a 55 už 1 087 ms. Plán ale sám předepsal: **nejdřív
 * změř, kolik z korpusu by nový strop odmítl.** Naměřeno nad dvanácti ručními
 * programy (`evals/shape/gallery.ts`, tedy jediný korpus skutečných programů,
 * který dnes existuje): **7 až 43 vyhodnocení, medián 14.** Nejdražší ruční
 * program je tedy 12× pod dnešním stropem, a strop 30 by z těch dvanácti
 * **odmítl tři** — kořen, mušli a klenbu, tedy právě ty tvary, kvůli kterým
 * brána K1 prošla.
 *
 * Druhá půlka: čísla `T5-evalcap` jsou naměřená při **64³**, což je mřížka,
 * kterou produkt od 29. 8. nepoužívá (`MESH_DETAIL`: hrubá 32³, vysoká 48³).
 * Buněk je při 32³ osmkrát méně, takže 233 ms z toho měření je tady řádově
 * 30 ms.
 *
 * **Rozhodnutí: strop zůstává 512** a chrání to, co doopravdy chránit jde —
 * `maxTriangles` a `maxMs`, tedy **výstup**, ne odhad vstupu. Odhad vyhodnocení
 * je horní mez ceny, kterou model neumí trefit; naměřený počet trojúhelníků a
 * naměřený čas jsou to, co rozpočet skutečně utratí, a obojí hlídá brána níž.
 * Skutečné číslo pro strop vstupu půjde zvolit až nad programy, které napsal
 * model — tedy po `T14`, ne dřív.
 */

import { MESH_DETAIL, type Bounds3, type Vec3 } from '@/shape/types';
import type { MeshResult } from '@/shape/mesh-client';

import type { MeshFailure } from './cache';

/* ------------------------------------------------------------------ *
 * Verdikt.
 * ------------------------------------------------------------------ */

/**
 * Proč mesh neprošel. **Uzavřený seznam kódů, žádný volný text** — hlášku
 * nikdo nesměruje, kód ano, a `MeshFailure` z něj rozhoduje, jestli má smysl
 * to zkusit znovu.
 */
export const MESH_REJECTIONS = [
  'NO_TRIANGLES',
  'TRIANGLE_BUDGET',
  'NON_FINITE',
  'DEGENERATE_BOUNDS',
  'BOUNDS_OVERRUN',
  'NORMALS_MISSING',
  'INDEX_OUT_OF_RANGE',
  'MATERIAL_EXPLOSION',
  'READBACK_MISMATCH',
] as const;

export type MeshRejection = (typeof MESH_REJECTIONS)[number];

/**
 * Který kód selhání ke které příčině patří.
 *
 * `READBACK_MISMATCH` míří na `ARTIFACT_MISMATCH` schválně: `isRetryable()`
 * ho má v opakovatelné půlce, protože nesedící kontrolní přečtení znamená, že
 * se něco pokazilo **mezi** bránou a zápisem — ne že by byl program špatně.
 * Zbytek je vlastnost programu nebo jeho výsledku a meshovač je
 * deterministický, takže druhý pokus dá totéž.
 */
export const REJECTION_FAULT: Readonly<Record<MeshRejection, MeshFailure>> = {
  NO_TRIANGLES: 'EMPTY_MESH',
  TRIANGLE_BUDGET: 'BUDGET_EXCEEDED',
  NON_FINITE: 'GATE_REJECTED',
  DEGENERATE_BOUNDS: 'GATE_REJECTED',
  BOUNDS_OVERRUN: 'GATE_REJECTED',
  NORMALS_MISSING: 'GATE_REJECTED',
  INDEX_OUT_OF_RANGE: 'GATE_REJECTED',
  MATERIAL_EXPLOSION: 'GATE_REJECTED',
  READBACK_MISMATCH: 'ARTIFACT_MISMATCH',
};

export type MeshVerdict =
  | { readonly ok: true; readonly triangles: number; readonly bounds: Bounds3 }
  | {
      readonly ok: false;
      readonly rejection: MeshRejection;
      readonly fault: MeshFailure;
    };

function refuse(rejection: MeshRejection): MeshVerdict {
  return { ok: false, rejection, fault: REJECTION_FAULT[rejection] };
}

/* ------------------------------------------------------------------ *
 * Prahy.
 * ------------------------------------------------------------------ */

/**
 * O kolik smí naměřený kvádr přerůst objednaný, měřeno **objemem**.
 *
 * Dvojnásobek: tvar se smí své krabice dotknout a marching cubes klade vrcholy
 * na hrany buněk, takže z ní o kus buňky vyleze. Osmnáctinásobek je naopak
 * program, který si krabici nevšímá — a ten se má zastavit tady, ne na scéně.
 */
export const MAX_BOUNDS_VOLUME_RATIO = 2;

/**
 * Kolik různých materiálů smí jedna podoba nést.
 *
 * Jeden tvar je jeden materiál (§12); čtyři jsou rezerva na obal, odhalovací
 * vrstvu a kotvy. Nad tím už to není podoba jednoho objektu, ale kus scény,
 * který se do slotu dostal omylem — a každý materiál je vlastní kompilace
 * shaderu, tedy zádrhel v okamžiku, kdy se objeví na plátně.
 */
export const MAX_SLOT_MATERIALS = 4;

function volume(bounds: Bounds3): number {
  const extent: Vec3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  return extent[0] * extent[1] * extent[2];
}

function finite(bounds: Bounds3): boolean {
  return [...bounds.min, ...bounds.max].every((value) => Number.isFinite(value));
}

/* ------------------------------------------------------------------ *
 * Brána.
 * ------------------------------------------------------------------ */

export type DetailLevel = keyof typeof MESH_DETAIL;

export interface GateOrder {
  /** Kvádr, který si zadání objednalo. Bez rezervy workeru. */
  readonly bounds: Bounds3;
  readonly level: DetailLevel;
}

/**
 * Pustí mesh z workeru dál, nebo řekne kódem, proč ne.
 *
 * Pořadí kontrol je od nejlevnější a nejzákladnější: prázdný mesh se nesmí
 * odmítnout jako „přetečený rozpočet", protože nula trojúhelníků je jiná vada
 * s jinou opravou. **Nekonečné číslo se hledá dřív než cokoli, co se z čísel
 * počítá** — poměr objemů s `NaN` uvnitř by prošel jakýmkoli porovnáním.
 */
export function admitMesh(result: MeshResult, order: GateOrder): MeshVerdict {
  const budget = MESH_DETAIL[order.level];

  if (result.triangleCount <= 0 || result.indices.length === 0) return refuse('NO_TRIANGLES');

  if (!Number.isFinite(result.triangleCount) || !finite(result.bounds))
    return refuse('NON_FINITE');

  // Vrcholy se prohledávají celé: jediné `NaN` v poli udělá díru, kterou
  // naměřený kvádr nemusí zachytit, protože `Math.min(NaN, x)` je `NaN`
  // a spadne to teprve tady.
  for (let index = 0; index < result.positions.length; index += 1)
    if (!Number.isFinite(result.positions[index])) return refuse('NON_FINITE');

  // Normály nejsou volitelné: `MeshToonMaterial` bez nich vykreslí plochou
  // černou siluetu, což na snímku vypadá jako díra ve světě, ne jako chyba.
  if (result.normals.length !== result.positions.length) return refuse('NORMALS_MISSING');

  if (result.positions.length !== result.vertexCount * 3) return refuse('NORMALS_MISSING');

  // Index mimo pole je pád rendereru, ne ošklivý tvar.
  for (let index = 0; index < result.indices.length; index += 1)
    if (result.indices[index] >= result.vertexCount) return refuse('INDEX_OUT_OF_RANGE');

  if (result.triangleCount * 3 !== result.indices.length) return refuse('READBACK_MISMATCH');

  if (result.triangleCount > budget.maxTriangles) return refuse('TRIANGLE_BUDGET');

  const measured = volume(result.bounds);
  if (measured <= 0) return refuse('DEGENERATE_BOUNDS');

  const ordered = volume(order.bounds);
  if (ordered > 0 && measured > ordered * MAX_BOUNDS_VOLUME_RATIO) return refuse('BOUNDS_OVERRUN');

  return { ok: true, triangles: result.triangleCount, bounds: result.bounds };
}

/* ------------------------------------------------------------------ *
 * Kontrolní přečtení.
 * ------------------------------------------------------------------ */

/** Co má na scéně stát. Skládá se z verdiktu brány, ne z přání volajícího. */
export interface ExpectedArtifact {
  readonly contentHash: string;
  readonly triangles: number;
  readonly bounds: Bounds3;
  readonly anchors: readonly string[];
}

/** Co se na scéně doopravdy našlo. Čte to ten, kdo umí číst scénu. */
export interface ReadBack {
  readonly contentHash: string;
  readonly triangles: number;
  readonly bounds: Bounds3;
  readonly anchors: readonly string[];
  readonly materials: number;
}

function sameBounds(left: Bounds3, right: Bounds3): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (left.min[axis] !== right.min[axis]) return false;
    if (left.max[axis] !== right.max[axis]) return false;
  }
  return true;
}

/**
 * Porovná, co mělo vzniknout, s tím, co doopravdy stojí na scéně.
 *
 * **Čtyři věci, ne jedna:** hash říká, že je to tentýž program v témže
 * rozlišení; trojúhelníky, že se cestou nic neořízlo; kvádr, že to stojí tam,
 * kde se měřilo; kotvy, že objekt nepřišel o sockety, na kterých závisí druhá
 * věta. Kterákoli z nich sama by prošla i nad podvrženým artefaktem.
 */
export function verifyAttached(expected: ExpectedArtifact, actual: ReadBack): MeshVerdict {
  if (actual.materials > MAX_SLOT_MATERIALS) return refuse('MATERIAL_EXPLOSION');

  if (expected.contentHash !== actual.contentHash) return refuse('READBACK_MISMATCH');
  if (expected.triangles !== actual.triangles) return refuse('READBACK_MISMATCH');
  if (!sameBounds(expected.bounds, actual.bounds)) return refuse('READBACK_MISMATCH');

  // Kotvy se porovnávají jako množina jmen: pořadí je detail zápisu, chybějící
  // jméno je ztracený socket.
  const found = new Set(actual.anchors);
  for (const anchor of expected.anchors) if (!found.has(anchor)) return refuse('READBACK_MISMATCH');

  return { ok: true, triangles: actual.triangles, bounds: actual.bounds };
}
