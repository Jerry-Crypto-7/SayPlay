import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
import { lookFor, sentenceLook, timeOfDayFor } from '../arcade/look';
import { rapierIfLoaded } from '../arcade/physics/world';
import { matchesWitness, namesActor, type ActionWitness, type RoleBinding } from '../arcade/witness';
import { draftChoiceOrder, draftGenreFor, heroFitsReading, readingFoe, readingHero } from '../draft/draft';
import { nounPhrase, singular, toolsOf } from '../draft/lexicon';
import { classifyGenre } from '../genre/classify';
import type { CastItem, GenreSpec } from '../genre/contract';
import { BALL_PLAYER, DEFAULT_LABELS, defaultCollectible, defaultFoe } from '../genre/roles';
import { essentialTriples, type Intent, type IntentTriple } from '../intent/contract';
import type { GameSpecV1 } from '../spec';
import type { Reading } from '../read/schema';
import { assemble, genreSource, sourceFor, unplayed, wholeGame, type AssemblySource } from './assemble';
import type { TemplateName } from '../arcade/rules/templates';
import { compileTemplated, withoutPartNames } from './compile';
import { namedProjectiles } from './projectiles';
import { PRESETS, type RecipeAssembly } from './presets';

/** Roles that threaten or are hit – the critic's `HOSTILE`: a thrown thing never plays them. */
const HOSTILE: ReadonlySet<CastItem['does']> = new Set<CastItem['does']>(['shoot_at', 'chase_me', 'avoid', 'fight']);

export interface Composition {
  readonly cellId: string;
  readonly recipe: RecipeAssembly;
  readonly spec: GameSpecV1;
  readonly unmet: readonly IntentTriple[];
  readonly witnesses: readonly ActionWitness[];
  readonly issues: readonly string[];
  /** Šablona pravidel, se kterou hra prošla (P45B T9); `null` = hraje bez ní. */
  readonly template: TemplateName | null;
}

// Repeated publication of the same sentence must not replay identical worlds
// on every request. Bounded and keyed by every input; callers get owned copies.
// Whether Rapier is loaded is an input too: without it a physics source fails and
// another game wins, which must not outlive the load (P56C T17e review).
const compositions = new Map<string, Composition>();

/** Hrdina, kterého věta jmenuje; se čtením jen ten, kterého čtení nemá za protivníka, věc ani místo (P56A T6). */
const namedHero = (intent: Intent, reading: Reading | null): string | null =>
  intent.hero !== null && (reading === null || heroFitsReading(intent.hero, reading, intent.sentence)) ? intent.hero : null;

function contentOf(intent: Intent, cell: AssemblySource, reading: Reading | null): GenreSpec {
  const draft = draftGenreFor(intent.sentence, cell.preset.genre, cell.preset.mode, { reading }) ?? cell.preset;
  const words = (intent.sentence.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map(singular);
  // A setting category selects the scenery, but must not rename an explicitly
  // supplied place (a laboratory is not a factory; a snowy mountain is not snow).
  const text = intent.sentence.toLowerCase();
  const namedPlace = draft.setting.toLowerCase();
  const explicitlyNamed = new RegExp(`\\b${namedPlace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  const placeHead = (place: string) => singular(place.replace(/\s+at\s+(?:night|dawn|dusk|noon|sunset|sunrise)$/, '')).split(' ').at(-1);
  // Preserve descriptive modifiers only for the same place. A draft phrase
  // elsewhere in the sentence must not override the parsed locative argument.
  const samePlace = intent.setting !== null && placeHead(namedPlace) === placeHead(intent.setting);
  // A scenery category the sentence never says (classroom → school) is no parsed place.
  const categoryOnly = intent.setting !== null && !words.includes(singular(intent.setting));
  const place = intent.setting === null || explicitlyNamed && (samePlace || categoryOnly) ? draft.setting : text.includes(`burning ${intent.setting}`) ? `burning ${intent.setting}` : intent.setting;
  const time = timeOfDayFor(intent.sentence);
  const setting = time !== null && place !== time && timeOfDayFor(place) === null ? `${place} at ${time}` : place;
  const cast: CastItem[] = (draft.cast ?? []).map(item => {
    if (setting === draft.setting || !DEFAULT_LABELS.has(item.label) || words.includes(singular(item.label.split(' ').at(-1)!))) return item;
    if (item.does === 'collect') return { ...item, label: defaultCollectible(setting) };
    if (['chase_me', 'avoid', 'fight', 'shoot_at', 'throw_at'].includes(item.does)) return { ...item, label: defaultFoe(setting, draft.genre, item.does).label };
    return item;
  });
  if (wholeGame(cell.recipe)) {
    // P54C T13: a lanes genre (T13b: every whole-game genre) reads its own roles (`draftFill`: what falls, pops up,
    // marches or flies); the intent's verbs name another game's roles there – its `catch` is a chase prey, a bear
    // catching jars would turn into a hazard.
    const palette = draft.palette ?? (lookFor(setting) === null ? (sentenceLook(intent.sentence) ?? undefined) : undefined);
    return { ...draft, setting, ...(palette === undefined ? {} : { palette }), cast: cast.slice(0, 8) };
  }
  const spoken: string[] = [];
  const sentenceHeads = (intent.sentence.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map(singular);
  const head = (label: string): string => singular(label.toLowerCase()).split(' ').at(-1) ?? label;
  const projectiles = namedProjectiles(intent.sentence).filter(projectile => intent.items.some(item =>
    item.essential && item.verb === 'shoot' && (item.actor === intent.hero || item.actor === 'hero') &&
    (item.object === null || head(item.object) === head(projectile.target ?? projectile.label))));
  const firedWithoutTarget = (label: string) => projectiles.some(projectile => projectile.target === null && head(projectile.label) === head(label));
  const ammoWithoutTargetRequest = (label: string) => projectiles.some(projectile => head(projectile.label) === head(label)) &&
    (firedWithoutTarget(label) || !intent.items.some(item => item.essential && item.verb === 'shoot' && item.object !== null && head(item.object) === head(label)));
  // Ammo is an item carried by the actual projectile, never an enemy renamed
  // after a rocket. Older genre drafting conflates these two argument roles.
  // „fires fireballs at ogres“ čte návrh i jako sbírání koulí; bez slovesa sbírání je to jen munice.
  const collectRequested = (label: string) => intent.items.some(item => item.verb === 'collect' && item.object !== null && head(item.object) === head(label));
  for (let index = cast.length - 1; index >= 0; index--) {
    const { does, label } = cast[index];
    if ((does === 'shoot_at' || (does === 'collect' && !collectRequested(label))) && ammoWithoutTargetRequest(label)) cast.splice(index, 1);
  }
  for (const fallback of cell.preset.cast ?? []) {
    const roles = draft.genre === 'arena' && fallback.does === 'chase_me'
      ? ['chase_me', 'avoid', 'fight', 'shoot_at', 'throw_at'] : [fallback.does];
    if (!cast.some(item => roles.includes(item.does))) cast.push({ ...fallback, label: fallback.does === 'collect' ? defaultCollectible(setting) : ['chase_me', 'avoid', 'fight', 'shoot_at', 'throw_at'].includes(fallback.does) ? defaultFoe(setting, draft.genre, fallback.does).label : fallback.label });
  }
  const put = (label: string, does: CastItem['does']): void => {
    if (label === 'hero') return;
    const matches = cast.filter(item => head(item.label) === head(label));
    const named = matches[0]?.label ?? label;
    // Legacy placeholders may assign the same default noun several behaviours.
    // Explicit sentence roles replace those defaults, while two explicit roles
    // for one noun (shoot and dodge it) remain distinct.
    if (!spoken.some(item => head(item) === head(label))) {
      for (let index = cast.length - 1; index >= 0; index--) if (head(cast[index].label) === head(label)) cast.splice(index, 1);
    }
    if (!cast.some(item => head(item.label) === head(label) && item.does === does)) cast.push({ ...matches[0], label: named, does });
    spoken.push(named);
  };
  for (const item of intent.items) {
    if (!item.essential) continue;
    if (item.axis === 'threat') {
      // Implied traffic/watchers express a requirement, not a named character.
      // Keep the setting's existing cast; unmatched identities stay unmet.
      if (!sentenceHeads.includes(head(item.actor))) continue;
      if (item.verb === 'chaser' || item.verb === 'guard') put(item.actor, 'chase_me');
      else if (item.verb === 'rival') put(item.actor, 'fight');
      else put(item.actor, 'avoid');
    } else if (item.object !== null && (item.actor === intent.hero || item.actor === 'hero')) {
      // The cargo remains visible as a destination when this recipe cannot
      // carry it. That never certifies delivery: its triple still needs a witness.
      const roles: Partial<Record<string, CastItem['does']>> = { shoot: 'shoot_at', throw: 'throw_at', collect: 'collect', fight: 'fight', duel: 'fight', catch: 'fight', reach: 'reach', land: 'reach', interact: 'reach', deliver: 'reach' };
      if (item.verb === 'throw' && item.object === 'ball' && sentenceHeads.includes('basketball')) {
        // A sports ball is the thrown object, never the thing thrown at.
        if (!cast.some(member => member.label === 'basketball')) cast.push({ label: 'basketball', does: 'scenery', verb: 'throw' });
        continue;
      }
      const does = roles[item.verb];
      if (item.verb === 'shoot' && firedWithoutTarget(item.object)) continue;
      // P58A T7r1: what the sentence throws is no foe – „toss a pancake and catch it“ catches the ammunition (critic B-R12).
      const object = item.object;
      if (does !== undefined && HOSTILE.has(does) && toolsOf(intent.sentence).some(tool => head(tool) === head(object))) continue;
      if (does !== undefined) put(item.object, does);
      else if (item.axis === 'unknown' && /^(?:sweep|mop)$/.test(item.verb) && draft.genre === 'arena' && draft.mode === 'collect' && draft.heroAction === 'sweep') {
        // Retain the surface named by a cleaning request in its established
        // collection stand-in. Picking up that surface never proves cleaning.
        const at = intent.sentence.toLowerCase().indexOf(item.said);
        const phrase = at < 0 ? null : nounPhrase(intent.sentence.slice(at + item.said.length));
        put(phrase !== null && head(phrase) === item.object ? singular(phrase) : item.object, 'collect');
      }
    }
  }
  // P58A T6: a fight's rival is the foe the reading names („one crocodile“); the verb's object from the words
  // („trades blows“, „punch him back“, „brawls on the sand“) is no rival.
  const rival = reading !== null && (draft.genre === 'duel' || (draft.genre === 'arena' && draft.mode === 'fight')) ? readingFoe(reading) : null;
  if (rival !== null) {
    for (let index = cast.length - 1; index >= 0; index--) if (cast[index].does === 'fight' || head(cast[index].label) === head(rival)) cast.splice(index, 1);
    cast.unshift({ label: singular(rival), does: 'fight' });
    spoken.unshift(singular(rival));
  }
  if (projectiles.length > 0) {
    // The moving controls' shooting addon needs a target even when the request
    // only names ammunition. That default target keeps its own identity.
    if (!cast.some(member => member.does === 'shoot_at')) cast.push({ label: defaultFoe(setting, draft.genre, 'shoot_at').label, does: 'shoot_at' });
    for (const projectile of projectiles) {
      cast.push({ label: projectile.label, does: 'scenery', verb: 'shoot' });
      spoken.push(projectile.label);
    }
  }
  const thrown = /\bthrow(?:s|ing)? (?:a |an |the |some )?([a-z][a-z -]*)/i.exec(intent.sentence);
  const ammunition = thrown === null ? null : nounPhrase(thrown[1]);
  if (draft.genre === 'throw' && ammunition !== null && /(?:ball|snowball|basketball|rock|stone|pizza|pie)$/.test(head(ammunition))) {
    for (let index = 0; index < cast.length; index++) if (cast[index].verb === 'throw' && cast[index].does === 'scenery') cast[index] = { ...cast[index], verb: undefined };
    const label = singular(ammunition);
    const existing = cast.findIndex(item => head(item.label) === head(label));
    if (existing < 0) cast.push({ label, does: 'scenery', verb: 'throw' });
    else if (cast[existing].does === 'scenery') cast[existing] = { ...cast[existing], verb: 'throw' };
  }
  if (cell.recipe.move === 'ball') {
    const basketball = /\b(?:basketball|hoops?)\b/.test(intent.sentence.toLowerCase());
    const golf = /\b(?:golf|putt(?:ing)?)\b/.test(intent.sentence.toLowerCase());
    const racket = /\b(?:table tennis|tennis|ping[ -]?pong)\b/.test(intent.sentence.toLowerCase());
    // A named hero that rolls („a hedgehog rolling down a hill“) reads as the ball
    // movement. With no ball, sport or goal in the sentence the hero is the rolled
    // body: no football and no goal. The target is a thing the sentence names, else
    // the contract's neutral „target“ (the pitch needs one to score into).
    const roller = basketball || golf || racket || /\b(?:balls?|football|soccer|goals?|penalty kicks?)\b/.test(intent.sentence.toLowerCase()) ? undefined
      : intent.items.find(item => item.essential && item.verb === 'ball' && /^roll/.test(item.said) && item.actor === intent.hero);
    const namedTarget = roller === undefined ? undefined
      : cast.find(member => member.does === 'scenery' && head(member.label) !== roller.actor && sentenceHeads.includes(head(member.label)))?.label;
    // Legacy throw content has environmental scenery/targets (e.g. bees in a
    // park). Those cannot replace a sports ball and its physical goal.
    for (let index = cast.length - 1; index >= 0; index--) {
      const member = cast[index];
      if (member.does === 'scenery' && !/\b(?:ball|football|basketball)\b/.test(member.label)) { cast.splice(index, 1); continue; }
      if (['scenery', 'throw_at', 'fight'].includes(member.does) && !spoken.includes(member.label) && !sentenceHeads.includes(head(member.label))) cast.splice(index, 1);
    }
    if (roller !== undefined) cast.push({ label: roller.actor, does: 'scenery', verb: 'throw' });
    else if (!cast.some(member => member.does === 'scenery' && /(?:ball|football|basketball)$/.test(member.label))) cast.push({ label: racket ? 'ball' : basketball ? 'basketball' : golf ? 'golf ball' : 'football', does: 'scenery', verb: 'throw' });
    if (!cast.some(member => member.does === 'throw_at')) cast.push({ label: cell.recipe.objective === 'defeat' ? 'pin' : roller !== undefined ? namedTarget ?? 'target' : racket ? 'target' : basketball ? 'hoop' : golf ? 'hole' : 'goal', does: 'throw_at' });
    if (cell.recipe.threats.includes('rival') && !cast.some(member => member.does === 'fight')) cast.push({ label: 'goalkeeper', does: 'fight' });
  }
  const removed = new Set(intent.negated);
  const track = draft.genre === 'runner' || draft.genre === 'platformer';
  const allowedCast = cast.filter(item =>
    !/^(?:top-down|side-scrolling|first-person|third-person|twin-stick)$/.test(item.label) &&
    !(item.does === 'collect' && removed.has('collect')) &&
    !(item.does === 'shoot_at' && (removed.has('shoot') || track && !cell.recipe.actions.includes('shoot'))) &&
    !(item.does === 'chase_me' && (removed.has('chaser') || track && !cell.recipe.threats.includes('chaser'))));
  allowedCast.sort((a, b) => Number(spoken.includes(b.label)) - Number(spoken.includes(a.label)));
  const draftedAt = words.indexOf(head(draft.hero));
  const intendedAt = intent.hero === null ? -1 : words.indexOf(intent.hero);
  // A later subordinate actor must not erase an earlier, explicitly named
  // protagonist. Explicit player bindings such as "as a frog" still win.
  const explicitPlayer = /\b(?:as|you are|you're|i am|i'm|you control) (?:a |an |the )?/.test(intent.sentence.toLowerCase());
  const keepNamedHero = !explicitPlayer && draftedAt >= 0 && intendedAt > draftedAt &&
    intent.items.some(item => item.essential && item.axis !== 'threat' && item.actor === head(draft.hero));
  // P56A T6: hrdina slov, kterého čtení má za protivníka, věc nebo místo, návrh nepřepíše; míč jen bez hrdiny slov i čtení.
  const named = namedHero(intent, reading);
  const ball = cell.recipe.move === 'ball' && named === null && (reading === null || readingHero(reading) === null);
  const hero = ball ? BALL_PLAYER : named !== null && head(draft.hero) !== named && !keepNamedHero ? named : draft.hero;
  const landingTarget = cell.recipe.objective === 'land' && intent.items.some(item => item.essential && item.verb === 'land' && item.object !== null);
  // Místo, které sady neznají („a supermarket Roomba“ dá místo `roomba`), vezme sadu ze slov věty jako
  // návrh žánru – scéna i překážka trati pak patří do supermarketu (P46D T6).
  const palette = draft.palette ?? (lookFor(setting) === null ? (sentenceLook(intent.sentence) ?? undefined) : undefined);
  return { ...draft, hero, setting, ...(palette === undefined ? {} : { palette }), cast: allowedCast.slice(0, 8), ...(landingTarget ? { params: { ...draft.params, namedLandingTarget: 1 } } : {}) };
}

export function compose(intent: Intent, seed = 1, reading: Reading | null = null): Composition {
  const cacheKey = JSON.stringify([intent, seed, reading, rapierIfLoaded() !== null]);
  const cached = compositions.get(cacheKey);
  if (cached !== undefined) return structuredClone(cached);
  const classified = classifyGenre(intent.sentence, reading);
  // Preserve the established absurd-transfer fallback only when there is no
  // known essential mechanic to prioritize. Unknown requests remain unmet.
  const hasKnownAction = intent.items.some(item => item.essential && item.axis !== 'unknown');
  const ranking = hasKnownAction ? classified.ranked : draftChoiceOrder(intent.sentence, classified, reading);
  const issues: string[] = [];
  const attempted = new Set<string>();
  const triples = essentialTriples(intent);
  // Svědka sondy průběhu („boss“, „swarm“) čte jen trojice, která ho jmenuje; ostatní sondy jsou celé běhy robota navíc (P46B R4).
  const pacingProbe = (binding: RoleBinding) => triples.some(triple => namesActor(triple, binding));
  // A reading whose movement cannot play a requested action yields to a later reading
  // that can ("collect and shoot" is no shooting gallery); ties keep the rank.
  const sources = ranking.flatMap((choice, rank) => {
    // Liška jen nouzově (P56A T6): věta přečtená čtečkou bez hrdiny dostane průzkumníka.
    const hero = reading === null ? (intent.hero ?? 'fox') : (namedHero(intent, reading) ?? readingHero(reading) ?? 'explorer');
    const fallback = { genre: choice.genre, mode: choice.mode, hero, setting: intent.setting ?? 'forest' } as GenreSpec;
    // P54C T13: a lanes genre the classifier heard and put first plays its own recipe; anywhere else it is read as before.
    const source = (rank === 0 && choice.score > 0 ? genreSource(fallback) : null) ?? sourceFor(intent, fallback);
    const entry = { source, rank, missing: unplayed(source), decided: false };
    if (!classified.decided || choice !== classified.ranked[0]) return [entry];
    // P58B T5a: the genre the reading decided goes first, before `missing` ranks the rest; where the sentence's
    // movement or action recast it (a duel's "punch" is the arena fight), first as its own recipe, then as recast.
    const recipe = PRESETS[`${choice.genre}.${choice.mode}`]!;
    const own: AssemblySource | null = source.preset.genre === choice.genre && source.preset.mode === choice.mode ? null
      : { id: `assembled.${recipe.move}`, recipe, preset: fallback, assembly: 'native' };
    return own === null ? [{ ...entry, decided: true }] : [{ source: own, rank, missing: unplayed(own), decided: true }, entry];
  }).sort((a, b) => Number(b.decided) - Number(a.decided) || a.missing - b.missing || a.rank - b.rank);
  for (const { source } of sources) {
    const requested = assemble(intent, source, contentOf(intent, source, reading));
    // A failed combination is reduced one independent part at a time. Every
    // removed/unproved triple is still included in the public admission.
    for (let count = requested.parts?.length ?? 0; count >= 0; count--) {
      // A dropped part's thing does not come back as a base-genre role (a tossed pancake is no throw target).
      const recipe = { ...requested, parts: requested.parts?.slice(0, count), content: withoutPartNames(requested.content, requested.parts?.slice(count) ?? [], true) };
      // Šablona pravidel (P45B T9) jde první; neprojde-li, tentýž recept bez ní – teprve potom méně dílů.
      const { intent: _intent, ...untemplated } = recipe;
      // Akce hrdiny (P46A T8), které robot neprokáže, ustoupí dřív než díly: věta nesmí kvůli tlačítku spadnout.
      // Po šabloně nejdřív jen akce, kterou robot nedokázal (P47B T7), teprve pak všechny.
      const { abilities: _abilities, ...plain } = untemplated;
      const unproved = new Set<string>();
      const provable = (): RecipeAssembly => ({
        ...untemplated,
        abilities: untemplated.abilities?.filter(id => !unproved.has(id)),
        content: { ...untemplated.content, abilities: untemplated.content.abilities?.filter(id => !unproved.has(id)) },
      });
      for (const attempt of [() => recipe, () => untemplated, provable, () => plain]) {
        try {
          const candidate = attempt();
          const { spec, template } = compileTemplated(candidate);
          const key = JSON.stringify(spec);
          if (attempted.has(key)) continue;
          attempted.add(key);
          const label = template === null ? source.id : `${source.id} + template ${template}`;
          const made = arcadeWorldOf(spec, seed);
          if (!made.ok) { issues.push(`${label}: ${made.issues.join('; ')}`); continue; }
          const verdict = verifyArcade(made.world, undefined, made.roleBindings, { pacingProbe });
          if (!verdict.publishEligible) {
            for (const proof of verdict.verbs) if (!proof.fired || !proof.changed) unproved.add(proof.verb);
            issues.push(`${label}: ${verdict.failures.join('; ')}`);
            continue;
          }
          const witnesses = verdict.witnesses;
          const unmet = triples.filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));
          // Bez šablony recept záměr nenese: `compileRecipe(composition.recipe)` (rychlý návrh) postaví tutéž hru.
          // Recept je ten pokus, který prošel (i bez akcí), jen bez záměru, když šablonu nedostal.
          const bare = candidate === recipe ? untemplated : candidate;
          const composition = { cellId: source.id, recipe: template === null ? bare : candidate, spec, unmet, witnesses, issues, template };
          if (compositions.size >= 64) compositions.delete(compositions.keys().next().value!);
          compositions.set(cacheKey, structuredClone(composition));
          return composition;
        } catch (error) {
          issues.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  throw new Error(`No playable assembly: ${issues.join('; ')}`);
}
