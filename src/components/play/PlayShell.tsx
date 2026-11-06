'use client';

/**
 * PLAY shell (P23-C T5): rozcestník mezi arkádovou a mřížkovou hrou.
 *
 * Mřížková hra (`GridShell`) se načítá přes `next/dynamic` (P28E-R2): její
 * runtime, mesh klient a Zod schémata by jinak vyhodnocoval i start každé
 * arkádové hry, která je nepotřebuje. Server ji vykreslí dál, takže mřížka
 * nepřijde o nic.
 *
 * Žádný technický panel (Program, Timeline, Inspect…) se tu nerenderuje;
 * sonda `window.__playShell` je jediné okno dovnitř a slouží e2e.
 */

import dynamic from 'next/dynamic';

import type { ArcadeWorld } from '@/play/arcade/contract';
import type { ChainWorld } from '@/play/chain/contract';
import type { GameVersion } from '@/play/contracts';
import type { Honesty } from '@/play/draft/unsupported';
import type { Par } from '@/play/score/stars';
import type { GameSpecV1 } from '@/play/spec';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import { ArcadePlay } from './arcade/ArcadePlay';
import { ChainPlay } from './arcade/chain/ChainPlay';
import type { Dare } from './best';
import { WithPlayEnv } from './arcade/look/play-env';
import { DareStrip } from './DareStrip';
import { HonestyStrip } from './HonestyStrip';
import { BoardInfoPart } from './Leaderboard';
import type { CheckFacts, LabFacts, ReadFacts } from './lab';
import { InfoSheetProvider } from './ui/InfoContext';

const GridShell = dynamic(() => import('./GridShell'));

export interface PlayShellProps {
  readonly versionId: string;
  readonly spec: GameSpecV1;
  readonly blueprint: WorldstreamBlueprint;
  /** Od kořene k listu; poslední záznam je tahle hra. */
  readonly lineage: readonly GameVersion[];
  readonly remixes: number;
  /** Hra je AI verze návrhu (`relation: 'upgrade'`); rodokmen to řekne místo „Remixed from“. */
  readonly aiVersion?: boolean;
  /** Hra ze čtení věty (`relation: 'reading'`, P58D) – verze rychlé hry podle čtení, ne remix hráče. */
  readonly readingVersion?: boolean;
  readonly lab: LabFacts;
  readonly read: ReadFacts;
  /** Náhrada z věty (P25E): proužek nad hrou kreslí `PlayShell`, karta startu ji řekne pod čtením (P73B T2). */
  readonly honesty?: Honesty | null;
  /** Co ověřila publikační brána (`checkFacts`, P73B T3); `null` = bez řádku „Checked“. */
  readonly checks?: CheckFacts | null;
  /** Adresa `GET …/upgrade`, když je hra návrh z věty; `null` = není na co čekat. */
  readonly upgrade: string | null;
  /** Vítězný běh robota arkádové hry (`report.par`, P36B T1) – měřítko hvězd; mřížka ho nečte. */
  readonly par?: Par | null;
  /** Výzva kamaráda z odkazu `?dare=` (P36B T7), ověřená serverem; jen arkáda. */
  readonly challenge?: Dare | null;
  /** Id výzvy nejlepšího běhu z úložiště (P50 T6) pro prvního ducha; jen arkáda. */
  readonly bestDare?: string | null;
}

/**
 * Arkádová hra (P25A) jde do `ArcadePlay`, mřížková beze změny. Poctivá hláška
 * (P25E) leží nad oběma, proto ji kreslí rozcestník, ne shell; proužek výzvy
 * (P44B T8) taky – `ArcadePlay` se kvůli němu nemění.
 */
export function PlayShell({
  blueprint,
  arcade,
  chain,
  honesty = null,
  ...rest
}: Omit<PlayShellProps, 'blueprint'> & { readonly blueprint: WorldstreamBlueprint | null; readonly arcade?: ArcadeWorld; readonly chain?: ChainWorld }) {
  if (blueprint === null && arcade === undefined && chain === undefined) throw new Error('PlayShell: a grid game needs its blueprint');
  // Řetěz mikroher (P56C T11) nemá `arcade`; hraje ho `ChainPlay`.
  const game =
    chain !== undefined ? <ChainPlay versionId={rest.versionId} spec={rest.spec} chain={chain} par={rest.par ?? null} challenge={rest.challenge ?? null} bestDare={rest.bestDare} upgrade={rest.upgrade} sentence={rest.read?.sentence ?? null} />
    : arcade !== undefined ? <ArcadePlay {...rest} arcade={arcade} honesty={honesty} />
    : blueprint !== null && <GridShell {...rest} blueprint={blueprint} honesty={honesty} />;
  // Info o hře je jeden list (P33 T7): shell dá sourozencům `SentenceRead`, `HowItWorks` a `Lineage` společný kontext.
  const shell = (
    <WithPlayEnv theme={rest.spec.theme} versionId={rest.versionId}>
      <InfoSheetProvider>
        {/* Žebříček mají jen arkádové hry a řetězy – ověřený běh píše jen výzva (P44B T9, P56C T10). */}
        {(arcade !== undefined || chain !== undefined) && <BoardInfoPart versionId={rest.versionId} />}
        {game}
      </InfoSheetProvider>
    </WithPlayEnv>
  );
  const dare = arcade !== undefined && rest.challenge ? rest.challenge : null;
  if (honesty === null && dare === null) return shell;
  // Proužky hru odsunou, nepřekryjí: HUD s cílem hry musí zůstat vidět.
  return (
    <div className="play-honest-frame">
      {honesty !== null && <HonestyStrip honesty={honesty} />}
      {dare !== null && arcade !== undefined && <DareStrip challenge={dare} arcade={arcade} />}
      {shell}
    </div>
  );
}
