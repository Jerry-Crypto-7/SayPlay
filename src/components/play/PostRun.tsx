'use client';

/**
 * Po dohrání (P23-C T6, přestavba P33 T4): jedna hlavní akce `Play again`
 * a pod ní dvě vedlejší cesty – `Change it` (list s polem a čipy jako
 * návrhy) a `Challenge a friend`.
 *
 * Play again přetočí běh na tik 0 a nechá ho znovu doběhnout hodinami shellu –
 * vstupy hráče v runtime zůstávají, takže se přehraje týž běh do téhož konce
 * a nic nového se nezapíše. Čip pošle `POST …/remix` a přejde na odkaz dítěte;
 * rodič se nemění. Sdílení je `ShareButton` (P27B T5), týž jako v HUD.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { RemixBox, type RemixJob } from './RemixBox';
import { type LivePublish, ShareButton } from './ShareButton';
import { CHALLENGE_A_FRIEND, CHANGE_ONE_THING, POST_RUN_CHIPS } from './starters';
import { Button, Chip, Icon, Sheet } from './ui';

/** Texty v `starters.ts` (stopa B) jsou verzálkami; karta mluví větou. */
const sentence = (text: string): string => text.charAt(0) + text.slice(1).toLowerCase();

/** Klip běhu ke stažení (P29D T1); prohlížeč bez nahrávání plátna klip nemá a odkaz nevidí. */
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
    <a className="play-postrun-clip" data-testid="play-save-clip" href={href} download={`worldstream-clip.${extension}`}>
      Save clip
    </a>
  );
}

export function PostRun({
  versionId,
  remix: job,
  clip = null,
  live,
  onReplay,
}: {
  readonly versionId: string;
  readonly remix: RemixJob;
  readonly clip?: Blob | null;
  /** Verze se živými změnami běhu (P29D T10) – sdílí se místo hrané. */
  readonly live?: LivePublish;
  readonly onReplay: () => void;
}) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
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

  const suggestions = (
    <>
      <div className="play-chips" role="group" aria-label="Suggestions">
        {POST_RUN_CHIPS.map((entry) => (
          <Chip key={entry.chip} data-testid={`play-chip-${entry.chip}`} disabled={busy !== null} aria-busy={busy === entry.chip} onClick={() => void remix(entry.chip)}>
            {entry.label}
          </Chip>
        ))}
      </div>
      {failure !== null && (
        <p className="play-alert" role="alert">
          {failure}
        </p>
      )}
    </>
  );

  return (
    <section className="play-postrun" data-testid="play-postrun" aria-label="After the run">
      <Button size="l" className="play-postrun-main" data-testid="play-replay" onClick={onReplay}>
        Play again
      </Button>
      <div className="play-postrun-more">
        <Button variant="quiet" aria-haspopup="dialog" onClick={() => setChanging(true)}>
          <Icon name="edit" />
          Change it
        </Button>
        <ShareButton versionId={versionId} variant="quiet" label={sentence(CHALLENGE_A_FRIEND)} clip={clip} live={live} />
      </div>
      {clip !== null && <SaveClip clip={clip} />}

      <Sheet open={changing} title={sentence(CHANGE_ONE_THING)} onClose={() => setChanging(false)}>
        <RemixBox job={job} suggestions={suggestions} />
      </Sheet>
    </section>
  );
}
