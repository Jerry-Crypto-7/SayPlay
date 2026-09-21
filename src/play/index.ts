/**
 * Veřejné API vrstvy PLAY (P23-D T1): spec, registr, kompilátor, verifikátor,
 * návrh ze slov, režisér, remix a verze. Obálka (`src/app/api/play/**`) i
 * měřidla berou vrstvu odsud; podadresáře jsou implementace.
 */

export { gameSpecHash, readGameSpec, type GameSpecReason, type GameSpecResult, type GameSpecV1 } from './spec';
export { ARCHETYPES, MECHANICS, type ArchetypeId, type MechanicId } from './registry';
export type { CompiledGame, CompileGameReason, CompileGameResult, DirectorResult, DirectorSource, GameCompiler, GameVersion, QualityReport, RemixClass } from './contracts';
export { compileGame } from './compile';
export { verifyGame } from './verify';
export { draftGameSpec } from './draft';
export { direct, type DirectedGame, type DirectorDeps, type FallbackReason } from './director';
export { applyRemix, classifyRemix, remixPatch, REMIX_CHIP_LABELS, REMIX_CHIPS, type RemixChip } from './director/remix';
export { sealVersion, versionStoreFromEnv, type PublishedGame, type VersionStore } from './version';
