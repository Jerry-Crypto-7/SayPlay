'use client';

/**
 * Aktivní power-up a násobič komba v HUD (P46C T5). Odznak = kolo s ikonou
 * power-upu a inkoustovým prstencem, který ubývá se zbylým časem; vedle něj
 * slunečná pilulka „×N“, dokud kombo běží (×1 se neukazuje). Stav se jen čte
 * ze simulace (počítadla `POWERUP_SLOTS` a komba), do hashe nic nepřibude.
 * Hra bez power-upů i bez komba (každá stará hra) nevykreslí nic.
 */

import { useSyncExternalStore } from 'react';

import { underlyingRule } from '@/play/arcade/addons';
import { type ArcadeWorld, BODY, COMBO, COUNTER, HEADER, POWERUPS, POWERUP_SLOTS, POWERUP_TICKS, type PowerupId, bodyBase } from '@/play/arcade/contract';

import { Icon, type IconName } from '../ui/icons';
import type { ArcadeSession } from './session';

/** Ikona a popisek power-upu; ikony ze sady kitu (`docs/brand/REPO-NOTES.md`). */
const FACES: Readonly<Record<PowerupId, { readonly label: string; readonly icon: IconName }>> = {
  magnet: { label: 'Magnet', icon: 'grab' },
  shield: { label: 'Shield', icon: 'shield' },
  speed: { label: 'Speed', icon: 'dash' },
  double: { label: 'Double points', icon: 'plus' },
};

/** Těla-počítadla světa: power-upů (pravidlo `pickup`) a komba (`pickup` / `shot_hit`). */
export interface BoostKeepers {
  readonly powerup?: number;
  readonly combo?: number;
}

export function boostKeepers(world: ArcadeWorld): BoostKeepers {
  let powerup: number | undefined;
  let combo: number | undefined;
  for (const rule of world.rules.map(underlyingRule)) {
    if (rule.id !== 'pickup' && rule.id !== 'shot_hit') continue;
    const params = rule.params as { readonly combo?: number; readonly powerup?: { readonly keeper: number } };
    combo ??= params.combo;
    powerup ??= params.powerup?.keeper;
  }
  return { powerup, combo };
}

export interface BoostReading {
  readonly power: PowerupId | null;
  /** Zbylý díl trvání power-upu, 0–1. */
  readonly fraction: number;
  /** Násobič běžícího komba; 1 = žádné kombo. */
  readonly multiplier: number;
}

/**
 * Stav power-upu a komba v `state`. Kombo platí, dokud by další sebrání násobič
 * zvedlo – táž podmínka jako `nextMultiplier` v `pieces/rules.ts`.
 */
export function readBoosts(state: Int32Array, keepers: BoostKeepers): BoostReading {
  let power: PowerupId | null = null;
  let fraction = 0;
  if (keepers.powerup !== undefined) {
    const base = bodyBase(keepers.powerup);
    const left = state[base + POWERUP_SLOTS.left] as number;
    const kind = POWERUPS[(state[base + POWERUP_SLOTS.kind] as number) - 1];
    if (left > 0 && kind !== undefined) {
      power = kind;
      fraction = Math.min(1, left / POWERUP_TICKS[kind]);
    }
  }
  let multiplier = 1;
  if (keepers.combo !== undefined) {
    const base = bodyBase(keepers.combo);
    const last = state[base + BODY.aux1] as number;
    const health = state[HEADER.counters + COUNTER.health] as number;
    const running = last > 0 && (state[HEADER.tick] as number) + 1 - last <= COMBO.window && health >= (state[base + BODY.x] as number);
    if (running) multiplier = Math.max(1, state[base + BODY.aux0] as number);
  }
  return { power, fraction, multiplier };
}

/** Poloměr a obvod prstence v souřadnicích `viewBox` 0 0 48 48. */
const RING_R = 21;
export const RING_LENGTH = 2 * Math.PI * RING_R;

/** Odznak a násobič; čistě z odečtu, takže ho test vykreslí bez relace. */
export function PowerupBadge({ power, fraction, multiplier }: BoostReading) {
  if (power === null && multiplier < 2) return null;
  return (
    <div className="play-boosts" aria-live="polite">
      {power !== null && (
        <span className="play-boost" data-testid="hud-counter-powerup" data-power={power} data-count={Math.round(fraction * 100)} title={FACES[power].label}>
          <svg className="play-boost-ring" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            {/* Oblouk délky zbytku začíná nahoře: odsazení o čtvrt obvodu místo otočení, které kit mimo nakloněné třídy nedovolí. */}
            <circle cx="24" cy="24" r={RING_R} strokeDasharray={`${RING_LENGTH * fraction} ${RING_LENGTH * (1 - fraction)}`} strokeDashoffset={RING_LENGTH / 4} />
          </svg>
          <Icon name={FACES[power].icon} />
          <span className="play-sr-only">{FACES[power].label}</span>
        </span>
      )}
      {multiplier >= 2 && (
        <span className="sp-hud-pill sp-hud-pill--sun play-boost-combo" data-testid="hud-counter-combo" data-count={multiplier}>
          ×{multiplier}
          <span className="play-sr-only"> combo</span>
        </span>
      )}
    </div>
  );
}

/** Odečet jako jeden řetězec: `useSyncExternalStore` chce stálou hodnotu mezi tiky bez změny. */
const pack = (reading: BoostReading): string => `${reading.power ?? ''}|${reading.fraction}|${reading.multiplier}`;
function unpack(packed: string): BoostReading {
  const [power, fraction, multiplier] = packed.split('|');
  return { power: power === '' ? null : (power as PowerupId), fraction: Number(fraction), multiplier: Number(multiplier) };
}

/** Odznak nad scénou relace; svět bez počítadel nevykreslí nic a neodebírá tiky. */
export function HudBoosts({ session, keepers }: { readonly session: ArcadeSession; readonly keepers: BoostKeepers }) {
  const packed = useSyncExternalStore(
    session.subscribe,
    () => pack(readBoosts(session.state(), keepers)),
    () => '|0|1',
  );
  return <PowerupBadge {...unpack(packed)} />;
}
