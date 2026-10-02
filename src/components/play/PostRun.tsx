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
 * Po výhře arkády (P36B T2) list nese i 1–3 hvězdy proti paru, které
 * naskočí jedna po druhé, velké skóre (jen hra, která boduje) a řádek
 * rekordu: „New best!“ jen při překonaném rekordu, jinak rekord k překonání,
 * po prohře hry na přežití „N s off your best“. Odznak Speedy/Steady/Survived
 * zůstává podle kitu (čas + jedno slovo), hvězdy ho nenahrazují.
 *
 * Play again / Try again volá `onReplay`: obě hry začnou nový běh od tiku 0
 * s prázdným záznamem – arkáda `session.restart()`, mřížka (`GridShell`) novou
 * relací runtime (P36B T3; dřív přetočila na tik 0 týž prohraný záznam).
 * Klávesy R, mezerník a Enter (`retryKey`) dělají totéž a nový běh rovnou
 * pustí – ruka už je na klávesách. Čip pošle `POST …/remix`
 * a přejde na odkaz dítěte; rodič se nemění.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { Stars as StarCount } from '@/play/score/stars';

import { isTyping } from './arcade/input';
import type { BestOutcome } from './best';
import { RemixBox, type RemixJob } from './RemixBox';
import { type LivePublish, ShareButton } from './ShareButton';
import { CHANGE_ONE_THING, COPY_LINK, DARE_A_FRIEND, DARE_SHORT, NEW_BEST, POST_RUN_CHIPS, REMIX_IT, SAVE_VIDEO, SO_CLOSE, YOU_DID_IT } from './starters';
import { Button, Chip, Sheet } from './ui';
import { clockText } from './ui/GameHud';
import { onControl } from './ui/PauseCard';

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
  /** Další skutečná čísla v pořadí důležitosti (zásahy, životy …). */
  readonly extra: readonly ResultStat[];
  /** Body běhu a jejich jednotka (P36B T2); chybí = hra neboduje. */
  readonly score?: { readonly value: number; readonly unit: string } | null;
  /** Hvězdy proti paru (P36B T1); chybí = hra hvězdy nemá (mřížka). */
  readonly stars?: StarCount | null;
}

export interface RunResult {
  readonly headline: string;
  readonly time: string;
  /** Slovo odznaku; `null` = bez odznaku – prohra nic neslaví (kit: Win = badge pops in). */
  readonly badge: string | null;
  readonly summary: string;
  readonly stats: readonly ResultStat[];
  /** Hvězdy jen po výhře hry, která je má. */
  readonly stars: StarCount | null;
  /** Skóre s oddělovačem tisíců („2,450“) a jednotkou; `null` = hra neboduje. */
  readonly score: { readonly value: string; readonly unit: string } | null;
  /** Řádek rekordu; `null` = není co říct (žádný rekord, první výhra). */
  readonly best: { readonly text: string; readonly isNew: boolean } | null;
}

/** Do kolika sekund je výhra „Speedy!“. */
const SPEEDY_SECONDS = 20;

/** Jak nový pokus přišel: klávesa ho rovnou pustí, klepnutí na tlačítko nechá hru čekat na první dotek. */
export type ReplayVia = 'key' | 'button';

/**
 * Klávesa nového pokusu na výsledku (P36B T3): R, mezerník, Enter. Ne při
 * psaní, se zkratkou prohlížeče ani v otevřeném listu; mezerník a Enter na
 * tlačítku nebo odkazu mačkají to tlačítko (Dare, Remix it), ne nový pokus.
 */
export function retryKey(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return false;
  if (event.target instanceof HTMLElement && event.target.closest('[role="dialog"]') !== null) return false;
  if (event.key === 'r' || event.key === 'R') return true;
  return (event.key === ' ' || event.key === 'Enter') && !onControl(event.target);
}

export const scoreText = (value: number): string => value.toLocaleString('en-US');

/**
 * Řádek rekordu: překonaný rekord = „New best!“; jinak rekord k překonání
 * („Your best: 2,450 · 31.0s“); prohra hry na přežití řekne, kolik chybělo.
 */
function bestLine(facts: RunFacts, record: BestOutcome | null): RunResult['best'] {
  if (record === null) return null;
  if (facts.won && record.isNew) return { text: NEW_BEST, isNew: true };
  const { previous } = record;
  if (previous === null) return null;
  if (!facts.won && facts.survive) {
    const short = Math.max(1, Math.round((previous.ticks - facts.tick) / facts.hz));
    return { text: `${short} s off your best`, isNew: false };
  }
  const time = clockText(previous.ticks / facts.hz);
  const scored = facts.score !== undefined && facts.score !== null;
  return { text: `Your best: ${scored ? `${scoreText(previous.score)} · ${time}` : time}`, isNew: false };
}

/** Výsledek z fakt běhu: nadpis, odznak, věta, hvězdy, skóre, rekord a nejvýš tři statistiky (poslední je vždy čas). */
export function runResult(facts: RunFacts, record: BestOutcome | null = null): RunResult {
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
    stars: facts.won ? (facts.stars ?? null) : null,
    score: facts.score === undefined || facts.score === null ? null : { value: scoreText(facts.score.value), unit: facts.score.unit },
    best: bestLine(facts, record),
  };
}

/** Pěticípá hvězda na mřížce 24 × 24 (kit `10-icons.md`); výplň a obrys dává CSS jako vejcím HUD. */
const STAR_POINTS = '12,2.6 14.8,8.7 21.4,9.4 16.4,13.9 17.8,20.4 12,17.1 6.2,20.4 7.6,13.9 2.6,9.4 9.2,8.7';

/** Tři hvězdy, získané slunečné, ostatní čárkovaný obrys; naskočí jedna po druhé (CSS). */
function StarRow({ count }: { readonly count: StarCount }) {
  return (
    <p className="play-result-stars" data-testid="play-stars" data-stars={count} role="img" aria-label={`${count} of 3 stars`}>
      {[0, 1, 2].map((index) => (
        <svg key={index} className={index < count ? 'play-star is-earned' : 'play-star'} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <polygon points={STAR_POINTS} />
        </svg>
      ))}
    </p>
  );
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
    <a className="sp-btn sp-btn--link sp-btn--s" data-testid="play-save-clip" data-variant="link" href={href} download={`sayplay-clip.${extension}`}>
      {SAVE_VIDEO}
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
  record = null,
  onReplay,
}: {
  readonly versionId: string;
  readonly remix: RemixJob;
  readonly facts: RunFacts;
  /** Rekord z prohlížeče, vyřízený při konci běhu (`settleBest`); `null` = bez řádku rekordu. */
  readonly record?: BestOutcome | null;
  readonly clip?: Blob | null;
  /** Verze se živými změnami běhu (P29D T10) – sdílí se místo hrané. */
  readonly live?: LivePublish;
  /** Ukázková hra domova (P28D T7) není v úložišti: jen znovu hrát, bez sdílení a remixu. */
  readonly offline?: boolean;
  readonly onReplay: (via: ReplayVia) => void;
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
  // Klávesy nového pokusu (P36B T3); list „Remix it“ je jim zavřený – píše se v něm věta.
  useEffect(() => {
    if (changing) return;
    const onKey = (event: KeyboardEvent): void => {
      if (!retryKey(event)) return;
      event.preventDefault();
      onReplay('key');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changing, onReplay]);

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

  const result = runResult(facts, record);
  const { won } = facts;
  // Hlavní akce: po výhře Dare, po prohře (a v ukázce domova) znovu hrát.
  const replayMain = offline || !won;
  const replay = (
    <Button variant={replayMain ? 'primary' : 'secondary'} size={replayMain ? 'l' : 'm'} className={replayMain ? 'sp-btn--block' : undefined} data-testid="play-replay" onClick={() => onReplay('button')}>
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
        {result.stars !== null && <StarRow count={result.stars} />}
        {result.score !== null && (
          <p className="play-result-score" data-testid="play-score">
            <span className="sp-display-l play-result-score-value">{result.score.value}</span>
            <span className="play-result-score-unit">{result.score.unit}</span>
          </p>
        )}
        {/* `data-tick` čte e2e: týž konec po Play again pozná na tiku, ne na zaokrouhlených sekundách. */}
        <p className="play-result-summary play-outcome-detail" data-tick={facts.tick}>
          {result.summary}
        </p>
        {result.best !== null && (
          <p className="play-result-best" data-testid="play-best" data-new={String(result.best.isNew)}>
            {result.best.text}
          </p>
        )}
        {/* Samotný čas řádek statistik nenese: říká ho už věta shrnutí (a po výhře odznak) – na desktopu 720 px by vytlačil akce pod okraj. */}
        {result.stats.length > 1 && (
          <ul className="play-result-stats" aria-label="Your run">
            {result.stats.map((stat) => (
              <li key={stat.label} className="sp-stat">
                <span className="sp-stat__value">{stat.value}</span>
                <span className="sp-stat__label">{stat.label}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="play-result-actions">
          {offline ? (
            replay
          ) : (
            <>
              {won ? dare : replay}
              <div className="play-result-more">
                {won ? replay : dare}
                <Button variant="secondary" aria-haspopup="dialog" onClick={() => setChanging(true)}>
                  {REMIX_IT}
                </Button>
              </div>
              <div className="play-result-links">
                <ShareButton versionId={versionId} variant="link" size="s" copy label={COPY_LINK} live={live} />
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
