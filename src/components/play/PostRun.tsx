'use client';

/**
 * Po dohrání (P23-C T6): Replay, CHANGE ONE THING a CHALLENGE A FRIEND.
 *
 * Replay přetočí běh na tik 0 a nechá ho znovu doběhnout hodinami shellu –
 * vstupy hráče v runtime zůstávají, takže se přehraje týž běh do téhož konce
 * a nic nového se nezapíše. Čip pošle `POST …/remix` a přejde na odkaz dítěte;
 * rodič se nemění. Sdílení je `ShareButton` (P27B T5), týž jako v HUD.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { RemixBox } from './RemixBox';
import { ShareButton } from './ShareButton';
import { CHALLENGE_A_FRIEND, CHANGE_ONE_THING, POST_RUN_CHIPS } from './starters';

export function PostRun({ versionId, onReplay }: { readonly versionId: string; readonly onReplay: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function remix(chip: string): Promise<void> {
    setBusy(chip);
    setFailure(null);
    try {
      const response = await fetch(`/api/play/games/${versionId}/remix`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chip }),
      });
      const body = (await response.json()) as { url?: string; error?: { message?: string } };
      if (!response.ok || typeof body.url !== 'string') {
        setFailure(body.error?.message ?? 'This change could not become a game.');
        setBusy(null);
        return;
      }
      router.push(body.url);
    } catch {
      setFailure('The remix could not be created. Check your connection and try again.');
      setBusy(null);
    }
  }

  return (
    <section className="play-postrun" data-testid="play-postrun" aria-label="After the run">
      <button type="button" className="play-button" data-testid="play-replay" onClick={onReplay}>
        Replay
      </button>

      <h3 className="play-postrun-title">{CHANGE_ONE_THING}</h3>
      <div className="play-chips">
        {POST_RUN_CHIPS.map((entry) => (
          <button
            key={entry.chip}
            type="button"
            className="play-chip"
            data-testid={`play-chip-${entry.chip}`}
            disabled={busy !== null}
            aria-busy={busy === entry.chip}
            onClick={() => void remix(entry.chip)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {failure !== null && <p className="play-alert" role="alert">{failure}</p>}
      <RemixBox versionId={versionId} />

      <ShareButton versionId={versionId} label={CHALLENGE_A_FRIEND} />
    </section>
  );
}
