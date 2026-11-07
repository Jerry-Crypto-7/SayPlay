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
import { plural, singular } from './lexicon';
import { arcadeWorldOf, preloadPhysics } from '../arcade/compile';
import { lookOf, type LookId } from '../arcade/look';
import { RIGGED_ALIAS, enemyLabel, heroChoice, type ModelChoice } from '../arcade/models';
import { loadRapier } from '../arcade/physics/world';
import { witnessRuns } from '../arcade/verify';
import { bindRoles, matchesWitness, namesActor, type RoleBinding } from '../arcade/witness';
import type { ArcadeWorld } from '../arcade/contract';
import { FIND_ONE, SIGN_CELLS, classifyGenre } from '../genre/classify';
import { impliedFlight } from '../compose/assemble';
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
  survivor: 'a wave survival game',
  hole: 'a growing hole game',
  steal: 'a heist game',
  sort: 'a sorting game',
  arrows: 'a tap-away puzzle',
  stunt: 'a stunt race',
  minigolf: 'a mini golf game',
  railfps: 'a first-person rail shooter',
  buildshift: 'a shop building game',
  drawsave: 'a draw-to-save puzzle',
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

/**
 * Hraje se žánr, který věta sama chce (P70B T2)? Klasifikátor ho slyšel jako znak celé hry („golf on the moon“ →
 * minigolf), nebo jen ze jména hry a narážek bez slovesa („golf course with water hazards“). Kusy záměru takové věty
 * („ball“, „score“ ze slova golf, „hit the ball“) jsou ta hra sama – svědka v jamce nemají a hláška by si vymýšlela
 * („Balling isn't here yet – here's a mini golf game“, audit 4. 11.).
 */
// P71D T6: obchod („run a pizza shop and serve 12 customers“) – „run“ je tu provozovat a „serve“ je ta hra sama,
// pruh hlásil „Running and delivery aren't here yet – here's a shop building game.“
const OWN_GAME_GENRES: ReadonlySet<string> = new Set(['minigolf', 'buildshift']);

function playsOwnGenre(sentence: string, spec: GameSpecV1): boolean {
  if (spec.genre === undefined) return false;
  const classified = classifyGenre(sentence, null);
  const heard = classified.ranked[0];
  if (heard === undefined || heard.score <= 0 || heard.genre !== spec.genre.id || heard.mode !== spec.genre.mode) return false;
  // Jen žánr celé hry (má znak): útěk v Aréně ze slova „dodges“ (`verb-mapping`) své hrozby dál přiznává.
  // simplified: jen minigolf a obchod (případy auditů) – railfps „a truck races and fires“ střelbu svědkem `shoot` nedokládá
  // a přiznat ji musí (`p42-admissions`); rozšířit, až jiný žánr celé hry ukáže falešný pruh.
  return OWN_GAME_GENRES.has(heard.genre) && SIGN_CELLS.has(`${heard.genre}.${heard.mode}`) && (classified.verb === null || classified.pick?.genre === heard.genre);
}

const LABELS: Readonly<Record<string, string>> = { ball: ARCADE_CLOSEST.ball, drive: 'driving', run: 'running', jump: 'jumping', glide: 'gliding', roam: 'free movement', race: 'racing', shoot: 'shooting', collect: 'collecting', escape: 'escaping', fight: 'fighting', duel: 'duelling', reach: 'reaching the goal', deliver: 'delivery', interact: 'interaction', chaser: 'the chase', guard: 'the guards', hazard: 'the hazards', obstacle: 'the obstacles', rival: 'the rivals' };
/** Hrozby se jmenují v množném čísle – sloveso hlášky se s nimi shoduje („The obstacles aren't here yet“). */
const PLURAL_LABELS: ReadonlySet<string> = new Set(['guard', 'hazard', 'obstacle', 'rival'].map(verb => LABELS[verb]!));
/** Co hra hraje místo slovesa z věty („Stab plays as a fight.“, „Flip plays as a tap.“); jinak popisek kusu. */
const PLAYED_AS: Readonly<Record<string, string>> = { fight: 'a fight', duel: 'a duel', race: 'a race', deliver: 'a delivery', interact: 'a tap' };

const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
const listed = (words: readonly string[]) => (words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
/** „stab“ → „stabbing“, „lug“ → „lugging“, „escape“ → „escaping“. */
const gerund = (lemma: string) => (/[^e]e$/.test(lemma) ? `${lemma.slice(0, -1)}ing` : /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(lemma) ? `${lemma}${lemma.at(-1)}ing` : `${lemma}ing`);

/**
 * Místa z věty, která žádná sada nekreslí (P73A T5): „a haunted library“ hraje hřbitov, „across rooftops“ náměstí.
 * simplified: ruční tabulka míst, která sady znají jen přibližně nebo vůbec; rozšířit, až snímek ukáže další tichou náhradu.
 */
const STAND_IN_PLACES: readonly (readonly [RegExp, string])[] = [
  [/\blibrar(?:y|ies)\b/, 'the library'],
  [/\brooftops?\b/, 'the rooftops'],
  [/\bsewers?\b/, 'the sewer'],
  [/\bsubway\b/, 'the subway'],
  [/\bhospital\b/, 'the hospital'],
  [/\bmuseum\b/, 'the museum'],
  [/\bairport\b/, 'the airport'],
  [/\bprison\b/, 'the prison'],
  [/\bchurch\b/, 'the church'],
  [/\bstadium\b/, 'the stadium'],
];
/** Jak se sada jmenuje hráči; jinak její id se členem („a city“). */
const LOOK_NAMES: Partial<Record<LookId, string>> = { graveyard: 'a spooky forest', underwater: 'the sea floor', space: 'outer space', ocean: 'the open sea', living_room: 'a living room' };
const lookName = (look: LookId) => LOOK_NAMES[look] ?? `${/^[aeiou]/.test(look) ? 'an' : 'a'} ${look.replace(/_/g, ' ')}`;
const article = (name: string) => `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;

/** Jméno modelu z nouze: riggovaná postava jménem statického modelu („explorer“, ne štítek „rancher“), jinak obecný štítek. */
const FALLBACK_NAMES: readonly string[] = ['explorer', 'robot', 'car', 'bird'];
const aliasName = (model: string) => Object.entries(RIGGED_ALIAS).find(([, id]) => model === `rigged:${id}`)?.[0];

/** Postava z věty, kterou scéna kreslí modelem z nouze (`level: 'fallback'`): „The giraffe isn't here yet – it's an explorer.“ */
function standInCharacter(text: string, label: string, choice: ModelChoice): string | null {
  const head = label.toLowerCase().split(' ').at(-1);
  const word = head === undefined || head === '' || choice.level !== 'fallback' ? undefined : new RegExp(`\\b${head}(?:e?s)?\\b`).exec(text)?.[0];
  if (word === undefined) return null;
  const tags = choice.entry?.identity ?? [];
  const drawn = (aliasName(choice.model) ?? FALLBACK_NAMES.find((name) => tags.includes(name)) ?? tags[0])?.replace(/-/g, ' ');
  const many = word !== head;
  const as = drawn === undefined ? '' : many ? ` – they're ${plural(drawn, 2)}` : ` – it's ${article(drawn)}`;
  return `The ${word} ${many ? "aren't" : "isn't"} here yet${as}.`;
}

/** Co věta jmenuje a hra kreslí jinak (P73A T5): postava bez modelu, pak místo; každá náhrada jedna věta. */
function standIns(sentence: string, spec: GameSpecV1): string[] {
  const text = sentence.toLowerCase();
  const player = spec.roles.find((role) => role.kind === 'player')?.label ?? '';
  const enemy = enemyLabel(spec);
  const said = [
    standInCharacter(text, player, heroChoice(player, spec.genre?.id, spec.control)),
    enemy === '' ? null : standInCharacter(text, enemy, heroChoice(enemy, undefined, spec.control, 'enemy')),
  ].filter((line): line is string => line !== null);
  const place = STAND_IN_PLACES.find(([cue]) => cue.test(text));
  if (place !== undefined) said.push(`${capital(place[1])} ${place[1].endsWith('s') ? "aren't" : "isn't"} here yet – it's ${lookName(lookOf(spec.theme))}.`);
  return said;
}

/** Přiznání slovesa (níž) a k němu každá náhrada postavy nebo místa; bez slovesa jde náhrada sama jako `actions`. */
async function measureHonesty(sentence: string, spec: GameSpecV1, seed: number, publishedWorld?: ArcadeWorld): Promise<Honesty | null> {
  const verbs = await verbHonesty(sentence, spec, seed, publishedWorld);
  const said = standIns(sentence, spec);
  if (said.length === 0) return verbs;
  if (verbs === null) return { kind: 'actions', closest: closestOf(spec), reason: said.join(' ') };
  // Hláška bez slovesa končí nápovědou („Try: ‘Dodge …’“) – náhrada jde před ni.
  return { ...verbs, reason: verbs.kind === 'no_verb' ? `${said.join(' ')} ${verbs.reason}` : `${verbs.reason} ${said.join(' ')}` };
}

async function verbHonesty(sentence: string, spec: GameSpecV1, seed: number, publishedWorld?: ArcadeWorld): Promise<Honesty | null> {
  // Hra je žánr věty: pruh se neukáže (zůstává jen třída, kterou neumíme vůbec – otevřený svět, idle …).
  if (playsOwnGenre(sentence, spec)) return unsupportedGame(sentence, spec);
  const read = extractIntent(sentence);
  // Let domyšlený jen ze jména lodi, kterou věta nechá střílet, skladatel nehraje (`impliedFlight`) – hláška ho nepřizná.
  const intent = { ...read, items: read.items.filter(item => !impliedFlight(read, item)) };
  const triples = essentialTriples(intent);
  await preloadPhysics(spec, loadRapier);
  const made = publishedWorld === undefined ? arcadeWorldOf(spec, seed) : { ok: true as const, world: publishedWorld, roleBindings: bindRoles(spec, publishedWorld) };
  // Svědek sondy průběhu má za aktéra chování („boss“, „swarm“): trojici potvrdí, jen když ho věta jmenuje (P46B R4: 4 sondy běžce ≈ 3 s).
  const pacingProbe = (binding: RoleBinding) => triples.some(triple => namesActor(triple, binding));
  // Přiznání čte jen svědky (sondy a vítězný běh); přehrání a nečinný hráč z `verifyArcade` by jen stály čas odpovědi.
  const runs = made.ok ? witnessRuns(made.world, undefined, made.roleBindings, { pacingProbe }) : null;
  const witnesses = runs === null ? [] : [...runs.bot.witnesses, ...runs.probes];
  // P71D T6: „find the lost crown“ čte záměr jako sběr; úkol tu jednu věc najde použitím (`interact` na ten předmět).
  const findsOne = spec.genre?.id === 'quest' && FIND_ONE.test(sentence.toLowerCase());
  // P73A R2: „stack books into a tower“ – stohování staví právě tu věž, kterou jmenuje cíl hry („of the tower“).
  const towers = new Set(spec.roles.filter(role => role.kind === 'exit').map(role => singular(role.label.toLowerCase()).split(' ').at(-1)));
  const met = (triple: IntentTriple, witness: (typeof witnesses)[number]) =>
    matchesWitness(triple, witness) || (findsOne && triple.verb === 'collect' && matchesWitness({ ...triple, verb: 'interact' }, witness))
    || (triple.verb === 'build' && towers.has(triple.object ?? '') && witness.verb === 'build' && witness.evidence === 'stack-completed');
  const unmet = triples.filter(triple => !witnesses.some(witness => met(triple, witness)));
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
  // P73A R1: sloveso cizího aktéra, které hra hraje hráčem („books fly at you“ hraje let na koštěti) – chybí aktér, ne
  // sloveso; „Gliding isn't here yet“ by si odporovalo s hrou. Aktér, kterého svět má, se dál přiznává slovesem.
  const bindings = made.ok ? made.roleBindings : [];
  const heroDoes = (triple: IntentTriple) => triple.actor !== 'hero' && witnesses.some(w => w.actor.player && w.verb === triple.verb) && !bindings.some(b => namesActor(triple, b));
  const text = sentence.toLowerCase();
  const pluralLabels = new Set(PLURAL_LABELS);
  const missing = [...new Set(unmet.map(triple => {
    const item = said(triple);
    if (heroDoes(triple)) {
      const word = intent.items.find(i => i.verb === triple.verb && i.actor === triple.actor && i.object === triple.object)?.said ?? triple.verb;
      const many = new RegExp(`\\b${plural(triple.actor, 2)}\\b`).test(text);
      const label = `the ${gerund(vocabVerb(word)?.lemma ?? word)} ${many ? plural(triple.actor, 2) : triple.actor}`;
      if (many) pluralLabels.add(label);
      return label;
    }
    // Kus bez popisku se jmenuje činností („Beating isn't here yet“), ne holým slovesem.
    return item === undefined ? (LABELS[triple.verb] ?? gerund(triple.verb)) : gerund(lemmaOf(item));
  }))];
  const closest = spec.control === 'steer' && !witnesses.some(w => w.verb === 'race') ? 'a driving game' : closestOf(spec);
  const are = missing.length > 1 || pluralLabels.has(missing[0]!);
  return { kind: 'actions', unmet, closest, reason: `${capital(listed(missing))} ${are ? "aren't" : "isn't"} here yet – here's ${closest}.` };
}

export async function sentenceOf(versions: Pick<VersionStore, 'get'>, game: PublishedGame): Promise<string | null> {
  if (game.origin !== undefined) return game.origin.sentence;
  if (game.sentence !== undefined) return game.sentence;
  if (game.relation !== 'upgrade' || game.version.parentId === null) return null;
  return (await versions.get(game.version.parentId))?.origin?.sentence ?? null;
}
