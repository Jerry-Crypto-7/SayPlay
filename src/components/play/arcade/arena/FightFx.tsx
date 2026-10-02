'use client';

/**
 * Čitelný zásah v souboji (P32E T6). Rozhoduje jádro (`pieces/fight.ts`), tady
 * se jen kreslí: švih hráče zanechá zářící srpek v oblouku úderu, zásah
 * rozsvítí tělo, na 60 ms zastaví kresbu (hit-stop) a otřese kamerou, nad
 * bojovníky visí HP a soupeř, který chystá úder, se zakloní a zrudne. KO hraje
 * klip `die` riggované postavy, jinak tělo procedurálně padne na bok.
 *
 * Hit-stop drží jen kreslené polohy: `advanceFrame` nechá jádro odtikat celý
 * čas snímku vždy a stav po tiku jen čte (`hitstop.test.ts` to hlídá hashem).
 * Záblesk, švih, pád a otřes běží na hodinách kresby (součet délek snímků),
 * ne na tiku: poslední úder běh ukončí a tiky stojí, pád ale musí doběhnout.
 * Do stavu hry nic z toho nepíše.
 */

import { Billboard } from '@react-three/drei';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Color, DoubleSide, type Group, type Material, type Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';

import { color as brand } from '@/brand/tokens';
import { BODY, HEADER, ROLE, bodyBase, bodyHp } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import type { ClipState } from '@/play/arcade/motion';
import { FIGHT, FIGHT_PHASE, attackCooldownOf, phaseOf, phaseTicksLeft } from '@/play/arcade/pieces/fight';

import { HIT_STOP_MS } from '../effects/feel';
import { type ArcadeSession, TICK_MS } from '../session';

/** Hit-stop: kresba stojí `HIT_STOP_MS` po zásahu (stejně jako mimo arénu, `effects/feel.ts`), pak ji tolik ms dotahuje k živé poloze. */
export { HIT_STOP_MS };
const CATCH_UP_MS = 60;
/** Záblesk zasaženého těla a otřes kamery (ms). */
const FLASH_MS = 160;
const SHAKE_MS = 180;
/** Největší posun kamery při otřesu (m); úder hráče třese slaběji než zásah hráče. */
const SHAKE_M = 0.12;
const BLOW_SHAKE = 0.7;
/** Jak dlouho hraje klip zásahu hráče (ms) a klip úderu po švihu (tiky z rozestupu 24). */
const HURT_CLIP_MS = 350;
const SWING_CLIP_TICKS = 18;
/** Soupeř dohrává sek ještě tolik tiků ústupu. */
const STRIKE_CLIP_TAIL = 20;
/** Procedurální pád po KO (ms) – postava bez klipu `die` – a o kolik ležící tělo zvednout, ať bokem nezajede pod podlahu (m). */
const FALL_MS = 450;
const FALL_LIFT_M = 0.3;
/** Nápřah soupeře: záklon (rad) a vzepětí (podíl velikosti) – kamera za hrdinou vidí soupeře zepředu, záklon sám by zkrátila; výpad dopředu (rad). */
const WINDUP_LEAN = 0.3;
const WINDUP_GROW = 0.12;
const STRIKE_LEAN = 0.32;
/** Statická postava bez klipu zásahu cukne dozadu. */
const RECOIL_LEAN = 0.22;

/** Barvy: červený nádech nápřahu, bílý záblesk zásahu, žlutý srpek nad prahem bloomu (≈ 1,1) – bílý by s bílým zásahem splynul. */
const TINT = new Color(brand.tomato);
const TINT_GAIN = 0.75;
const FLASH = new Color(brand.paper);
const FLASH_GAIN = 1.6;
const ARC_GLOW = new Color(brand.sun).multiplyScalar(2.2);

// ---------------------------------------------------------------------------
// Hlídka zásahů: čte stav, nikdy nepíše

export interface FightWatch {
  /** Přečte stav po ticích snímku v čase kresby `now` (ms). Stav jen čte. */
  see(state: Int32Array, now: number): void;
  /** Váha hit-stopu: 1 = kreslit polohu z chvíle zásahu, 0 = živou, mezi = dotahuje. */
  hold(now: number): number;
  /** Čas kresby posledního zásahu; −∞ = od restartu žádný. */
  lastHit(): number;
  /** Záblesk těla 0..1. */
  flash(body: number, now: number): number;
  /** Ms od KO těla; `null` = stojí. */
  downFor(body: number, now: number): number | null;
  /** Ms od posledního zásahu těla; ∞ = žádný. */
  hurtFor(body: number, now: number): number;
  /** Průběh švihu hráče 0..1; `null` = nešvihá. */
  swing(now: number): number | null;
  /** Otřes 0..1; zásah hráče ve hře člověka třese sběrnice efektů sama (`busShakes`). */
  shake(now: number, busShakes: boolean): number;
  hp(body: number): number;
  /** Nejvíc HP, co tělo od restartu mělo; 0 = tělo HP nemá. */
  maxHp(body: number): number;
  /** Zásahy od restartu (sonda). */
  hits(): number;
}

const fade = (age: number, span: number): number => (age >= 0 && age < span ? 1 - age / span : 0);

export function createFightWatch(): FightWatch {
  let tick = -1;
  let hp: number[] = [];
  let max: number[] = [];
  let hitAt: number[] = [];
  let downAt: (number | undefined)[] = [];
  let lastHit = -Infinity;
  let lastBlow = -Infinity;
  let lastHurt = -Infinity;
  let hits = 0;
  let cooldown = 0;
  let swingAt = -Infinity;
  return {
    see: (state, now) => {
      const at = state[HEADER.tick] as number;
      // Restart (tik zpět) začíná čistě: HP od začátku, žádný zásah ani pád.
      if (at < tick) {
        hp = [];
        max = [];
        hitAt = [];
        downAt = [];
        lastHit = lastBlow = lastHurt = swingAt = -Infinity;
        hits = 0;
        cooldown = 0;
      }
      tick = at;
      const player = state[HEADER.player] as number;
      const count = state[HEADER.bodyCount] as number;
      for (let body = 0; body < count; body += 1) {
        const role = state[bodyBase(body) + BODY.role];
        if (role !== ROLE.player && role !== ROLE.enemy) continue;
        const current = bodyHp(state, body);
        const before = hp[body];
        if (before !== undefined && current < before) {
          hitAt[body] = now;
          lastHit = now;
          hits += 1;
          if (body === player) lastHurt = now;
          else lastBlow = now;
          if (current === 0) downAt[body] = now;
        } else if (before === undefined || current > before) downAt[body] = undefined;
        hp[body] = current;
        max[body] = Math.max(max[body] ?? 0, current);
      }
      // Švih: rozestup hráče naskočil (z nuly na `attackCooldown`).
      const left = attackCooldownOf(state, player);
      if (left > cooldown) swingAt = now - (FIGHT.attackCooldown - left) * TICK_MS;
      cooldown = left;
    },
    hold: (now) => {
      const age = now - lastHit;
      return age < HIT_STOP_MS ? 1 : age < HIT_STOP_MS + CATCH_UP_MS ? 1 - (age - HIT_STOP_MS) / CATCH_UP_MS : 0;
    },
    lastHit: () => lastHit,
    flash: (body, now) => fade(now - (hitAt[body] ?? -Infinity), FLASH_MS),
    downFor: (body, now) => (downAt[body] === undefined ? null : now - downAt[body]),
    hurtFor: (body, now) => now - (hitAt[body] ?? -Infinity),
    swing: (now) => {
      const progress = (now - swingAt) / (FIGHT.swingTicks * TICK_MS);
      return progress >= 0 && progress < 1 ? progress : null;
    },
    shake: (now, busShakes) => Math.max(BLOW_SHAKE * fade(now - lastBlow, SHAKE_MS), busShakes ? 0 : fade(now - lastHurt, SHAKE_MS)),
    hp: (body) => hp[body] ?? 0,
    maxHp: (body) => max[body] ?? 0,
    hits: () => hits,
  };
}

/**
 * Snímek souboje: jádro odtiká celý čas snímku vždy, i během hit-stopu – hlídka
 * zásahů jen přečte stav po ticích. Vrací podíl rozběhnutého tiku jako `advance`.
 */
export function advanceFrame(session: Pick<ArcadeSession, 'advance' | 'state'>, watch: FightWatch | null, ms: number, now: number): number {
  const alpha = session.advance(ms);
  watch?.see(session.state(), now);
  return alpha;
}

const shakeBy = new Vector3();

/** Otřes kamery po zásahu (`amount` 0..1): tlumený kmit z hodin kresby, posun do strany a nahoru; s „méně pohybu“ nic. */
export function shakeCamera(position: Vector3, amount: number, now: number): void {
  if (amount <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  position.add(shakeBy.set(Math.sin(now * 0.37), Math.cos(now * 0.53), 0).multiplyScalar(amount * amount * SHAKE_M));
}

// ---------------------------------------------------------------------------
// Póza, klip a barva bojovníka

/** Materiál s vlastním svitem a jeho původní svit. */
interface SkinSlot {
  readonly material: Material & { emissive: Color; emissiveIntensity: number };
  readonly emissive: Color;
  readonly intensity: number;
}

export interface Fighter {
  /** Skupina modelu pod otočením: náklon nápřahu, výpad a pád. */
  readonly lean: Group;
  /** Vlastní kopie materiálů modelu (modely si je jinak sdílejí). */
  readonly skin: SkinSlot[];
  readonly hero: boolean;
  /** Riggovaná postava: zásah a sek hraje klip, procedurální póza jen doplňuje. */
  readonly rigged: boolean;
  /** Postava nemá klip `die`: KO = procedurální pád. */
  readonly falls: boolean;
}

const lit = (material: Material): material is SkinSlot['material'] =>
  'emissive' in material && material.emissive instanceof Color && typeof (material as { emissiveIntensity?: unknown }).emissiveIntensity === 'number';

/**
 * Převezme materiály modelu ve skupině `fighter.lean`: každý se naklonuje, ať
 * záblesk jednoho rytíře nerozsvítí i druhého. Model se načte později než scéna,
 * scéna to proto volá opakovaně; převzatá síť nese `userData.fightSkin`.
 */
export function adoptSkin(fighter: Fighter, owned: Material[]): void {
  fighter.lean.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true || mesh.userData.fightSkin === true) return;
    mesh.userData.fightSkin = true;
    const own = (material: Material): Material => {
      if (!lit(material)) return material;
      const copy = material.clone() as SkinSlot['material'];
      owned.push(copy);
      fighter.skin.push({ material: copy, emissive: copy.emissive.clone(), intensity: copy.emissiveIntensity });
      return copy;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
  });
}

function paint(skin: readonly SkinSlot[], flash: number, tint: number): void {
  for (const slot of skin) {
    if (flash > 0) {
      slot.material.emissive.copy(FLASH);
      slot.material.emissiveIntensity = FLASH_GAIN * flash;
    } else if (tint > 0) {
      slot.material.emissive.copy(TINT);
      slot.material.emissiveIntensity = TINT_GAIN * tint;
    } else {
      slot.material.emissive.copy(slot.emissive);
      slot.material.emissiveIntensity = slot.intensity;
    }
  }
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (t: number): number => t * t * (3 - 2 * t);

export interface FighterDrawn {
  readonly tinted: boolean;
  readonly flashing: boolean;
  readonly down: boolean;
}

/** Póza a barva bojovníka `body` v tomhle snímku (`alpha` = podíl rozběhnutého tiku). */
export function drawFighter(fighter: Fighter, state: Int32Array, body: number, alpha: number, watch: FightWatch, now: number): FighterDrawn {
  let pitch = 0;
  let grow = 0;
  let tint = 0;
  let fall = 0;
  const downFor = watch.downFor(body, now);
  if (downFor !== null) {
    // Pád na bok: kamera kouká podél osy souboje a tělo ležící podél ní by vypadalo jako stojící; rychle, na konci zpomalí.
    if (fighter.falls) fall = 1 - (1 - clamp01(downFor / FALL_MS)) ** 3;
  } else if (!fighter.hero) {
    const phase = phaseOf(state, body);
    const left = phaseTicksLeft(state, body);
    if (phase === FIGHT_PHASE.telegraph) {
      // Nápřah: záklon a vzepětí během první třetiny, pak se chvěje; červeň sílí až k úderu.
      const p = clamp01((FIGHT.telegraph - left + alpha) / FIGHT.telegraph);
      const k = smooth(clamp01(p / 0.35));
      pitch = -WINDUP_LEAN * k + 0.04 * p * Math.sin(now * 0.06);
      grow = WINDUP_GROW * k;
      tint = (0.45 + 0.55 * p) * (0.85 + 0.15 * Math.sin(now * 0.03));
    } else if (phase === FIGHT_PHASE.strike) {
      pitch = STRIKE_LEAN * (1 - clamp01((FIGHT.strike - left + alpha) / FIGHT.strike));
    } else if (phase === FIGHT_PHASE.stagger && !fighter.rigged) {
      pitch = -RECOIL_LEAN * clamp01(left / FIGHT.stagger);
    }
  } else if (!fighter.rigged) {
    const swing = watch.swing(now);
    if (swing !== null) pitch = STRIKE_LEAN * Math.sin(Math.PI * swing);
    else pitch = -RECOIL_LEAN * fade(watch.hurtFor(body, now), HURT_CLIP_MS);
  }
  fighter.lean.rotation.set(pitch, 0, (Math.PI / 2) * fall);
  fighter.lean.position.y = FALL_LIFT_M * fall;
  fighter.lean.scale.setScalar(1 + grow);
  const flash = watch.flash(body, now);
  paint(fighter.skin, flash, tint);
  return { tinted: tint > 0 && flash === 0, flashing: flash > 0, down: downFor !== null };
}

/**
 * Klip riggovaného bojovníka: KO, zásah, sek, jinak pohyb (`moving` z `clipOf`).
 * Postava bez klipu `die` dostane náhradu (`RiggedModel`) a scéna ji nechá padnout.
 */
export function fightClipOf(state: Int32Array, body: number, hero: boolean, watch: FightWatch, now: number, moving: ClipState): ClipState {
  if (watch.downFor(body, now) !== null) return 'die';
  if (hero) {
    if (watch.hurtFor(body, now) < HURT_CLIP_MS) return 'hit';
    return attackCooldownOf(state, body) > FIGHT.attackCooldown - SWING_CLIP_TICKS ? 'shoot' : moving;
  }
  const phase = phaseOf(state, body);
  if (phase === FIGHT_PHASE.stagger) return 'hit';
  if (phase === FIGHT_PHASE.strike || (phase === FIGHT_PHASE.retreat && phaseTicksLeft(state, body) > FIGHT.retreat - STRIKE_CLIP_TAIL)) return 'shoot';
  return phase === FIGHT_PHASE.telegraph ? 'idle' : moving;
}

// ---------------------------------------------------------------------------
// Srpek švihu

const ARC_INNER = 1.0;
const ARC_OUTER = 1.9;
const ARC_SEGMENTS = 24;
/** Výška srpku nad zemí (m) – v úrovni meče. */
const ARC_Y = 0.95;
/** Půlka oblouku úderu jádra: `attackArc` je jeho kosinus × 1000 (±60°). */
const ARC_HALF = Math.acos(FIGHT.attackArc / 1000);

/** Srpek v rovině xy kolem +y (po otočení skupiny o +90° kolem x míří na lokální +z): vnitřní hrana se ke koncům přimkne k vnější. */
function arcGeometry(): RingGeometry {
  const start = Math.PI / 2 - ARC_HALF;
  const geometry = new RingGeometry(ARC_INNER, ARC_OUTER, ARC_SEGMENTS, 1, start, 2 * ARC_HALF);
  const position = geometry.getAttribute('position');
  for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
    const theta = start + (2 * ARC_HALF * i) / ARC_SEGMENTS;
    const r = ARC_OUTER - (ARC_OUTER - ARC_INNER) * (0.15 + 0.85 * Math.sin((Math.PI * i) / ARC_SEGMENTS));
    position.setXY(i, r * Math.cos(theta), r * Math.sin(theta));
  }
  position.needsUpdate = true;
  return geometry;
}

/** Srpek švihu hráče: dítě otočené skupiny hrdiny, míří tam, kam hrdina hledí (jako oblouk úderu jádra). */
export function SwingArc({ register }: { readonly register: (mesh: Mesh | null) => void }) {
  const geometry = useMemo(arcGeometry, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh ref={register} geometry={geometry} position={[0, ARC_Y, 0]} rotation={[Math.PI / 2, 0, 0]} visible={false} renderOrder={2} userData={{ rigShadow: 'off' }}>
      <meshBasicMaterial color={ARC_GLOW} transparent opacity={0} depthWrite={false} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
}

/** Kreslí švih s průběhem 0..1 (`null` = skrýt): čelo oblouk rychle přeběhne, ocas ho dožene a srpek pohasne. */
export function drawSwing(mesh: Mesh, progress: number | null): boolean {
  if (progress === null) {
    mesh.visible = false;
    return false;
  }
  const head = Math.min(1, 0.35 + progress * 2.6);
  const tail = Math.max(0, progress * 1.6 - 0.6);
  const from = Math.floor(tail * ARC_SEGMENTS);
  const to = Math.ceil(head * ARC_SEGMENTS);
  mesh.geometry.setDrawRange(from * 6, Math.max(0, to - from) * 6);
  (mesh.material as MeshBasicMaterial).opacity = 0.9 * (1 - progress ** 3);
  mesh.visible = to > from;
  return mesh.visible;
}

// ---------------------------------------------------------------------------
// HP nad hlavou soupeře, u nohou hrdiny a pro čtečku

const BAR_W = 1.2;
const BAR_H = 0.24;
const BAR_GAP = 0.05;
const BAR_PAD = 0.06;
/** Výška lišty HP nad hlavou soupeře (m); vykřičník nápřahu stojí nad ní. */
const BAR_ABOVE_M = 0.3;
export const ALERT_ABOVE_BAR_M = BAR_ABOVE_M + BAR_H + 0.12;
/**
 * Lišta hrdiny leží u jeho nohou na straně kamery (ta stojí vždy na −z): soupeř
 * přichází podél osy kamery a lišta nad hlavou hrdiny by ležela přes něj.
 */
const HERO_BAR: [number, number, number] = [0, 0.2, -1.0];

export interface HealthBarHandle {
  set(hp: number): void;
}

/** Lišta HP čelem ke kameře: dílek za každý bod, plný v barvě strany, ztracený tmavý. Stín nevrhá. `h` = výška těla (m). */
export function HealthBar({ max, hero, h, register }: { readonly max: number; readonly hero: boolean; readonly h: number; readonly register: (bar: HealthBarHandle | null) => void }) {
  const pips = useRef<(Mesh | null)[]>([]);
  const materials = useMemo(
    () => ({
      full: new MeshBasicMaterial({ color: hero ? brand['mint-deep'] : brand.tomato, toneMapped: false }),
      empty: new MeshBasicMaterial({ color: brand['ink-soft'], toneMapped: false }),
      frame: new MeshBasicMaterial({ color: brand.ink, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
    }),
    [hero],
  );
  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose();
    },
    [materials],
  );
  useEffect(() => {
    let shown = -1;
    register({
      set: (hp) => {
        if (hp === shown) return;
        shown = hp;
        pips.current.forEach((pip, k) => {
          if (pip !== null) pip.material = k < hp ? materials.full : materials.empty;
        });
      },
    });
    return () => register(null);
  }, [register, materials]);
  const pip = (BAR_W - (max - 1) * BAR_GAP) / max;
  return (
    <Billboard position={hero ? HERO_BAR : [0, h + BAR_ABOVE_M, 0]}>
      <mesh position={[0, 0, -0.01]} material={materials.frame} renderOrder={3} userData={{ rigShadow: 'off' }}>
        <planeGeometry args={[BAR_W + 2 * BAR_PAD, BAR_H + 2 * BAR_PAD]} />
      </mesh>
      {Array.from({ length: max }, (_, k) => (
        <mesh
          key={k}
          ref={(mesh) => {
            pips.current[k] = mesh;
          }}
          position={[-BAR_W / 2 + pip / 2 + k * (pip + BAR_GAP), 0, 0]}
          material={materials.full}
          renderOrder={4}
          userData={{ rigShadow: 'off' }}
        >
          <planeGeometry args={[pip, BAR_H]} />
        </mesh>
      ))}
    </Billboard>
  );
}

/** Jméno bojovníka pro čtečku z modelu: riggovaná postava podle id, model katalogu podle id, jinak `fallback`. */
export function fighterName(model: string | undefined, fallback: string): string {
  const id = model === undefined ? '' : (riggedCharacter(model)?.id ?? model);
  const words = id.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words === '' ? fallback : words;
}

export interface MeterFighter {
  readonly index: number;
  /** „Knight“, „Rival knight“ – čtečka k tomu přidá „health 3 of 5“. */
  readonly label: string;
}

/**
 * HP pro čtečku: skrytý seznam měřidel (`role="meter"`) v ploše scény, psaný jen
 * při změně. Scéna volá vrácenou funkci každý snímek.
 */
export function useHealthMeters(surface: RefObject<HTMLDivElement | null>, fighters: readonly MeterFighter[]): RefObject<((watch: FightWatch) => void) | null> {
  const sync = useRef<((watch: FightWatch) => void) | null>(null);
  useEffect(() => {
    const host = surface.current;
    if (host === null || fighters.length === 0) return;
    const list = document.createElement('div');
    list.className = 'play-sr-only';
    list.dataset.testid = 'fight-health';
    const meters = fighters.map((fighter) => {
      const meter = document.createElement('div');
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-valuemin', '0');
      list.append(meter);
      return { fighter, meter, shown: '' };
    });
    host.append(list);
    sync.current = (watch) => {
      for (const entry of meters) {
        const hp = watch.hp(entry.fighter.index);
        const max = watch.maxHp(entry.fighter.index);
        const text = `${hp} of ${max}`;
        if (text === entry.shown) continue;
        entry.shown = text;
        entry.meter.setAttribute('aria-label', `${entry.fighter.label} health ${text}`);
        entry.meter.setAttribute('aria-valuemax', String(max));
        entry.meter.setAttribute('aria-valuenow', String(hp));
        entry.meter.setAttribute('aria-valuetext', text);
      }
    };
    return () => {
      sync.current = null;
      list.remove();
    };
  }, [surface, fighters]);
  return sync;
}
