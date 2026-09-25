'use client';

/** Ztlumení zvuku her v HUD (P28C T2); totéž dělá klávesa M. */

import { useSyncExternalStore } from 'react';

import { PLAY_SFX, isMuted, setMuted, subscribeMuted } from '@/play/audio';

export function MuteButton() {
  // Na serveru úložiště není: první vykreslení tvrdí „zvuk zapnutý“ a hydratace ho opraví.
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  if (!PLAY_SFX) return null;
  return (
    <button type="button" className="play-button play-hud-mute" data-testid="play-mute" aria-pressed={muted} title="Sound on or off (M)" onClick={() => setMuted(!muted)}>
      {muted ? 'Sound off' : 'Sound on'}
    </button>
  );
}
