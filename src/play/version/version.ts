/**
 * Zapečetění verze (P23-C T2).
 *
 * `GameVersion` je hash všeho, na čem hra stojí – spec, svět, seed, verze
 * kompilátoru i runtimu a rodič. Titulek a čas do hashe nejdou: dvě publikace
 * téže hry v jiné minutě jsou táž verze, a jméno se smí opravit bez nové hry.
 */

import { RUNTIME_VERSION } from '@/sim/interpreter';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import type { ArcadeWorld } from '../arcade/contract';

import { gameVersionId, type CompiledGame, type GameVersion, type QualityReport } from '../contracts';
import type { GameSpecV1 } from '../spec';

/**
 * Vodopád progresivní hry (P23-D T2), milisekundy. `ackMs` a `draftReadyMs`
 * měří `POST /api/play/games` od příchodu požadavku; `null`, když upgrade
 * spustil až dotaz na `…/upgrade` (restart, serverless) a POST je neznámý.
 */
export interface PlayTimings {
  readonly ackMs: number | null;
  readonly draftReadyMs: number | null;
  readonly directorMs: number;
  readonly compileMs: number;
  readonly verifyMs: number;
  readonly source: 'draft' | 'cached' | 'authored';
}

/** Co se publikuje pohromadě: verze, spec, svět a důkaz, že to hrálo. */
export interface PublishedGame {
  readonly version: GameVersion;
  readonly spec: GameSpecV1;
  /** `null` u arkádové hry – ta se hraje z `arcade`. */
  readonly blueprint: WorldstreamBlueprint | null;
  readonly arcade?: ArcadeWorld;
  readonly report: QualityReport;
  /**
   * Návrh z věty si nese větu a semínko volajícího (`null` = odvozené), aby
   * upgrade šel spustit i bez paměti procesu, která POST viděla (P23-D T2).
   */
  readonly origin?: {
    readonly sentence: string;
    readonly seed: number | null;
    /** Návrh postavený ze čtení lokálním modelem (P29B T6); chybí = z klíčových slov. */
    readonly readBy?: 'model';
  };
  /**
   * Věta u hry, kterou publikoval rovnou režisér, protože návrh ze slov nešel
   * hrát (P25E R1). Jen pro poctivou hlášku – na rozdíl od `origin` upgrade nespouští.
   */
  readonly sentence?: string;
  /** `'upgrade'` = autorská verze návrhu `version.parentId`, ne remix. */
  readonly relation?: 'upgrade';
  readonly timings?: PlayTimings;
}

export function sealVersion(compiled: CompiledGame, parentId: string | null, now: () => number): GameVersion {
  const fields: Omit<GameVersion, 'versionId' | 'createdAt' | 'title'> = {
    specHash: compiled.specHash,
    worldHash: compiled.worldHash,
    seed: compiled.seed,
    schemaVersion: 'gamespec.v1',
    compilerVersion: compiled.compilerVersion,
    runtimeVersion: RUNTIME_VERSION,
    parentId,
  };
  return {
    versionId: gameVersionId(fields, compiled.spec),
    title: compiled.spec.title,
    ...fields,
    createdAt: new Date(now()).toISOString(),
  };
}
