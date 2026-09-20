/**
 * Zapečetění verze (P23-C T2).
 *
 * `GameVersion` je hash všeho, na čem hra stojí – spec, svět, seed, verze
 * kompilátoru i runtimu a rodič. Titulek a čas do hashe nejdou: dvě publikace
 * téže hry v jiné minutě jsou táž verze, a jméno se smí opravit bez nové hry.
 */

import { RUNTIME_VERSION } from '@/sim/interpreter';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import { gameVersionId, type CompiledGame, type GameVersion, type QualityReport } from '../contracts';
import type { GameSpecV1 } from '../spec';

/** Co se publikuje pohromadě: verze, spec, svět a důkaz, že to hrálo. */
export interface PublishedGame {
  readonly version: GameVersion;
  readonly spec: GameSpecV1;
  readonly blueprint: WorldstreamBlueprint;
  readonly report: QualityReport;
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
    versionId: gameVersionId(fields),
    title: compiled.spec.title,
    ...fields,
    createdAt: new Date(now()).toISOString(),
  };
}
