'use client';

/**
 * Vibrace ovladačů ve VR (P67 T8): události sběrnice efektů → tabulka `xr/haptics.ts` → `hapticActuators[0].pulse`.
 * Vlastní sběrnice nad hrou (do `bus.ts` se nesahá, jen `EffectsBus.subscribe`): stav jen čte a stejně jako zvuk
 * vydá události jen hře člověka. Vibrace jsou mimo hashovaný stav.
 */

import { useXRInputSourceState } from '@react-three/xr';
import { useEffect, useRef } from 'react';

import { pulsesOf } from '@/play/xr/haptics';

import { createEffectsBus } from '../arcade/effects/bus';
import type { ArcadeSession } from '../arcade/session';

type Pulsing = { pulse?: (intensity: number, ms: number) => Promise<boolean> };

export function XrHaptics({ session }: { readonly session: ArcadeSession }) {
  const left = useXRInputSourceState('controller', 'left');
  const right = useXRInputSourceState('controller', 'right');
  const hands = useRef({ left, right });
  useEffect(() => {
    hands.current = { left, right };
  });

  useEffect(() => {
    const bus = createEffectsBus(session);
    const off = bus.subscribe((events) => {
      const pulses = pulsesOf(events);
      for (const hand of ['left', 'right'] as const) {
        const haptic = pulses[hand];
        if (haptic === undefined) continue;
        void (hands.current[hand]?.inputSource.gamepad?.hapticActuators?.[0] as Pulsing | undefined)?.pulse?.(haptic.intensity, haptic.ms);
      }
    });
    return () => {
      off();
      bus.dispose();
    };
  }, [session]);

  return null;
}
