/**
 * **Hotové světy, adresované obsahem** (P15 T30, design book §22.4 a §24).
 *
 * §22.4 žádá vlastnost, kterou registr relací (`sessions.ts`) neumí: *„Existující
 * sdílené světy musí zůstat čitelné"* i ve chvíli, kdy je model vypnutý, nové
 * relace se nezakládají a druhá věta stojí. Relace je živá věc — má proud, fázi,
 * meshovací práci v letu a strop souběhu. Hotový svět je proti tomu **záznam**:
 * nic nepočítá, nic nestojí a přečíst se dá i z instance, která právě nic
 * neobsluhuje.
 *
 * ## Adresa je otisk obsahu, ne pořadové číslo
 *
 * Dva důsledky, kvůli kterým to tak je:
 *
 * - **sdílet dvakrát týž svět nevyrobí dvě kopie** — druhé sdílení dopadne na
 *   tutéž adresu;
 * - odpověď se smí cachovat **navždy**, protože obsah pod adresou se z definice
 *   nemůže změnit.
 *
 * **Není to `canonicalHash` z `src/ir/worlddoc.ts`, a je to vědomé.** Ten je
 * FNV-1a na 32 bitů, tedy osm hexadecimálních číslic — to je adresa, kterou lze
 * vyjmenovat. Sdílený svět je veřejně čitelný komukoli, kdo adresu zná, takže
 * krátká adresa znamená „čitelný komukoli, kdo se nudí". Tady se proto hashuje
 * SHA-256 a bere se 32 znaků. Pravidlo „jediný hash projektu je ruční FNV-1a"
 * tím porušené není: to pravidlo mluví o **hashovaném stavu simulace** na
 * replay cestě, kde jde o determinismus mezi Node a prohlížečem. Tady je hash
 * adresa, počítá se výhradně na serveru a do stavu světa nevstupuje.
 *
 * ## Co tohle NENÍ: galerie
 *
 * §24 říká: *„Veřejné sdílení je samostatný akt; běžná relace se automaticky
 * nestává galerií."* Rozdíl, na kterém to stojí, je mezi **adresovatelný**
 * a **vypsaný**:
 *
 * - výpis neexistuje a nesmí vzniknout — žádná routa neumí vrátit seznam;
 * - adresu spočítá server z obsahu, takže ji jako první zná jedině prohlížeč té
 *   relace. Samotný akt sdílení je pořád lidský: link předá dál ten, kdo ho
 *   dostal, a nikdo jiný ho neuhodne.
 *
 * ## Retence je povinná, ne úklid navíc
 *
 * §24 chce explicitní vypršení. Bez něj je tahle mapa přesně to, čím je registr
 * relací bez `evict()`: únik paměti, který kdokoli zvenčí umí plnit. Strop je
 * proto na obojím — na stáří i na počtu — a je na tom, co se **drží**, ne na
 * tom, kolik se toho smí sdílet. Odmítat sdílení kvůli počtu by z hlídání
 * paměti udělalo odmítnutí služby.
 *
 * ## ⚠ Žije to v paměti procesu
 *
 * Táž vada a týž vědomý dluh jako u `sessions.ts`: na Vercelu je každá instance
 * vlastní paměť, takže svět sdílený na instanci A nemusí být čitelný z instance
 * B. Nikde se proto netvrdí, že sdílený svět přežije nasazení — přežije
 * **proces**, a to je všechno. Zavře to až sdílené úložiště, ne tenhle soubor.
 */

import { createHash } from 'node:crypto';

import { canonical } from '@/ir/worlddoc';

import type { WorldstreamBlueprint } from './schema';

/**
 * Jak dlouho zůstane sdílený svět čitelný. Den je nad délkou hodnocení
 * a hluboko pod „navždy", což je jediná retence, kterou §24 zakazuje.
 */
export const SHARED_WORLD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Kolik sdílených světů se drží. Jeden blueprint jsou jednotky až desítky
 * kilobajtů; 256 je řádově víc, než kolik jich vznikne za den hodnocení.
 */
export const MAX_SHARED_WORLDS = 256;

export interface SharedWorld {
  readonly hash: string;
  readonly title: string;
  readonly sessionSeed: number;
  readonly blueprint: WorldstreamBlueprint;
  readonly publishedAtMs: number;
}

const shared = new Map<string, SharedWorld>();

/** Adresa světa: SHA-256 nad kanonickou serializací, zkrácená na 32 znaků. */
export function sharedWorldHash(blueprint: WorldstreamBlueprint): string {
  return createHash('sha256').update(canonical(blueprint), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Vyhodí, co vypršelo, a pak nejstarší, dokud se mapa nevejde do stropu.
 * Pořadí `Map` je pořadí vložení, takže nejstarší je první.
 */
function evict(nowMs: number): void {
  for (const [hash, world] of shared)
    if (nowMs - world.publishedAtMs >= SHARED_WORLD_TTL_MS) shared.delete(hash);

  for (const hash of shared.keys()) {
    if (shared.size <= MAX_SHARED_WORLDS) break;
    shared.delete(hash);
  }
}

/**
 * Zpřístupní hotový svět pod jeho adresou a tu adresu vrátí.
 *
 * Opakované sdílení téhož světa je **jedno sdílení**, ne obnovení lhůty: kdyby
 * se `publishedAtMs` přepisovalo, dal by se svět držet naživu donekonečna tím,
 * že se relace zakládá pořád dokola nad týmž promptem a semínkem.
 */
export function shareWorld(blueprint: WorldstreamBlueprint, nowMs: number): string {
  const hash = sharedWorldHash(blueprint);
  if (!shared.has(hash))
    shared.set(hash, {
      hash,
      title: blueprint.title,
      sessionSeed: blueprint.sessionSeed,
      blueprint,
      publishedAtMs: nowMs,
    });
  evict(nowMs);
  return hash;
}

/**
 * Přečte sdílený svět. `null` znamená „není, nebo už vypršel" — a je to
 * schválně jedna odpověď: rozlišit je zvenčí znamená říct, že tahle adresa
 * někdy existovala.
 */
export function readSharedWorld(hash: string, nowMs: number): SharedWorld | null {
  const world = shared.get(hash);
  if (world === undefined) return null;
  if (nowMs - world.publishedAtMs >= SHARED_WORLD_TTL_MS) {
    shared.delete(hash);
    return null;
  }
  return world;
}

/** Jen pro testy: mapa je proces-globální jako registr relací. */
export function clearSharedWorlds(): void {
  shared.clear();
}

export function sharedWorldCount(): number {
  return shared.size;
}
