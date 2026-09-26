/**
 * Řetěz věrnosti (P27A T1): položka kontrolního seznamu věty → čtyři stupně
 * `asked → inSpec → read → drawn`.
 *
 * - `inSpec` – spec ji nese (popisek role, `theme.setting`, ovládání nebo mechanika);
 * - `read` – nese ji místem, které ovládání čte (`src/play/capabilities.ts`),
 *   nebo ji splní doplněk (`spec.addons`, P26D): „jump and shoot“ je plošinovka
 *   s `+shoot`, ne ztracené sloveso;
 * - `drawn` – scéna ji nakreslí: role má ve zkompilovaném světě těleso a
 *   výběr modelu (`arcade/models.ts`, u mřížky `compile/assets.ts`) k popisku
 *   něco našel. Popisek bez modelu se kreslí kvádrem nebo výchozí postavou –
 *   to věta nechtěla, `why: 'no-model'`.
 *
 * `why` říká první stupeň, na kterém se položka ztratila. `off-camera` patří
 * sondě záběru (T6) – z dat se nepozná, offline ho řetěz nevrací.
 *
 * Skript `scripts/play-fidelity.mjs` modul volá holým Nodem přes zavaděč
 * `scripts/ts-paths.mjs`.
 */

import { arcadeWorldOf } from '../arcade/compile';
import { BODY, HEADER, ROLE, bodyBase } from '../arcade/contract';
import { worldHasPhysics } from '../arcade/kernel';
import { lookFor } from '../arcade/look';
import { rapierIfLoaded } from '../arcade/physics/world';
import { verifyArcade } from '../arcade/verify';
import { chaserModel, enemyModel, heroModel, modelOf, propModels, riggedModelOf } from '../arcade/models';
import { CAPABILITIES, controlOf, readsLabel, readsMechanic } from '../capabilities';
import { assetSource } from '../compile/assets';
import type { VerbProof } from '../contracts';
import type { AddonId, ControlId, GameRole, GameSpecV1 } from '../spec';

export type FidelitySlot = 'hero' | 'role' | 'any' | 'setting' | 'verb';

export interface ChecklistEntry {
  readonly item: string;
  readonly slot: FidelitySlot;
  /** Slova, podle kterých se položka pozná v popisku role nebo v prostředí. */
  readonly match?: readonly string[];
  /** Ovládání, která sloveso splní. */
  readonly controls?: readonly string[];
  /** Mechaniky, které sloveso splní, když je ovládání čte. */
  readonly mechanics?: readonly string[];
}

export const FIDELITY_WHY = ['not-in-spec', 'not-read-by-control', 'no-model', 'off-camera', 'ok'] as const;
export type FidelityWhy = (typeof FIDELITY_WHY)[number];

export interface ChainItem {
  readonly item: string;
  readonly slot: FidelitySlot;
  readonly inSpec: boolean;
  readonly read: boolean;
  readonly drawn: boolean;
  readonly why: FidelityWhy;
}

/** Sloveso, které doplněk splní: `+shoot` je střelba, `+collect` sbírání, `+chaser` útěk, `+lives` životy. */
const ADDON_VERB: Readonly<Record<AddonId, { readonly control?: ControlId; readonly mechanic?: string }>> = {
  shoot: { control: 'shooter' },
  collect: { mechanic: 'collectible' },
  chaser: { mechanic: 'chaser' },
  lives: { mechanic: 'health' },
};

/** Role, kterou doplněk přidá do hry a scéna ji kreslí podle popisku (nepřítel `+shoot`, pronásledovatel `+chaser`). */
const addonRole = (role: Pick<GameRole, 'id' | 'kind'>, addons: readonly AddonId[]): boolean =>
  (addons.includes('shoot') && role.id === 'enemy') || (addons.includes('chaser') && role.kind === 'chaser');

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, words: readonly string[]): boolean =>
  words.some((word) => new RegExp(`\\b${escape(word.toLowerCase())}(?:e?s)?\\b`).test(text.toLowerCase()));

const PLAYER = (role: Pick<GameRole, 'kind'>): boolean => role.kind === 'player';

/** Role arkády, které scéna kreslí modelem z popisku, a zda pro ně svět postavil těleso. */
type DrawnBody = 'player' | 'enemy' | 'chaser' | 'coin' | 'obstacle' | 'target' | 'rival';
interface ArcadeScene {
  readonly bodies: ReadonlySet<DrawnBody>;
}

/** Stejné rozhodnutí jako `modelIdOf` v `ArcadeStage.tsx`: které tělo nese model z popisku které role. */
function arcadeScene(spec: GameSpecV1): ArcadeScene {
  const bodies = new Set<DrawnBody>();
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) return { bodies };
  const state = made.world.initial;
  const count = state[HEADER.bodyCount] as number;
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    const role = state[base + BODY.role] as number;
    const kind = made.world.kinds[state[base + BODY.kind] as number] ?? '';
    if (role === ROLE.player) bodies.add('player');
    else if (kind === 'enemy') bodies.add('enemy');
    else if (kind === 'rival-car' || kind === 'foe') bodies.add('rival');
    else if (role === ROLE.chaser) bodies.add('chaser');
    else if (role === ROLE.collectible && kind === 'coin') bodies.add('coin');
    else if (role === ROLE.obstacle && ['hurdle', 'cone', 'crate'].includes(kind)) bodies.add('obstacle');
    // Věž hodu je z kostek role terče – kreslí je model z popisku terče (P28D T3).
    else if (role === ROLE.target && (kind === 'target' || kind === 'wood-block')) bodies.add('target');
  }
  return { bodies };
}

/** Kreslí scéna tuhle roli modelem z jejího popisku? */
function drawsRole(spec: GameSpecV1, control: ControlId, role: GameRole, scene: () => ArcadeScene): boolean {
  // Mřížka: entita role dostane asset katalogu, nebo primitiv (`compile/blueprint.ts`).
  if (control === 'tap_go') return assetSource(role.id, role.label) !== null;
  const { bodies } = scene();
  if (PLAYER(role)) {
    if (!bodies.has('player')) return false;
    // Výchozí hrdina (průzkumník, závodní auto, ptáček) popisek nekreslí – kromě popisku, který ho jmenuje.
    const named = control === 'steer' ? modelOf(role.label, false) : (riggedModelOf(role.label) ?? modelOf(role.label, true));
    return named !== undefined && named === heroModel(spec);
  }
  if (role.id === 'enemy') return bodies.has('enemy') && (riggedModelOf(role.label) ?? modelOf(role.label, true)) === enemyModel(spec);
  if (role.kind === 'chaser') return bodies.has('chaser') && (riggedModelOf(role.label) ?? modelOf(role.label, true)) === chaserModel(spec);
  if (role.id === 'coin' || role.id === 'obstacle' || role.id === 'target' || role.id === 'rival') return bodies.has(role.id) && propModels(spec, false)[role.id] !== undefined;
  return false;
}

/** Slovesa pravidel, která robot během vítězného běhu vystřelil (seed 1, jako `arcadeScene`). */
function robotVerbs(spec: GameSpecV1): readonly VerbProof[] {
  const made = arcadeWorldOf(spec, 1);
  // Svět s fyzikou bez načteného Rapieru robot neodehraje: slovesa zůstanou nedokázaná.
  return made.ok && (!worldHasPhysics(made.world) || rapierIfLoaded() !== null) ? verifyArcade(made.world).verbs : [];
}

/**
 * Položky seznamu nad jedním specem, každá se všemi čtyřmi stupni.
 *
 * Sloveso pokryté pravidlem (P29A T9) je ve specu, když pravidlo to sloveso
 * nese, a čtené i kreslené teprve tehdy, když ho robot opravdu vystřelil –
 * pravidlo, které se nestalo, čitelnost nezvedne. `verbs` = důkazy z ověření
 * (`QualityReport.verbs`); chybí-li, robot se pustí jen nad specem s pravidly.
 */
export function fidelityChain(spec: GameSpecV1, checklist: readonly ChecklistEntry[], verbs?: readonly VerbProof[]): ChainItem[] {
  const control = controlOf(spec);
  const addons = spec.addons ?? [];
  const roles = spec.roles ?? [];
  const mechanicIds: readonly string[] = (spec.mechanics ?? []).map((mechanic) => mechanic.id);
  const readsRole = (role: GameRole): boolean => readsLabel(control, role) || addonRole(role, addons);
  let built: ArcadeScene | undefined;
  const scene = (): ArcadeScene => (built ??= arcadeScene(spec));
  let proofs = verbs;
  const fired = (verb: string): boolean => (proofs ??= robotVerbs(spec)).some((proof) => proof.verb === verb && proof.fired);

  const stage = (entry: ChecklistEntry, inSpec: boolean, read: boolean, drawn: boolean): ChainItem => ({
    item: entry.item,
    slot: entry.slot,
    inSpec,
    read,
    drawn,
    why: !inSpec ? 'not-in-spec' : !read ? 'not-read-by-control' : !drawn ? 'no-model' : 'ok',
  });

  return checklist.map((entry) => {
    if (entry.slot === 'verb') {
      const controls = entry.controls ?? [];
      const mechanics = entry.mechanics ?? [];
      const byControl = controls.includes(control);
      const byMechanic = mechanics.filter((id) => mechanicIds.includes(id));
      const byAddon = addons.some((addon) => {
        const verb = ADDON_VERB[addon];
        return (verb.control !== undefined && controls.includes(verb.control)) || (verb.mechanic !== undefined && mechanics.includes(verb.mechanic));
      });
      const byRule = (spec.rules ?? []).filter((rule) => mentions(rule.verb, [entry.item, ...(entry.match ?? [])])).map((rule) => rule.verb);
      const read = byControl || byAddon || byMechanic.some((id) => readsMechanic(control, id)) || byRule.some(fired);
      // Sloveso se kreslí tím, že se hraje: čtené ovládání, mechanika nebo vystřelené pravidlo je vidět hraním.
      return stage(entry, byControl || byAddon || byMechanic.length > 0 || byRule.length > 0, read, read);
    }
    const match = entry.match ?? [];
    if (entry.slot === 'setting') {
      const inSpec = mentions(spec.theme?.setting ?? '', match);
      // Arkáda ukáže prostředí jen sadou (P26 T11): louka místo neznámého místa se nepočítá.
      const shown = control === 'tap_go' || spec.theme?.look !== undefined || lookFor(spec.theme?.setting ?? '') !== null;
      const read = inSpec && CAPABILITIES[control].setting && shown;
      // Scéna s `setting: true` kreslí kulisy sady (`look/Scenery.tsx`), mřížka paletu a kulisy z `theme`.
      return stage(entry, inSpec, read, read);
    }
    const candidates = roles.filter((role) => (entry.slot === 'hero' ? PLAYER(role) : entry.slot === 'role' ? !PLAYER(role) : true));
    const hits = candidates.filter((role) => mentions(role.label, match));
    const readHits = hits.filter(readsRole);
    return stage(entry, hits.length > 0, readHits.length > 0, readHits.some((role) => drawsRole(spec, control, role, scene)));
  });
}
