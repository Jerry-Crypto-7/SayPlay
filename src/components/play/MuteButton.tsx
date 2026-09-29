'use client';

/** Ztlumení zvuku her v bočním sloupci (P28C T2, P33 T12); totéž dělá klávesa M. */

import { useSyncExternalStore } from 'react';

import { PLAY_SFX, isMuted, setMuted, subscribeMuted } from '@/play/audio';

import { IconButton } from './ui';

export function MuteButton() {
  // Na serveru úložiště není: první vykreslení tvrdí „zvuk zapnutý“ a hydratace ho opraví.
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  if (!PLAY_SFX) return null;
  return (
    <IconButton
      icon={muted ? 'sound-off' : 'sound-on'}
      caption={muted ? 'Sound off' : 'Sound on'}
      aria-label="Mute sound"
      className="play-hud-mute"
      data-testid="play-mute"
      aria-pressed={muted}
      title="Sound on or off (M)"
      onClick={() => setMuted(!muted)}
    />
  );
}
