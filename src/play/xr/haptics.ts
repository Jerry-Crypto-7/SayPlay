/**
 * Vibrace ovladačů ve VR (P67 T8): jedna tabulka `druh události sběrnice → síla, délka, ruka`. Pulz pošle
 * `XrHaptics` přes `hapticActuators[0].pulse`. Tabulka je úplná podle typu (`Record`): nový druh události bez
 * záznamu neprojde překladem ani testem; `null` = druh, který se necítí.
 *
 * Vibrace jsou mimo hashovaný stav a vypínač (`setHapticsOn`) patří komfortnímu panelu (T9). Výchozí je zapnuto.
 */

import type { VisualEvent, VisualEventKind } from '@/components/play/arcade/effects/bus';

export type HapticHand = 'left' | 'right' | 'both';

export interface Haptic {
  /** Síla 0–1. */
  readonly intensity: number;
  readonly ms: number;
  /**
   * Pravá ruka ve VR-nativních žánrech střílí, máchá a bouchá, proto zásahy jdou do ní. Konec běhu, power-up,
   * padlý boss a blízké minutí jdou do obou.
   */
  readonly hand: HapticHand;
}

export const XR_HAPTICS: Readonly<Record<VisualEventKind, Haptic | null>> = {
  // Zásah jako dřív v `XrSwing` (P65 T3): rána hráče i rána do hráče.
  hit: { intensity: 0.6, ms: 40, hand: 'right' },
  pickup: { intensity: 0.3, ms: 20, hand: 'right' },
  death: { intensity: 0.45, ms: 30, hand: 'right' },
  win: { intensity: 0.5, ms: 140, hand: 'both' },
  lose: { intensity: 0.8, ms: 220, hand: 'both' },
  nearMiss: { intensity: 0.2, ms: 25, hand: 'both' },
  powerup: { intensity: 0.5, ms: 80, hand: 'both' },
  bossDefeat: { intensity: 1, ms: 160, hand: 'both' },
  comboUp: { intensity: 0.35, ms: 25, hand: 'right' },
  // Zásah akcí má v témže tiku `hit` nebo `death` téhož těla, ten už vibruje.
  ability: null,
  // Změna stavu cíle, dopad hrdiny a zrod těla se dějí pořád; v ruce by byly šum.
  stateChange: null,
  land: null,
  spawn: null,
};

let on = true;

/** Vibruje se? Vypínač nastavuje `XrRig` z voleb panelu „Comfort“ (T9, `comfort.ts`). */
export const hapticsOn = (): boolean => on;

export function setHapticsOn(value: boolean): void {
  on = value;
}

const stronger = (a: Haptic, b: Haptic | undefined): boolean => b === undefined || a.intensity > b.intensity || (a.intensity === b.intensity && a.ms > b.ms);

/**
 * Pulzy jednoho tiku sběrnice: každé ruce nejsilnější záznam z jejích událostí. Nový pulz ovladače ruší ten
 * předchozí, takže víc pulzů v jednom tiku by se jen přebíjelo. S vypnutými vibracemi nic.
 */
export function pulsesOf(events: readonly Pick<VisualEvent, 'kind'>[]): Partial<Record<'left' | 'right', Haptic>> {
  const out: Partial<Record<'left' | 'right', Haptic>> = {};
  if (!on) return out;
  for (const event of events) {
    const haptic = XR_HAPTICS[event.kind];
    if (haptic === null) continue;
    for (const hand of haptic.hand === 'both' ? (['left', 'right'] as const) : [haptic.hand]) {
      if (stronger(haptic, out[hand])) out[hand] = haptic;
    }
  }
  return out;
}
