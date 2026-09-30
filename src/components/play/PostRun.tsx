'use client';

/**
 * Obrazovka výsledku (P34 T6, kit `08-game-hud.md` Result screen, reference
 * `docs/brand/reference-screens/03-win@2x.png`; dřív karta po hře P23-C T6
 * a P33 T4).
 *
 * Horních 30 % je zamrzlý snímek hry: plátno po konci běhu kreslí jen na
 * požádání (arkáda `frameloop: 'demand'`), takže průhlednou horní částí je
 * vidět jeho poslední obraz – bez čtení pixelů a bez `preserveDrawingBuffer`.
 * Po výhře v něm naskočí slunečný odznak s časem a jedním slovem. Pod ním
 * list: nadpis, věta shrnutí, nejvýš tři statistiky ze skutečných čísel běhu
 * (čas vždy, zbytek jen to, co hra opravdu počítá) a akce.
 *
 * Právě jedna rajčatová akce: po výhře „Dare a friend to beat it“ (sdílení
 * P27B T5), po prohře „Try again“ a Dare jde mezi papírová M tlačítka.
 * „Remix it“ otevře list „Change one thing“ (čipy jako návrhy), odkazy jsou
 * „Copy link“ a „Save video“ (klip běhu P29D T1). „Post to story“ z kitu tu
 * není: produkt ho neumí.
 *
 * Play again / Try again přetočí běh na tik 0 a nechá ho znovu doběhnout
 * hodinami shellu – vstupy hráče v runtime zůstávají, takže se přehraje týž
 * běh do téhož konce a nic nového se nezapíše. Čip pošle `POST …/remix`
 * a přejde na odkaz dítěte; rodič se nemění.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { RemixBox, type RemixJob } from './RemixBox';
import { type LivePublish, ShareButton } from './ShareButton';
import { CHANGE_ONE_THING, DARE_A_FRIEND, DARE_SHORT, POST_RUN_CHIPS, SO_CLOSE, YOU_DID_IT } from './starters';
import { Button, Chip, Sheet } from './ui';
import { clockText } from './ui/GameHud';

/** Jedna statistika výsledku (kit `.sp-stat`): skutečné číslo běhu a jeho popisek. */
export interface ResultStat {
  readonly value: string;
  readonly label: string;
}

/** Co shell o skončeném běhu ví – jen čísla, která hra opravdu počítá. */
export interface RunFacts {
  readonly won: boolean;
  readonly tick: number;
  /** Tiky za sekundu shellu (arkáda `ARCADE_HZ`, mřížka `TICKS_PER_SECOND`). */
  readonly hz: number;
  /** Hra na přežití: výhra je vydržet, ne stihnout. */
  readonly survive: boolean;
  /** Cílové předměty (`3/5`); `label` je popisek statistiky („collected“, „gates“). */
  readonly goal: { readonly count: number; readonly need: number; readonly label: string } | null;
  /** Další skutečná čísla v pořadí důležitosti (zásahy, životy, body …). */
  readonly extra: readonly ResultStat[];
}

export interface RunResult {
  readonly headline: string;
  readonly time: string;
  /** Slovo odznaku; `null` = bez odznaku – prohra nic neslaví (kit: Win = badge pops in). */
  readonly badge: string | null;
  readonly summary: string;
  readonly stats: readonly ResultStat[];
}

/** Do kolika sekund je výhra „Speedy!“. */
const SPEEDY_SECONDS = 20;

/** Výsledek z fakt běhu: nadpis, odznak, věta a nejvýš tři statistiky (poslední je vždy čas). */
export function runResult(facts: RunFacts): RunResult {
  const seconds = facts.tick / facts.hz;
  const time = clockText(seconds);
  const { goal } = facts;
  const summary =
    goal !== null
      ? facts.won
        ? `All ${goal.need} ${goal.label} in ${time}.`
        : `${goal.count} of ${goal.need} ${goal.label} in ${time}.`
      : facts.won && !facts.survive
        ? `Done in ${time}.`
        : `You lasted ${time}.`;
  const lead: ResultStat[] = goal === null ? [] : [{ value: `${goal.count}/${goal.need}`, label: goal.label }];
  return {
    headline: facts.won ? YOU_DID_IT : SO_CLOSE,
    time,
    badge: !facts.won ? null : facts.survive ? 'Survived!' : seconds <= SPEEDY_SECONDS ? 'Speedy!' : 'Steady!',
    summary,
    stats: [...[...lead, ...facts.extra].slice(0, 2), { value: time, label: 'time' }],
  };
}

/** Klip běhu ke stažení (P29D T1); prohlížeč bez nahrávání plátna klip nemá a odkaz nevidí. */
function SaveVideo({ clip }: { readonly clip: Blob }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(clip);
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);
  if (href === null) return null;
  const extension = clip.type.includes('mp4') ? 'mp4' : 'webm';
  return (
    <a className="sp-btn sp-btn--link sp-btn--s" data-testid="play-save-clip" data-variant="link" href={href} download={`worldstream-clip.${extension}`}>
      Save video
    </a>
  );
}

export function PostRun({
  versionId,
  remix: job,
  facts,
  clip = null,
  live,
  offline = false,
  onReplay,
}: {
  readonly versionId: string;
  readonly remix: RemixJob;
  readonly facts: RunFacts;
  readonly clip?: Blob | null;
  /** Verze se živými změnami běhu (P29D T10) – sdílí se místo hrané. */
  readonly live?: LivePublish;
  /** Ukázková hra domova (P28D T7) není v úložišti: jen znovu hrát, bez sdílení a remixu. */
  readonly offline?: boolean;
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

  const result = runResult(facts);
  const { won } = facts;
  // Hlavní akce: po výhře Dare, po prohře (a v ukázce domova) znovu hrát.
  const replayMain = offline || !won;
  const replay = (
    <Button variant={replayMain ? 'primary' : 'secondary'} size={replayMain ? 'l' : 'm'} className={replayMain ? 'sp-btn--block' : undefined} data-testid="play-replay" onClick={onReplay}>
      {won ? 'Play again' : 'Try again'}
    </Button>
  );
  const dare = (
    <ShareButton
      versionId={versionId}
      variant={won ? 'primary' : 'secondary'}
      size={won ? 'l' : 'm'}
      className={won ? 'sp-btn--block' : ''}
      label={won ? DARE_A_FRIEND : DARE_SHORT}
      clip={clip}
      live={live}
    />
  );

  return (
    <section className="play-result" data-testid="play-outcome" data-outcome={won ? 'won' : 'lost'} role="status" aria-label="Result">
      <div className="play-result-top">
        {result.badge !== null && (
          <p className="sp-badge play-result-badge" data-testid="play-badge">
            <span className="play-badge-time">{result.time}</span>
            <span className="play-badge-word">{result.badge}</span>
          </p>
        )}
      </div>
      <div className="play-result-sheet" data-testid="play-postrun">
        <h2 className="sp-display-m play-result-title">{result.headline}</h2>
        {/* `data-tick` čte e2e: týž konec po Play again pozná na tiku, ne na zaokrouhlených sekundách. */}
        <p className="play-result-summary play-outcome-detail" data-tick={facts.tick}>
          {result.summary}
        </p>
        <ul className="play-result-stats" aria-label="Your run">
          {result.stats.map((stat) => (
            <li key={stat.label} className="sp-stat">
              <span className="sp-stat__value">{stat.value}</span>
              <span className="sp-stat__label">{stat.label}</span>
            </li>
          ))}
        </ul>
        <div className="play-result-actions">
          {offline ? (
            replay
          ) : (
            <>
              {won ? dare : replay}
              <div className="play-result-more">
                {won ? replay : dare}
                <Button variant="secondary" aria-haspopup="dialog" onClick={() => setChanging(true)}>
                  Remix it
                </Button>
              </div>
              <div className="play-result-links">
                <ShareButton versionId={versionId} variant="link" size="s" copy label="Copy link" live={live} />
                {clip !== null && <SaveVideo clip={clip} />}
              </div>
            </>
          )}
        </div>
      </div>

      <Sheet open={changing} title={CHANGE_ONE_THING} onClose={() => setChanging(false)}>
        <RemixBox job={job} suggestions={suggestions} />
      </Sheet>
    </section>
  );
}
