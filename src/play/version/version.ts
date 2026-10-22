/**
 * Zapečetění verze (P23-C T2).
 *
 * `GameVersion` je hash všeho, na čem hra stojí – spec, svět, seed, verze
 * kompilátoru i runtimu a rodič. Titulek a čas do hashe nejdou: dvě publikace
 * téže hry v jiné minutě jsou táž verze, a jméno se smí opravit bez nové hry.
 */

import { createHash } from 'node:crypto';

import { canonical, canonicalHash } from '@/ir/worlddoc';
import { RUNTIME_VERSION } from '@/sim/interpreter';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import type { ArcadeWorld } from '../arcade/contract';
import { CHAIN_RUNTIME_VERSION, type ChainWorld } from '../chain/contract';

import { GAME_COMPILER_VERSION, gameVersionId, type CompiledGame, type GameVersion, type QualityReport } from '../contracts';
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
  /**
   * Řetěz mikroher (P56C T10). Hra s řetězem nemá `arcade` (zapomenutá cesta jedné hry selže viditelně, ne tiše
   * na kole 1), `spec` je spec kola 1, `report.par` par celého řetězu a `preview` náhled kola 1. Starší hry pole nemají.
   */
  readonly chain?: ChainWorld;
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
  /**
   * `'upgrade'` = autorská verze návrhu `version.parentId`, ne remix. `'remix'` = dítě,
   * které postavil server – čip, ověřený recept nebo věta přes model (P54A T10, nález
   * revize T10-1); remix z hotového specu nebo `parentId` v `POST /api/play/games` ho nemá.
   */
  readonly relation?: 'upgrade' | 'remix';
  readonly timings?: PlayTimings;
  /** Okno robotova běhu pro náhled ve feedu (P54A T2); hra publikovaná dřív ho nemá. */
  readonly preview?: FeedPreview;
}

/**
 * Náhled robota na kartě feedu (P54A T2): klient tiše dopočte stav do
 * `startTick` a dokola přehrává `startTick..endTick`. `inputs` jsou robotovy
 * vstupy před `endTick` v run-length řetězci (`encodeInputs` v `preview.ts`) –
 * držená osa je jeden záznam. `hash` = `hashArcade` stavu v `endTick`.
 */
export interface FeedPreview {
  readonly startTick: number;
  readonly endTick: number;
  readonly inputs: string;
  readonly hash: string;
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

/**
 * Verze řetězu (P56C T10, debata T9): `worldHash` = SHA-256 celého řetězu, takže dva řetězy se stejným kolem 1
 * dostanou různé id. Titulek a spec z kola 1.
 */
export function sealChainVersion(chain: ChainWorld, parentId: string | null, now: () => number): GameVersion {
  const spec = chain.rounds[0]!.spec;
  const fields: Omit<GameVersion, 'versionId' | 'createdAt' | 'title'> = {
    specHash: canonicalHash(spec),
    worldHash: createHash('sha256').update(canonical(chain)).digest('hex'),
    seed: chain.seed,
    schemaVersion: 'gamespec.v1',
    compilerVersion: `${GAME_COMPILER_VERSION}/${CHAIN_RUNTIME_VERSION}`,
    runtimeVersion: CHAIN_RUNTIME_VERSION,
    parentId,
  };
  return { versionId: gameVersionId(fields, spec), title: spec.title, ...fields, createdAt: new Date(now()).toISOString() };
}
