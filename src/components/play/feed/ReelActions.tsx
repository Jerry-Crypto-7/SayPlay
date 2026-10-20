'use client';

/**
 * Akce karty feedu (P54A T10): sloupec na okraji aktivní karty – Remix, Dare,
 * Share a počet remixů. Je vidět jen v náhledu robota (`play.css`): při hraní
 * by překážel ovládání a výsledek nese tytéž akce v listu `PostRun`.
 *
 * - **Remix** otevře list s `RemixBox`. Práce běží bez přesměrování
 *   (`useRemixJob(…, false)`); hotový remix feed vloží hned za tuto kartu a
 *   přejde na něj (`onRemixed`).
 * - **Dare** před vlastním během = „Play to dare“: ťuk na scénu jako hráčův
 *   (stisk a puštění na místě – feed ho přehraje hře, `ReelFeed` T9), hra se
 *   převezme a po výhře nabídne výzvu `PostRun`.
 * - **Share** je kolo sdílení z HUD (`ShareButton variant="hud"`).
 * - **Report** (T11) se jednou zeptá v listu a pošle hlas
 *   `POST /api/play/games/:id/report`; přijatý hlas ohlásí feedu (`onReported`),
 *   který poděkuje a přejde na další kartu. Kit nemá ikonu „…“, list je menu.
 */

import { useEffect, useRef, useState } from 'react';

import { RemixBox, useRemixJob } from '../RemixBox';
import { ShareButton } from '../ShareButton';
import { CHANGE_ONE_THING } from '../starters';
import { Button, Icon, Sheet } from '../ui';

type ReportView = 'closed' | 'asking' | 'sending' | 'failed';

/** Id ukazatele simulovaného ťuku; skutečný ukazatel je v tu chvíli puštěný (klik přišel po `pointerup`). */
const DARE_POINTER = 1;

/** Ťuk na střed scény aktivní karty – cestou skutečného ťuku, aby hru převzal feed sám. */
function tapStage(from: Element): void {
  const frame = from.closest('.play-reel-frame');
  // Fokus z tlačítka na kartu jako po přechodu (T13): mezerník pak dostane hra, ne znovu „Play to dare“.
  frame?.querySelector<HTMLElement>('[data-active="true"]')?.focus({ preventScroll: true });
  const stage = frame?.querySelector('[data-testid="feed-current"] [data-testid="arcade-stage"]');
  if (stage === null || stage === undefined) return;
  const box = stage.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, pointerId: DARE_POINTER, pointerType: 'mouse', isPrimary: true };
  stage.dispatchEvent(new PointerEvent('pointerdown', at));
  stage.dispatchEvent(new PointerEvent('pointerup', at));
}

export function ReelActions({
  versionId,
  title,
  remixes,
  onRemixed,
  onReported,
}: {
  readonly versionId: string;
  readonly title: string;
  readonly remixes: number;
  /** Hotový remix této hry (id nové verze). */
  readonly onRemixed: (versionId: string) => void;
  /** Dveře hlas přijaly. */
  readonly onReported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ReportView>('closed');
  // Karta je klíčovaná hrou: hráč, který mezitím odjel jinam, už na další kartu posunout nechce.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const sendReport = async () => {
    setReport('sending');
    const ok = await fetch(`/api/play/games/${versionId}/report`, { method: 'POST' }).then(
      (response) => response.ok,
      () => false,
    );
    if (!alive.current) return;
    setReport(ok ? 'closed' : 'failed');
    if (ok) onReported();
  };
  const job = useRemixJob(versionId, false);
  const ready = job.view.kind === 'ready' ? job.view.versionId : null;
  // Feed posílá novou funkci při každém vykreslení; hotový remix se ohlásí jednou.
  const latest = useRef(onRemixed);
  useEffect(() => {
    latest.current = onRemixed;
  });
  useEffect(() => {
    if (ready === null) return;
    setOpen(false);
    latest.current(ready);
  }, [ready]);

  return (
    <div className="play-reel-actions" data-testid="feed-actions">
      <div className="play-reel-action">
        <button type="button" className="sp-hud-btn play-hud-round" data-testid="feed-remix" aria-label="Remix this game" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Icon name="wand" />
        </button>
        <span className="play-reel-action-caption">Remix</span>
        {remixes > 0 && (
          <span className="play-reel-action-count" data-testid="feed-remix-count">
            {remixes}
          </span>
        )}
      </div>
      <div className="play-reel-action">
        <button
          type="button"
          className="sp-hud-btn play-hud-round"
          data-testid="feed-dare"
          aria-label="Play to dare a friend"
          onClick={(event) => tapStage(event.currentTarget)}
        >
          <Icon name="trophy" />
        </button>
        <span className="play-reel-action-caption">Play to dare</span>
      </div>
      <div className="play-reel-action">
        <ShareButton versionId={versionId} title={title} variant="hud" />
        <span className="play-reel-action-caption">Share</span>
      </div>
      <div className="play-reel-action">
        <button type="button" className="sp-hud-btn play-hud-round" data-testid="feed-report" aria-label="Report this game" aria-haspopup="dialog" onClick={() => setReport('asking')}>
          <Icon name="flag" />
        </button>
        <span className="play-reel-action-caption">Report</span>
      </div>
      <Sheet open={open} title={CHANGE_ONE_THING} onClose={() => setOpen(false)}>
        <RemixBox job={job} />
      </Sheet>
      <Sheet open={report !== 'closed'} title="Report this game?" onClose={() => setReport('closed')}>
        <p>Reported games leave the feed while we check them.</p>
        {report === 'failed' && (
          <p className="sp-field-error" role="alert">
            The report didn&apos;t go through. Try again.
          </p>
        )}
        <Button size="l" className="sp-btn--block" data-testid="feed-report-send" disabled={report === 'sending'} aria-busy={report === 'sending'} onClick={() => void sendReport()}>
          Report
        </Button>
      </Sheet>
    </div>
  );
}
