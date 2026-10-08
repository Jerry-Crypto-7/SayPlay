'use client';

/**
 * Žebříček hry (P44B T9): po výhře v `PostRun` a v listu „About this game“. Nejlepší ověřené
 * běhy hráčů, vlastní řádek zvýrazněný. Prázdný žebříček zve k první výhře; když čtení selže,
 * komponenta chybí – hláška o chybě by hráči nic nedala.
 */

import { useEffect, useMemo, useState } from 'react';

import { ARCADE_HZ } from '@/play/arcade/contract';

import { type BoardRow, type DareResult, fetchBoard } from './board-client';
import { clockText } from './ui/GameHud';
import { useInfoPart } from './ui/InfoContext';

/** V listu celý žebříček, který routa vydá (nejvýš 10); po výhře jen prvních pět. */
const BOARD_IN_INFO = 10;

/** Body, běh bez bodů svým časem – jako cíl výzvy (`dareGoal`). */
const runValue = (row: BoardRow): string => (row.score > 0 ? row.score.toLocaleString('en-US') : clockText(row.ticks / ARCADE_HZ));

export function BoardList({ rows, limit, standing }: { readonly rows: readonly BoardRow[]; readonly limit: number; readonly standing: DareResult['board'] }) {
  return (
    <section className="play-board" data-testid="play-board" aria-label="Leaderboard">
      <h3 className="play-info-heading">Leaderboard</h3>
      {standing !== null && (
        <p className="play-board-standing" data-testid="play-board-standing">
          You&apos;re #{standing.place} of {standing.of}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="play-board-empty">No scores yet. Win it and be first.</p>
      ) : (
        <ol className="play-board-rows">
          {rows.slice(0, limit).map((row) => (
            <li key={row.dareId} className={row.you ? 'play-board-row play-board-row--you' : 'play-board-row'} data-testid="play-board-row" data-you={String(row.you)}>
              <span className="play-board-place">#{row.place}</span>
              <span className="play-board-name">{row.nickname}</span>
              {row.you && <span className="play-board-you">you</span>}
              <span className="play-board-value">{runValue(row)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Žebříček do listu „About this game“ (část `board`); bez listu nic nekreslí ani nečte. */
export function BoardInfoPart({ versionId }: { readonly versionId: string }) {
  const part = useMemo(() => <Leaderboard versionId={versionId} limit={BOARD_IN_INFO} />, [versionId]);
  useInfoPart('board', part);
  return null;
}

/** Načte žebříček hry při připojení; `standing` = místo z ověřeného běhu (`DareResult.board`). */
export function Leaderboard({ versionId, limit, standing = null }: { readonly versionId: string; readonly limit: number; readonly standing?: DareResult['board'] }) {
  const [rows, setRows] = useState<readonly BoardRow[] | null>(null);
  useEffect(() => {
    const control = new AbortController();
    void fetchBoard(versionId, fetch, control.signal).then((read) => {
      if (!control.signal.aborted) setRows(read);
    });
    return () => control.abort();
  }, [versionId]);
  return rows === null ? null : <BoardList rows={rows} limit={limit} standing={standing} />;
}
