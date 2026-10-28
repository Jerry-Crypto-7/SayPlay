import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { FUNNEL_STAGES, type FunnelDay, type FunnelStage, RETENTION_AFTER, retention } from '@/play/funnel';
import { RECENT_CAP, versionStoreFromEnv } from '@/play/version';
import { statsAccess } from '@/server/stats-access';

export const dynamic = 'force-dynamic';
// `no-referrer`: klíč z adresy by jinak odešel v `Referer` s prvním kliknutím (nález revize T13-1).
export const metadata: Metadata = { title: 'sayplay – loop funnel', robots: { index: false, follow: false }, referrer: 'no-referrer' };

const LABEL: Record<FunnelStage, string> = { say: 'Say', play: 'Play', finish: 'Finish', share: 'Share', open: 'Open', beat: 'Beat', remix: 'Remix' };
const WINDOWS = [7, 14] as const;

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function totals(days: readonly FunnelDay[]): Record<FunnelStage, number> {
  return Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, days.reduce((sum, day) => sum + day.counts[stage], 0)])) as Record<FunnelStage, number>;
}

/** „Say → Play 62%“; bez předchozího stupně „–“. */
function conversion(from: FunnelStage, to: FunnelStage, sums: Record<FunnelStage, number>): string {
  const rate = sums[from] === 0 ? '–' : `${String(Math.round((100 * sums[to]) / sums[from]))}%`;
  return `${LABEL[from]} → ${LABEL[to]} ${rate}`;
}

/**
 * Interní `/play/stats` (P44B T13): trychtýř smyčky za 7 a 14 dní a nejsilnější hra pro majitele
 * a investora. Za bránou `statsAccess` – na veřejném nasazení bez správného `?key=` 404 dřív, než
 * se sáhne na úložiště. Žádné id hráče ani věta: čte jen denní čítače a čítače her.
 */
export default async function StatsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  if (!statsAccess(await searchParams, process.env)) notFound();
  const versions = versionStoreFromEnv(process.env);
  const days = await versions.funnel(Math.max(...WINDOWS));
  const recent = await versions.recent(RECENT_CAP);
  const heat = await versions.loopHeat(recent.map((game) => game.versionId));
  // Na hru se ukládají ověřené výzvy a remixy; „beat“ je jen denní čítač celé smyčky.
  // simplified: řadí jen hry ve feedu (`recent`), návrhy mimo feed úložiště vyjmenovat neumí; hra bez feedu chce vlastní seřazenou množinu.
  const strongest = recent
    .map((game) => ({ game, dares: heat.get(game.versionId)?.dares ?? 0, remixes: heat.get(game.versionId)?.remixes ?? 0 }))
    .filter((row) => row.dares + row.remixes > 0)
    .reduce<{ game: (typeof recent)[number]; dares: number; remixes: number } | null>((best, row) => (best === null || row.dares + row.remixes > best.dares + best.remixes ? row : best), null);

  return (
    <main className="play-stats">
      <h1 className="sp-title-l">Loop funnel</h1>
      <p className="sp-body-s sp-muted">Each step counts once per session and game per day (UTC), up to {days.at(-1)?.day}.</p>
      {WINDOWS.map((window) => {
        const sums = totals(days.slice(-window));
        return (
          <section key={window} className="play-stats-window">
            <h2 className="sp-title-m">Last {window} days</h2>
            <table className="play-stats-table">
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Count</th>
                  <th scope="col">From the step before</th>
                </tr>
              </thead>
              <tbody>
                {FUNNEL_STAGES.map((stage, at) => (
                  <tr key={stage}>
                    <th scope="row">{LABEL[stage]}</th>
                    <td>{sums[stage].toLocaleString('en-US')}</td>
                    <td>{at === 0 ? '' : conversion(FUNNEL_STAGES[at - 1]!, stage, sums)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      <section className="play-stats-window">
        <h2 className="sp-title-m">Returning players</h2>
        <p className="sp-body-s sp-muted">One browser counts once a day. D1 and D7: of the players new on a day, how many came back 1 or 7 days later.</p>
        <p className="sp-body">
          {RETENTION_AFTER.map((after) => {
            const rate = retention(days, after);
            return <span key={after}>{`D${String(after)} ${rate === null ? '–' : `${String(Math.round((100 * rate.hit) / rate.of))}% (${String(rate.hit)} of ${String(rate.of)})`}`}{after === 1 ? ' · ' : ''}</span>;
          })}
        </p>
        <table className="play-stats-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">New</th>
              <th scope="col">Returning</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{day.day}</th>
                <td>{day.visitors.first.toLocaleString('en-US')}</td>
                <td>{day.visitors.return.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="play-stats-window">
        <h2 className="sp-title-m">Strongest game in the feed</h2>
        {strongest === null ? (
          <p className="sp-body">No dares or remixes yet.</p>
        ) : (
          <p className="sp-body">
            <a href={`/play/${strongest.game.versionId}`}>{strongest.game.title}</a> · {count(strongest.dares, 'dare', 'dares')} · {count(strongest.remixes, 'remix', 'remixes')}
          </p>
        )}
      </section>
    </main>
  );
}
