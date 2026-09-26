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
import { useEffect, useRef, useState } from 'react';

import { RemixBox, type RemixJob } from './RemixBox';
import { ShareButton } from './ShareButton';
import { CHALLENGE_A_FRIEND, CHANGE_ONE_THING, POST_RUN_CHIPS } from './starters';

/** Klip běhu ke stažení (P29D T1); prohlížeč bez nahrávání plátna klip nemá a tlačítko nevidí. */
function SaveClip({ clip }: { readonly clip: Blob }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(clip);
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  if (href === null) return null;
  const extension = clip.type.includes('mp4') ? 'mp4' : 'webm';
  return (
    <a className="play-button" data-testid="play-save-clip" href={href} download={`worldstream-clip.${extension}`}>
      Save clip
    </a>
  );
}

export function PostRun({ versionId, remix: job, clip = null, onReplay }: { readonly versionId: string; readonly remix: RemixJob; readonly clip?: Blob | null; readonly onReplay: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Replay obrazovku odpojí: rozběhnutý čip pak hráče uprostřed hry nepřesměruje (P28B T7).
  const leaving = useRef(new AbortController());
  useEffect(() => {
    const control = new AbortController();
    leaving.current = control;
    return () => control.abort();
  }, []);

  async function remix(chip: string): Promise<void> {
    setBusy(chip);
    setFailure(null);
    const { signal } = leaving.current;
    try {
      const response = await fetch(`/api/play/games/${versionId}/remix`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chip }),
        signal,
      });
      const body = (await response.json()) as { url?: string; error?: { message?: string } };
      if (signal.aborted) return;
      if (!response.ok || typeof body.url !== 'string') {
        setFailure(body.error?.message ?? 'This change could not become a game.');
        setBusy(null);
        return;
      }
      router.push(body.url);
    } catch {
      if (signal.aborted) return;
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
      <RemixBox job={job} />

      {clip !== null && <SaveClip clip={clip} />}
      <ShareButton versionId={versionId} label={CHALLENGE_A_FRIEND} />
    </section>
  );
}
