/**
 * Poctivá hláška (P25E T1): věta chce hru, na kterou knihovna ovládání nemá.
 *
 * Návrh ze slov vždy nějakou hru postaví – u „match 3" nebo „tower defense"
 * je to ale tichá náhrada. Tenhle modul ji pojmenuje: z věty pozná jednu ze
 * čtyř tříd, které v tomhle kole neumíme (`manipulate`, `build_place`, `idle`,
 * `sandbox`), a řekne proč a co dostane hráč místo toho. Počítá se nad hotovým
 * návrhem, `draft.ts` o hlášce neví.
 *
 * Pořadí tříd je záměr: „multiplayer město, kde si postavím dům" je sandbox,
 * ne stavění, a „tetris s nábytkem" je skládání, ne zařizování.
 */

import type { ArchetypeId } from '../registry';
import type { ControlId, GameSpecV1 } from '../spec';
import type { PublishedGame, VersionStore } from '../version';
import { noVerbTopic } from './draft';
import { arcadeWorldOf, preloadPhysics } from '../arcade/compile';
import { loadRapier } from '../arcade/physics/world';
import { witnessRuns } from '../arcade/verify';
import { bindRoles, matchesWitness, namesActor, type RoleBinding } from '../arcade/witness';
import type { ArcadeWorld } from '../arcade/contract';
import { essentialTriples, type IntentTriple } from '../intent/contract';
import { extractIntent } from '../intent/extract';
import { vocabVerb, vocabVersion } from '../vocab';
import { canonical } from '@/ir/worlddoc';

/**
 * `no_verb` (P28D T4): věta hru nechce vůbec („explain quantum physics“) – hraje se hra o jejím tématu (od P36A T11 sběr v Aréně, dřív běžec).
 * `played_as` (P44C T9): hra splnila všechno, ale sloveso z věty jen přiblížila tabulkou („Stab plays as a fight.“).
 */
export type UnsupportedKind = 'sandbox' | 'manipulate' | 'idle' | 'build_place' | 'no_verb' | 'actions' | 'played_as';

export interface Honesty {
  readonly unmet?: readonly IntentTriple[];
  readonly kind: UnsupportedKind;
  /** Jedna věta pro hráče, proč tahle hra hratelná není. */
  readonly reason: string;
  /** Hra, kterou návrh postavil místo toho, se členem („a chase game"). */
  readonly closest: string;
}

const CLASSES: readonly { readonly kind: UnsupportedKind; readonly reason: string; readonly cues: readonly RegExp[] }[] = [
  {
    kind: 'sandbox',
    reason: 'Open worlds, crafting and multiplayer are bigger than one short game.',
    cues: [/\bopen[- ]world\b/, /\bmultiplayer\b/, /\bminecraft\b/, /\bcrafting\b/, /\bgta\b/, /\bmmo\b/],
  },
  {
    kind: 'manipulate',
    reason: 'Swapping, sorting and sliding pieces around is not something we can build yet.',
    cues: [
      /\bmatch[- ]?(?:3|three)\b/,
      /\bmatching game\b/,
      /\bcandy crush\b/,
      /\btetris\b/,
      /\bmahjong\b/,
      /\bjenga\b/,
      /\bslide (?:the )?blocks\b/,
      /\bsort\b.*\binto\b/,
      /\buntangle\b/,
      /\bconnect (?:the )?pipes\b/,
      /\bpull the pins?\b/,
      /\bunscrew\b/,
      /\bbeams? with mirrors?\b/,
      /\bpark the cars?\b/,
      /\bword game\b/,
    ],
  },
  {
    kind: 'idle',
    reason: 'Games that grow while you tap or wait are not something we can build yet.',
    cues: [
      /\bidle\b/,
      /\bclicker\b/,
      /\bmerge\b/,
      /\bhire\b.*\bupgrade\b/,
      /\bmakes? money\b/,
      /\bmanage (?:a|an|my) (?:\w+ )?(?:hotel|restaurant|shop|store|farm|zoo|park|business|company|factory)\b/,
    ],
  },
  {
    kind: 'build_place',
    reason: 'Placing defenders or dressing things up is not something we can build yet.',
    cues: [
      /\btower defen[cs]e\b/,
      /\bdefend the \w+ from\b/,
      /\bprotect the \w+ from\b/,
      /\bplants vs\b/,
      /\bplace \w+ to stop\b/,
      /\bdecorate\b/,
      /\bdress up\b/,
      /\boutfits?\b/,
      /\bmakeover\b/,
      /\bdesign my own\b/,
      /\bsalon\b/,
    ],
  },
];

const CLOSEST: Readonly<Record<ArchetypeId, string>> = {
  collect_exit: 'a collect-and-escape game',
  chase_escape: 'a chase game',
  survival_timer: 'a survival game',
  checkpoint_race: 'a race through checkpoints',
  delivery: 'a delivery game',
  switch_puzzle: 'a switch puzzle',
  hazard_crossing: 'a crossing game',
  combat_lite: 'a fight game',
};

/** Arkádové hry sdílejí archetyp šablony, takže je pojmenuje ovládání. */
const ARCADE_CLOSEST: Readonly<Record<Exclude<ControlId, 'tap_go'>, string>> = {
  glide: 'a swimming or flying game',
  walker: 'a maze game',
  ball: 'a ball game',
  runner: 'an endless runner',
  platform: 'a platformer',
  flap: 'a flappy game',
  steer: 'a racing game',
  move_free: 'an arena game',
  shooter: 'a shooting game',
  throw: 'a throwing game',
  timing: 'a timing game',
  rhythm: 'a rhythm game',
  duel: 'a duel',
  lanes: 'a lane game',
  hop: 'a road-crossing game',
  crowd: 'a crowd runner',
  merge: 'a merge game',
  push: 'a sumo game',
};

/** Hra žánru (P32B T2) se jmenuje podle žánru a režimu – ovládání pahýlu je jen dnešní náhrada. */
const GENRE_CLOSEST: Readonly<Record<string, string>> = {
  'runner.default': 'an endless runner',
  'platformer.default': 'a platformer',
  'arena.escape': 'a chase game',
  'arena.collect': 'a collecting game',
  'arena.fight': 'a duel',
  'voyage.race': 'a race',
  'voyage.land': 'a landing game',
  'quest.spatial': 'a quest',
  'quest.station': 'a quest',
};

function closestOf(draft: Pick<GameSpecV1, 'archetype' | 'control' | 'genre'>): string {
  const genre = draft.genre === undefined ? undefined : GENRE_CLOSEST[`${draft.genre.id}.${draft.genre.mode}`];
  if (genre !== undefined) return genre;
  // Arkádová hra si nese jméno podle ovládání – archetyp šablony je u všech
  // `hazard_crossing`, takže by hláška u plošinovky slibovala přecházení.
  return draft.control === undefined || draft.control === 'tap_go' ? CLOSEST[draft.archetype] : ARCADE_CLOSEST[draft.control];
}

/** Věta a hotový návrh → hláška, nebo `null`, když hra splní, co věta chtěla. */
export function unsupportedGame(sentence: string, draft: Pick<GameSpecV1, 'archetype' | 'control' | 'genre'>): Honesty | null {
  const text = sentence.toLowerCase();
  // Obranu před vlnami hraje od P54C T13 obrana pruhů (držení postaví obránce) – hláška „neumíme“ by u ní lhala.
  // Slučování („merge watermelons like suika game“) hraje od P54C T13b žánr slučování – tentýž důvod.
  const played = (kind: UnsupportedKind): boolean => (kind === 'build_place' && draft.genre?.id === 'defense') || (kind === 'idle' && draft.genre?.id === 'merge');
  const match = CLASSES.find((entry) => !played(entry.kind) && entry.cues.some((cue) => cue.test(text)));
  if (match === undefined) {
    // Jen dokud hra je návrh věty bez slovesa – od P36A T11 sběr v Aréně, uložené hry dřív běžec; AI verze s jinou hrou hlášku nepotřebuje.
    const plain = draft.control === 'runner' || (draft.genre?.id === 'arena' && draft.genre.mode === 'collect');
    const topic = plain ? noVerbTopic(sentence) : null;
    if (topic === null) return null;
    const game = closestOf(draft);
    return { kind: 'no_verb', reason: `No game verb found – here is ${game} about ${topic}. Try: ‘Dodge …’, ‘Collect …’`, closest: game };
  }
  return { kind: match.kind, reason: match.reason, closest: closestOf(draft) };
}

/**
 * Hláška pro publikovanou hru. Věta: návrh ji nese v `origin`, hra od režiséra
 * bez návrhu v `sentence`, autorská verze po upgradu ji má u rodiče.
 */
export async function honestyOf(versions: Pick<VersionStore, 'get'>, game: PublishedGame): Promise<Honesty | null> {
  // Řetěz mikroher poctivou hlášku nemá (P56C T10); bez tohohle by `/play/[id]` pouštěl robota na kolo 1 při každém zobrazení.
  if (game.chain !== undefined) return null;
  const sentence = await sentenceOf(versions, game);
  return sentence === null ? null : honestyForSpec(sentence, game.spec, game.version.seed, game.arcade);
}

/** Read the final version afresh, including cold physics, never its draft's claims. */
export async function honestyForSpec(sentence: string, spec: GameSpecV1, seed: number, publishedWorld?: ArcadeWorld): Promise<Honesty | null> {
  // Přiznání čte tabulku P44C – stejný spec dá jiné přiznání podle toho, jestli je zapnutá.
  const key = canonical({ sentence, spec, seed, world: publishedWorld ?? null, vocab: vocabVersion() });
  if (honesties.has(key)) return structuredClone(honesties.get(key)!);
  const answer = await measureHonesty(sentence, spec, seed, publishedWorld);
  if (honesties.size >= 64) honesties.delete(honesties.keys().next().value!);
  honesties.set(key, structuredClone(answer));
  return answer;
}

const honesties = new Map<string, Honesty | null>();

const LABELS: Readonly<Record<string, string>> = { drive: 'driving', run: 'running', jump: 'jumping', glide: 'gliding', roam: 'free movement', race: 'racing', shoot: 'shooting', collect: 'collecting', escape: 'escaping', fight: 'fighting', duel: 'duelling', reach: 'reaching the goal', deliver: 'delivery', interact: 'interaction', chaser: 'the chase', guard: 'the guards', hazard: 'the hazards', obstacle: 'the obstacles', rival: 'the rivals' };
/** Co hra hraje místo slovesa z věty („Stab plays as a fight.“); jinak popisek kusu. */
const PLAYED_AS: Readonly<Record<string, string>> = { fight: 'a fight', duel: 'a duel', race: 'a race', deliver: 'a delivery' };

const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
const listed = (words: readonly string[]) => (words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
/** „stab“ → „stabbing“, „lug“ → „lugging“, „escape“ → „escaping“. */
const gerund = (lemma: string) => (/[^e]e$/.test(lemma) ? `${lemma.slice(0, -1)}ing` : /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(lemma) ? `${lemma}${lemma.at(-1)}ing` : `${lemma}ing`);

async function measureHonesty(sentence: string, spec: GameSpecV1, seed: number, publishedWorld?: ArcadeWorld): Promise<Honesty | null> {
  const intent = extractIntent(sentence);
  const triples = essentialTriples(intent);
  await preloadPhysics(spec, loadRapier);
  const made = publishedWorld === undefined ? arcadeWorldOf(spec, seed) : { ok: true as const, world: publishedWorld, roleBindings: bindRoles(spec, publishedWorld) };
  // Svědek sondy průběhu má za aktéra chování („boss“, „swarm“): trojici potvrdí, jen když ho věta jmenuje (P46B R4: 4 sondy běžce ≈ 3 s).
  const pacingProbe = (binding: RoleBinding) => triples.some(triple => namesActor(triple, binding));
  // Přiznání čte jen svědky (sondy a vítězný běh); přehrání a nečinný hráč z `verifyArcade` by jen stály čas odpovědi.
  const runs = made.ok ? witnessRuns(made.world, undefined, made.roleBindings, { pacingProbe }) : null;
  const witnesses = runs === null ? [] : [...runs.bot.witnesses, ...runs.probes];
  const unmet = triples.filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));
  // P44C: sloveso přiblížené tabulkou se jmenuje slovem z věty, ne kanonickým kusem.
  const mapped = intent.items.filter(item => item.mapped === true && item.essential);
  const lemmaOf = (item: { readonly said: string }) => vocabVerb(item.said)?.lemma ?? item.said;
  if (unmet.length === 0) {
    const unsupported = unsupportedGame(sentence, spec);
    if (unsupported !== null || mapped.length === 0) return unsupported;
    const pairs = [...new Map(mapped.map(item => [lemmaOf(item), PLAYED_AS[item.verb] ?? LABELS[item.verb] ?? item.verb])).entries()];
    const [first, ...rest] = pairs.map(([lemma, played], at) => (at === 0 ? `${capital(lemma)} plays as ${played}` : `${lemma} as ${played}`));
    return { kind: 'played_as', closest: closestOf(spec), reason: `${rest.length === 0 ? first : `${first}, ${listed(rest)}`}.` };
  }
  const said = (triple: IntentTriple) => mapped.find(item => item.verb === triple.verb && item.actor === triple.actor && item.object === triple.object);
  const missing = [...new Set(unmet.map(triple => {
    const item = said(triple);
    return item === undefined ? (LABELS[triple.verb] ?? triple.verb) : gerund(lemmaOf(item));
  }))];
  const closest = spec.control === 'steer' && !witnesses.some(w => w.verb === 'race') ? 'a driving game' : closestOf(spec);
  return { kind: 'actions', unmet, closest, reason: `${capital(listed(missing))} ${missing.length === 1 ? "isn't" : "aren't"} here yet – here's ${closest}.` };
}

export async function sentenceOf(versions: Pick<VersionStore, 'get'>, game: PublishedGame): Promise<string | null> {
  if (game.origin !== undefined) return game.origin.sentence;
  if (game.sentence !== undefined) return game.sentence;
  if (game.relation !== 'upgrade' || game.version.parentId === null) return null;
  return (await versions.get(game.version.parentId))?.origin?.sentence ?? null;
}
