/**
 * Řetěz věrnosti (P27A T1): položka kontrolního seznamu věty → čtyři stupně
 * `asked → inSpec → read → drawn`.
 *
 * - `inSpec` – spec ji nese (popisek role, `theme.setting`, ovládání nebo mechanika,
 *   u hry žánru režim, který sloveso podle tabulky klasifikátoru hraje – P32B T6);
 * - `read` – nese ji místem, které ovládání čte (`src/play/capabilities.ts`),
 *   nebo ji splní doplněk (`spec.addons`, P26D): „jump and shoot“ je plošinovka
 *   s `+shoot`, ne ztracené sloveso; u žánrů arény (souboj, útěk, sběr, úkol –
 *   P32B T5b) ji čte generátor, když z role postavil tělo;
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

import { baseControlOf } from '../arcade/addons';
import { arcadeWorldOf } from '../arcade/compile';
import { BODY, HEADER, ROLE, bodyBase } from '../arcade/contract';
import { worldHasPhysics } from '../arcade/kernel';
import { lookFor } from '../arcade/look';
import { rapierIfLoaded } from '../arcade/physics/world';
import { verifyArcade } from '../arcade/verify';
import { matchesWitness, type ActionWitness } from '../arcade/witness';
import type { IntentTriple } from '../intent/contract';
import { PROP_ROLES, chaserModel, enemyModel, heroModel, namedProps, propModels, riggedModelOf, sceneModelOf, type PropRole } from '../arcade/models';
import { CAPABILITIES, controlOf, readsLabel, readsMechanic } from '../capabilities';
import { assetSource } from '../compile/assets';
import type { VerbProof } from '../contracts';
import { verbPlayedBy } from '../genre/classify';
import type { CastRole } from '../genre/contract';
import type { AddonId, ControlId, GameRole, GameSpecV1 } from '../spec';

export type FidelitySlot = 'hero' | 'role' | 'any' | 'setting' | 'verb';

export interface ChecklistEntry {
  /** P41: the full requested relationship; only actual witnesses can satisfy it. */
  readonly triple?: IntentTriple;
  readonly item: string;
  readonly slot: FidelitySlot;
  /** Slova, podle kterých se položka pozná v popisku role nebo v prostředí. */
  readonly match?: readonly string[];
  /** Ovládání, která sloveso splní. */
  readonly controls?: readonly string[];
  /** Mechaniky, které sloveso splní, když je ovládání čte. */
  readonly mechanics?: readonly string[];
  /** Co věc podle věty dělá (P39) – u slotů `role` a `any` sady měření; soudí ho stupeň `role`. */
  readonly does?: CastRole;
}

export const FIDELITY_WHY = ['not-in-spec', 'not-read-by-control', 'no-model', 'off-camera', 'ok'] as const;
export type FidelityWhy = (typeof FIDELITY_WHY)[number];

export interface ChainItem {
  readonly item: string;
  readonly slot: FidelitySlot;
  readonly inSpec: boolean;
  readonly read: boolean;
  readonly drawn: boolean;
  /**
   * P39: věc hraje roli, kterou jí věta dává (`ChecklistEntry.does`) – nakreslené tělo, které se tak
   * chová. Bez `does` stačí `drawn`; sloveso, které hraje jen doplněk, chce jmenovaný terč doplňku ve správné roli.
   */
  readonly role: boolean;
  readonly why: FidelityWhy;
}

/** Sloveso, které doplněk splní: `+shoot` je střelba, `+collect` sbírání, `+chaser` útěk, `+lives` životy. */
const ADDON_VERB: Readonly<Record<AddonId, { readonly control?: ControlId; readonly mechanic?: string }>> = {
  shoot: { control: 'shooter' },
  collect: { mechanic: 'collectible' },
  chaser: { mechanic: 'chaser' },
  lives: { mechanic: 'health' },
};

/** Režim hry žánru podle generátoru, který zapsal překlad modulu (P32B T6); běžec a plošinovka hrají svým ovládáním. */
const GENERATOR_MODE: Readonly<Record<string, readonly [genre: string, mode: string]>> = {
  arena_escape: ['arena', 'escape'],
  arena_collect: ['arena', 'collect'],
  fight: ['arena', 'fight'],
  voyage_race: ['voyage', 'race'],
  voyage_land: ['voyage', 'land'],
  quest_spatial: ['quest', 'spatial'],
  quest_station: ['quest', 'station'],
};

/** Co dělají těla, která doplněk přidá (P39): sloveso hrané jen doplňkem chce tuhle roli u věci, kterou věta jmenuje. */
const ADDON_DOES: Readonly<Partial<Record<AddonId, CastRole>>> = { shoot: 'shoot_at', chaser: 'chase_me', collect: 'collect' };

/**
 * Co role ve hře dělá (P39, stupeň `role`) – podle druhu role, ovládání, doplňků
 * a generátoru, stejně jako je hra hraje: nepřítel `+shoot` nebo střílečky se
 * sestřelí, nebezpečí souboje je soupeř, jinde se mu uhýbá.
 */
function playsAs(role: GameRole, control: ControlId, addons: readonly AddonId[], generator: unknown): CastRole {
  if (PLAYER(role)) return 'hero';
  if (role.kind === 'chaser' || role.kind === 'patrol') return 'chase_me';
  if (role.id === 'enemy' && (addons.includes('shoot') || control === 'shooter')) return 'shoot_at';
  if (role.kind === 'hazard' && (control === 'duel' || generator === 'fight')) return 'fight';
  if (role.kind === 'hazard' || role.kind === 'zone') return 'avoid';
  if (role.kind === 'collectible' || role.kind === 'key' || role.kind === 'item') return 'collect';
  if (role.kind === 'target') return control === 'throw' ? 'throw_at' : control === 'shooter' ? 'shoot_at' : 'reach';
  if (role.kind === 'exit' || role.kind === 'destination' || role.kind === 'checkpoint' || role.kind === 'door') return 'reach';
  return 'scenery';
}

/** Role, kterou doplněk přidá do hry a scéna ji kreslí podle popisku (nepřítel `+shoot`, pronásledovatel `+chaser`). */
const addonRole = (role: Pick<GameRole, 'id' | 'kind'>, addons: readonly AddonId[]): boolean =>
  (addons.includes('shoot') && role.id === 'enemy') || (addons.includes('chaser') && role.kind === 'chaser');

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, words: readonly string[]): boolean =>
  words.some((word) => new RegExp(`\\b${escape(word.toLowerCase())}(?:e?s)?\\b`).test(text.toLowerCase()));

const PLAYER = (role: Pick<GameRole, 'kind'>): boolean => role.kind === 'player';

/** Role arkády, které scéna kreslí modelem z popisku, a zda pro ně svět postavil těleso (`item` = věc stylizované arény). */
type DrawnBody = 'player' | 'enemy' | 'chaser' | 'item' | PropRole;
interface ArcadeScene {
  readonly bodies: ReadonlySet<DrawnBody>;
  /** Stylizovaná aréna (P32E T5, `StyledWorld` v `ArenaScene.tsx`): souboj, útěk, sběr a úkol žánru, ne agar. */
  readonly styled: boolean;
}

/**
 * Tělo stylizované arény, které nese model z popisku role (`partOf` v `ArenaScene.tsx`):
 * hrdina, pronásledovatel, nepřítel souboje, věc; cíl úkolu kreslí vrstva cílů úkolu.
 */
const STYLED_PART: Partial<Record<GameRole['kind'], DrawnBody>> = { player: 'player', chaser: 'chaser', hazard: 'enemy', collectible: 'item', target: 'target' };

/** Stejné rozhodnutí jako `modelIdOf` v `ArcadeStage.tsx`: které tělo nese model z popisku které role. */
function arcadeScene(spec: GameSpecV1): ArcadeScene {
  const bodies = new Set<DrawnBody>();
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) return { bodies, styled: false };
  const control = baseControlOf(made.world.control);
  const styled = control.id === 'fight' || (control.id === 'move_free' && (control.params as { readonly size?: unknown }).size !== undefined);
  const state = made.world.initial;
  const count = state[HEADER.bodyCount] as number;
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    const role = state[base + BODY.role] as number;
    const kind = made.world.kinds[state[base + BODY.kind] as number] ?? '';
    if (role === ROLE.player) bodies.add('player');
    else if (kind === 'enemy') bodies.add('enemy');
    else if (kind === 'rival-car' || kind === 'foe') bodies.add('rival');
    else if (kind === 'finish' || kind === 'goal') bodies.add('finish');
    else if (role === ROLE.chaser) bodies.add('chaser');
    else if (styled && role === ROLE.collectible) bodies.add('item');
    else if (role === ROLE.collectible && kind === 'coin') bodies.add('coin');
    else if (role === ROLE.obstacle && ['hurdle', 'cone', 'crate'].includes(kind)) bodies.add('obstacle');
    // Věž hodu je z kostek role terče – kreslí je model z popisku terče (P28D T3).
    else if (role === ROLE.target && (kind === 'target' || kind === 'wood-block')) bodies.add('target');
    // P30B T4: mantinel závodu, nota rytmu a díl věže načasování (jezdec i položené díly jsou `block`).
    else if (role === ROLE.obstacle && kind === 'tire-barrier') bodies.add('barrier');
    else if (role === ROLE.target && kind === 'note') bodies.add('note');
    else if (role === ROLE.platform && kind === 'block') bodies.add('block');
    // P39 T9: nástrahy z věty – bodák skákačky, trubka poletování, útes a koule plavby (`hazardTagOf` ve `World.tsx`).
    else if (kind === 'spikes' || kind === 'pipe') bodies.add(kind);
    else if (role === ROLE.hazard && (kind === 'snag' || kind === 'shot')) bodies.add('hazard');
  }
  return { bodies, styled };
}

/** Čte stylizovaná aréna popisek role? Ano, když z role postavila tělo, které kreslí modelem z popisku. */
function styledReads(role: GameRole, scene: ArcadeScene): boolean {
  const part = STYLED_PART[role.kind];
  return part !== undefined && scene.bodies.has(part);
}

/**
 * Model stylizované arény pro roli: stejná obsazení jako `cast` v `ArcadePlay.tsx`.
 * Nepřítel souboje a věc berou model z rolí `enemy` a `coin` – popisek soupeře
 * (`rival`) a věci (`item`) žánru arény zatím nečtou (B-R9), cíl úkolu kreslí vrstva úkolu.
 */
function styledDraws(spec: GameSpecV1, role: GameRole): boolean {
  const character = riggedModelOf(role.label) ?? sceneModelOf(role.label, true);
  if (role.kind === 'hazard') return character === enemyModel(spec);
  if (role.kind === 'collectible') return propModels(spec).coin !== undefined && sceneModelOf(role.label, false) === propModels(spec).coin;
  return false;
}

/** Kreslí scéna tuhle roli modelem z jejího popisku? */
function drawsRole(spec: GameSpecV1, control: ControlId, role: GameRole, scene: () => ArcadeScene): boolean {
  // Mřížka: entita role dostane asset katalogu, nebo primitiv (`compile/blueprint.ts`).
  if (control === 'tap_go') return assetSource(role.id, role.label, role.kind) !== null;
  const built = scene();
  const { bodies } = built;
  if (built.styled && (role.kind === 'hazard' || role.kind === 'collectible' || role.kind === 'target')) return styledReads(role, built) && styledDraws(spec, role);
  if (PLAYER(role)) {
    if (!bodies.has('player')) return false;
    // Výchozí hrdina (průzkumník, závodní auto, ptáček) popisek nekreslí – kromě popisku, který ho jmenuje.
    const named = control === 'steer' ? sceneModelOf(role.label, false) : (riggedModelOf(role.label) ?? sceneModelOf(role.label, true));
    return named !== undefined && named === heroModel(spec);
  }
  if (role.id === 'enemy') return bodies.has('enemy') && (riggedModelOf(role.label) ?? sceneModelOf(role.label, true)) === enemyModel(spec);
  if (role.kind === 'chaser') return bodies.has('chaser') && (riggedModelOf(role.label) ?? sceneModelOf(role.label, true)) === chaserModel(spec);
  // Popisek, který jmenuje tělo jádra („rival car“), se kreslí taky – jako u hrdiny, kterého popisek jmenuje.
  const prop = PROP_ROLES.find((id) => id === role.id);
  return prop !== undefined && bodies.has(prop) && namedProps(spec)[prop] !== undefined;
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
 * nese, a čtené i kreslené teprve tehdy, když ho robot vystřelil a hra se tím
 * změnila (P30B R2) – pravidlo, které se nestalo nebo nic neudělalo, čitelnost
 * nezvedne. `verbs` = důkazy z ověření
 * (`QualityReport.verbs`); chybí-li, robot se pustí jen nad specem s pravidly.
 */
export function fidelityChain(spec: GameSpecV1, checklist: readonly ChecklistEntry[], verbs?: readonly VerbProof[]): ChainItem[] {
  let witnesses: readonly ActionWitness[] | undefined;
  const playedTriple = (triple: IntentTriple): boolean => {
    if (witnesses === undefined) {
      const made = arcadeWorldOf(spec, 1);
      witnesses = made.ok && (!worldHasPhysics(made.world) || rapierIfLoaded() !== null)
        ? verifyArcade(made.world, undefined, made.roleBindings).witnesses : [];
    }
    return witnesses.some(witness => matchesWitness(triple, witness));
  };
  const control = controlOf(spec);
  const addons = spec.addons ?? [];
  const roles = spec.roles ?? [];
  const mechanicIds: readonly string[] = (spec.mechanics ?? []).map((mechanic) => mechanic.id);
  const generator = spec.controlParams?.generator;
  let built: ArcadeScene | undefined;
  const scene = (): ArcadeScene => (built ??= arcadeScene(spec));
  // Generátor stylizované arény čte roli, ze které postavil tělo – `move_free` sám popisky nečte (agar).
  const readsRole = (role: GameRole): boolean => readsLabel(control, role) || addonRole(role, addons) || (control === 'move_free' && scene().styled && styledReads(role, scene()));
  let proofs = verbs;
  // Dokázané je sloveso, po kterém se hra změnila (`VerbProof.changed`, P30B R2), ne jen vystřelené pravidlo.
  const proved = (verb: string): boolean => (proofs ??= robotVerbs(spec)).some((proof) => proof.verb === verb && proof.changed);

  const stage = (entry: ChecklistEntry, inSpec: boolean, read: boolean, drawn: boolean, role = drawn): ChainItem => ({
    item: entry.item,
    slot: entry.slot,
    inSpec,
    read,
    drawn,
    role,
    why: !inSpec ? 'not-in-spec' : !read ? 'not-read-by-control' : !drawn ? 'no-model' : 'ok',
  });

  // Jména napřed: sloveso hrané jen doplňkem soudí podle toho, jestli jeho jmenovaný terč hraje svou roli.
  const nouns = new Map<ChecklistEntry, ChainItem>();
  for (const entry of checklist) if (entry.slot !== 'verb') nouns.set(entry, nounStage(entry));
  return checklist.map((entry) => nouns.get(entry) ?? verbStage(entry));

  function verbStage(entry: ChecklistEntry): ChainItem {
    if (entry.triple !== undefined) {
      const played = playedTriple(entry.triple);
      return stage(entry, played, played, played, played);
    }
    const controls = entry.controls ?? [];
    const mechanics = entry.mechanics ?? [];
    const byControl = controls.includes(control);
    const byMechanic = mechanics.filter((id) => mechanicIds.includes(id));
    const byAddon = addons.filter((addon) => {
      const verb = ADDON_VERB[addon];
      return (verb.control !== undefined && controls.includes(verb.control)) || (verb.mechanic !== undefined && mechanics.includes(verb.mechanic));
    });
    const byRule = (spec.rules ?? []).filter((rule) => mentions(rule.verb, [entry.item, ...(entry.match ?? [])])).map((rule) => rule.verb);
    // Hra žánru nese sloveso režimem: generátor souboje hraje „fight“, ne ovládání `duel` ze seznamu.
    const mode = typeof generator === 'string' ? GENERATOR_MODE[generator] : undefined;
    const byGenre = mode !== undefined && verbPlayedBy([entry.item, ...(entry.match ?? [])], mode[0], mode[1], roles.some((role) => role.kind === 'collectible' && readsRole(role)));
    const played = byControl || byMechanic.some((id) => readsMechanic(control, id, typeof generator === 'string' ? generator : undefined)) || byRule.some(proved) || byGenre;
    const read = played || byAddon.length > 0;
    // Sloveso hrané jen doplňkem je ve správné roli, když věc, kterou věta jmenuje jako jeho terč, hraje tu roli (P39) –
    // „shoot animals“ s doplňkem, který střílí roboty, ne.
    const aimed = byAddon.some((addon) => {
      const does = ADDON_DOES[addon];
      return does === undefined || [...nouns].every(([noun, item]) => noun.does !== does || item.role);
    });
    // Sloveso se kreslí tím, že se hraje: čtené ovládání, mechanika, vystřelené pravidlo nebo režim žánru je vidět hraním.
    return stage(entry, byControl || byAddon.length > 0 || byMechanic.length > 0 || byRule.length > 0 || byGenre, read, read, played || aimed);
  }

  function nounStage(entry: ChecklistEntry): ChainItem {
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
    const drawnHits = hits.filter(readsRole).filter((role) => drawsRole(spec, control, role, scene));
    const does = entry.does;
    const role = does === undefined || does === 'scenery' ? drawnHits.length > 0 : drawnHits.some((hit) => playsAs(hit, control, addons, generator) === does);
    return stage(entry, hits.length > 0, hits.some(readsRole), drawnHits.length > 0, role);
  }
}
