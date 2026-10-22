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
 * P27B T5; od P36B T6 odkaz nese výzvu se skóre, které server ověřil), po
 * prohře „Try again“ a Dare jde mezi papírová M tlačítka.
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
 * Hra s aspoň deseti pokusy ukáže i „N% beat this“ (P37C T5) – číslo si
 * výsledek stáhne sám z detailu hry, shell ho nepředává.
 *
 * Play again / Try again volá `onReplay`: obě hry začnou nový běh od tiku 0
 * s prázdným záznamem – arkáda `session.restart()`, mřížka (`GridShell`) novou
 * relací runtime (P36B T3; dřív přetočila na tik 0 týž prohraný záznam).
 * Klávesy R, mezerník a Enter (`retryKey`) dělají totéž a nový běh rovnou
 * pustí – ruka už je na klávesách. Čip pošle `POST …/remix`
 * a přejde na odkaz dítěte; rodič se nemění.
 */

import { useRouter } from 'next/navigation';
import { useContext, useEffect, useRef, useState } from 'react';

import type { ShareRun } from '@/play/score/share-text';
import type { Stars as StarCount } from '@/play/score/stars';

import { isTyping } from './arcade/input';
import { type BestOutcome, type Dare, dareVerdict } from './best';
import { dareResult } from './board-client';
import { beatText } from './Feed';
import { FeedNext } from './feed/feed-next';
import { Leaderboard } from './Leaderboard';
import { PlayingAs } from './NicknameSheet';
import { RemixBox, type RemixJob } from './RemixBox';
import { type DarePublish, type LivePublish, ShareButton } from './ShareButton';
import { CHANGE_ONE_THING, COPY_LINK, DARE_A_FRIEND, DARE_BACK, DARE_SHORT, NEW_BEST, POST_RUN_CHIPS, REMIX_IT, SAVE_VIDEO, SO_CLOSE, TRY_AGAIN, YOU_BEAT_IT, YOU_DID_IT } from './starters';
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
  /** Výsledek proti výzvě kamaráda (P36B T7); `null` = hraje se bez výzvy. */
  readonly dare: { readonly text: string; readonly beat: boolean } | null;
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

/**
 * Výsledek z fakt běhu: nadpis, odznak, věta, hvězdy, skóre, rekord a nejvýš
 * tři statistiky (poslední je vždy čas). S výzvou kamaráda (P36B T7) nadpis
 * soudí výzvu – „You beat it!“ / „So close.“ – a řádek rekordu nahradí rozdíl
 * proti kamarádovi; rekord se zapisuje dál, jen se tu neříká.
 */
export function runResult(facts: RunFacts, record: BestOutcome | null = null, challenge: Dare | null = null): RunResult {
  const seconds = facts.tick / facts.hz;
  const dare = challenge === null ? null : dareVerdict({ won: facts.won, score: facts.score?.value ?? 0, ticks: facts.tick }, challenge, facts.hz, facts.survive);
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
  // Prohra bez bodu (body, jinak cílové předměty) není „So close.“ (P56A T9); přežití bez bodů nulu nemá.
  const nothing = !facts.won && (facts.score != null ? facts.score.value === 0 : goal !== null && goal.count === 0);
  return {
    headline: dare !== null ? (dare.beat ? YOU_BEAT_IT : SO_CLOSE) : facts.won ? YOU_DID_IT : nothing ? TRY_AGAIN : SO_CLOSE,
    time,
    badge: !facts.won ? null : facts.survive ? 'Survived!' : seconds <= SPEEDY_SECONDS ? 'Speedy!' : 'Steady!',
    summary,
    stats: [...[...lead, ...facts.extra].slice(0, 2), { value: time, label: 'time' }],
    stars: facts.won ? (facts.stars ?? null) : null,
    score: facts.score === undefined || facts.score === null ? null : { value: scoreText(facts.score.value), unit: facts.score.unit },
    best: dare === null ? bestLine(facts, record) : null,
    dare,
  };
}

/** „N% beat this“ podle verze (P37C T5): detail hry se stáhne jednou za načtení stránky, ne po každém běhu. */
const beats = new Map<string, Promise<number | null>>();

/**
 * „Clear rate“ hry z `GET /api/play/games/:id`; chyba, neznámá hra i málo pokusů = `null`.
 * Odpověď hry (i 404) se pamatuje, přechodná chyba (429, 5xx, síť) ne – další výsledek se zeptá znovu.
 */
export function beatFor(versionId: string, fetcher: typeof fetch = fetch): Promise<number | null> {
  let pending = beats.get(versionId);
  if (pending === undefined) {
    pending = fetcher(`/api/play/games/${encodeURIComponent(versionId)}`).then(
      async (response) => {
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) beats.delete(versionId);
          return null;
        }
        const { beat } = (await response.json()) as { beat?: unknown };
        return typeof beat === 'number' && Number.isInteger(beat) && beat >= 0 && beat <= 100 ? beat : null;
      },
      () => {
        beats.delete(versionId);
        return null;
      },
    );
    beats.set(versionId, pending);
  }
  return pending;
}

/** Popisek statistiky zbylých životů, jak ji skládá arkáda (`arcadeFacts`). */
const LIVES_LEFT = 'lives left';

/** Fakta běhu → výsledek ke sdílení (P37C T4); hvězdy jen po výhře, jako na obrazovce. */
export function shareRunOf(facts: RunFacts): ShareRun {
  const lives = facts.extra.find((stat) => stat.label === LIVES_LEFT);
  return {
    won: facts.won,
    survive: facts.survive,
    seconds: facts.tick / facts.hz,
    stars: facts.won ? (facts.stars ?? null) : null,
    score: facts.score?.value ?? null,
    lives: lives === undefined ? null : Number(lives.value),
    goal: facts.goal,
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
  dare,
  challenge = null,
  offline = false,
  remixable = true,
  record = null,
  onReplay,
}: {
  /** Řetěz mikroher (P56C T12) remix nemá – server ho odmítne (422), tlačítko by vedlo do chyby. */
  readonly remixable?: boolean;
  readonly versionId: string;
  readonly remix: RemixJob;
  readonly facts: RunFacts;
  /** Rekord z prohlížeče, vyřízený při konci běhu (`settleBest`); `null` = bez řádku rekordu. */
  readonly record?: BestOutcome | null;
  readonly clip?: Blob | null;
  /** Verze se živými změnami běhu (P29D T10) – sdílí se místo hrané. */
  readonly live?: LivePublish;
  /** Výzva vítězného běhu arkády (P36B T6) – nese ji jen hlavní akce „Dare a friend to beat it“. */
  readonly dare?: DarePublish;
  /** Výzva kamaráda, proti které se hrálo (P36B T7); výhra ji vrátí akcí „Dare back“. */
  readonly challenge?: Dare | null;
  /** Ukázková hra domova (P28D T7) není v úložišti: jen znovu hrát, bez sdílení a remixu. */
  readonly offline?: boolean;
  readonly onReplay: (via: ReplayVia) => void;
}) {
  const router = useRouter();
  const [beat, setBeat] = useState<number | null>(null);
  useEffect(() => {
    if (offline) return;
    let live = true;
    void beatFor(versionId).then((value) => {
      if (live) setBeat(value);
    });
    return () => {
      live = false;
    };
  }, [versionId, offline]);
  const [changing, setChanging] = useState(false);
  // Nové jméno (P44B T10) žebříček znovu připojí, a tím ho načte znovu.
  const [boardRound, setBoardRound] = useState(0);
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

  const result = runResult(facts, record, challenge);
  const { won } = facts;
  // Ve feedu (P54A T9) vede z výsledku „Next game“ na další kartu.
  const next = useContext(FeedNext);
  // Co server o tomhle běhu řekl po přehrání (P44B T9); `null`, dokud výzva není `ready`.
  const verified = won && dare?.state === 'ready' ? dareResult(dare.dareId) : null;
  // Žebříček až po ověření běhu: dřív by ukázal stav před tímhle zápisem.
  const showBoard = won && !offline && dare !== undefined && dare.state !== 'pending';
  // Hlavní akce: po výhře Dare, po prohře (a v ukázce domova) znovu hrát.
  const replayMain = offline || !won;
  const replay = (
    <Button variant={replayMain ? 'primary' : 'secondary'} size={replayMain ? 'l' : 'm'} className={replayMain ? 'sp-btn--block' : undefined} data-testid="play-replay" onClick={() => onReplay('button')}>
      {won ? 'Play again' : 'Try again'}
    </Button>
  );
  const dareAction = (
    <ShareButton
      versionId={versionId}
      variant={won ? 'primary' : 'secondary'}
      size={won ? 'l' : 'm'}
      className={won ? 'sp-btn--block' : ''}
      label={won ? (challenge === null ? DARE_A_FRIEND : DARE_BACK) : DARE_SHORT}
      clip={clip}
      live={live}
      dare={won ? dare : undefined}
      result={shareRunOf(facts)}
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
        {result.dare !== null && (
          <p className="play-result-best" data-testid="play-dare-result" data-beat={String(result.dare.beat)}>
            {result.dare.text}
          </p>
        )}
        {challenge !== null && verified?.beat === true && (
          <p className="play-result-best play-result-beat-friend" data-testid="play-beat-friend">
            You beat {challenge.by ?? 'your friend'}!
          </p>
        )}
        {beat !== null && (
          <p className="play-result-best play-result-beat" data-testid="play-beat">
            {beatText(beat)}
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
        {showBoard && (
          <>
            <Leaderboard key={boardRound} versionId={versionId} limit={5} standing={verified?.board ?? null} />
            <PlayingAs onSaved={() => setBoardRound((round) => round + 1)} />
          </>
        )}
        <div className="play-result-actions">
          {offline ? (
            replay
          ) : (
            <>
              {won ? dareAction : replay}
              <div className="play-result-more">
                {won ? replay : dareAction}
                {remixable && (
                  <Button variant="secondary" aria-haspopup="dialog" onClick={() => setChanging(true)}>
                    {REMIX_IT}
                  </Button>
                )}
                {next !== null && (
                  <Button variant="secondary" data-testid="play-next-game" onClick={next}>
                    Next game
                  </Button>
                )}
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
