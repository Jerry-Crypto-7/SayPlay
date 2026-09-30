'use client';

/**
 * Zvuk her na kartě pauzy (P28C T2, od P34 T5 místo kola v bočním sloupci);
 * totéž dělá klávesa M (`installSoundControls`). Text říká stav, ikona ho opakuje.
 */

import { useSyncExternalStore } from 'react';

import { PLAY_SFX, isMuted, setMuted, subscribeMuted } from '@/play/audio';

import { Button, Icon } from './ui';

export function MuteButton() {
  // Na serveru úložiště není: první vykreslení tvrdí „zvuk zapnutý“ a hydratace ho opraví.
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  if (!PLAY_SFX) return null;
  return (
    <Button variant="secondary" size="s" className="play-hud-mute" data-testid="play-mute" aria-pressed={muted} title="Sound on or off (M)" onClick={() => setMuted(!muted)}>
      <Icon name={muted ? 'sound-off' : 'sound-on'} />
      {muted ? 'Sound off' : 'Sound on'}
    </Button>
  );
}
