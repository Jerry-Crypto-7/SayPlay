/**
 * Žánr Střílečka (P36A T10): hrdina stojí, míří a střílí terče a vlny
 * nepřátel, kteří jdou k němu. Překládá na dnešní ovládání `shooter`
 * (střelnice `shooter_range`); scéna `components/play/arcade/shooter` ji
 * kreslí beze změny.
 *
 * Hloubka jako ostatní žánry: šest vln, každá rychlejší (`rise`), nepřátel ve
 * vlně z věty („shoot 5 zombies“), tři životy s milostí po zásahu a kombo
 * zásahů v řadě (`scoring` z `legacySpec`). Robot vyhraje za ~40 s, nečinný
 * hráč prohraje na první nebo druhé vlně.
 */

import { SHOOTER_WAVE_SIZE_MAX } from '../arcade/pieces/shooter';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Vln výchozí a v mezích (méně než 5 vln robot dohraje pod 30 s, víc než 6 spec nebere), zrychlení za vlnu (jednotek za tik). */
export const SHOOTER_GENRE = { waves: 6, minWaves: 5, maxWaves: 6, rise: 4 } as const;

/** Co se střílí: „shoots alien bugs“, „fire at the drones“, „blasting asteroids“. */
const AIM_CUE = /\b(?:shoot(?:s|ing)?|fir(?:e|es|ing) at|blast(?:s|ing)?|aim(?:s|ing)? at|snip(?:e|es|ing))(?: at| down)? (?:the |a |an |all |some |\d+ )?([a-z][a-z -]*)/;
/** „shoots arrows at goblins“, „shoot paint at robots“: střílí se na to, co je za „at“ – šíp a barva jsou nástroj. */
const AIMED_AT = /\b(?:shoot(?:s|ing)?|fir(?:e|es|ing)|launch(?:es|ing)?) (?:[a-z]+ ){1,2}?at (?:the |a |an |all |some |\d+ )?([a-z][a-z -]*)/;

export const shooterGenre: GenreModule<'shooter'> = {
  id: 'shooter',
  modes: ['default'],
  cues: ['shoot', 'shooter', 'blast', 'aim', 'sniper', 'gun', 'archery', 'bow'],
  // Hrdina stojí a střílí, takže jím může být i loď („a spaceship shooting asteroids“).
  heroClasses: ['animal', 'bird', 'robot', 'vehicle', 'boat', 'aircraft', 'humanoid', 'monster'],
  paramBounds: {
    waves: { min: SHOOTER_GENRE.minWaves, max: SHOOTER_GENRE.maxWaves },
    /** Nepřátel v jedné vlně (`counts.enemy`). */
    enemies: { min: 1, max: SHOOTER_WAVE_SIZE_MAX },
    /** Terčů, které stojí na střelnici (`counts.target`). */
    targets: { min: 1, max: 8 },
  },
  availability: () => 'ready',
  compile: (spec) => {
    // Nepřítel vln je první věc, do které věta střílí, pak nejbližší protivník; druhá střílená věc stojí na střelnici (P39).
    const shots = (spec.cast ?? []).filter((item) => item.does === 'shoot_at');
    const foe = shots[0] ?? castFor(spec, 'chase_me', 'fight', 'avoid');
    const enemy = foe?.label ?? 'invader';
    // Volné místo terče bere další věc z věty – sbíraná dřív než protivník (T14): „collect coins, dodge ghosts and shoot bats“
    // by jinak mince i duchy zahodilo a na střelnici stál holý terč.
    const rest = { cast: (spec.cast ?? []).filter((item) => item !== foe) };
    const target = (castFor(spec, 'throw_at', 'reach') ?? shots[1] ?? castFor(rest, 'collect', 'avoid', 'chase_me', 'fight'))?.label ?? 'target';
    const { waves = SHOOTER_GENRE.waves, enemies, targets } = spec.params ?? {};
    const foes = plural(singular(enemy), 2);
    return legacySpec(spec, {
      control: 'shooter',
      controlParams: { waves, rise: SHOOTER_GENRE.rise, ...(enemies === undefined ? {} : { waveSize: enemies }) },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Shootout`,
      objective: { kind: 'defeat_targets', description: `Stop ${String(waves)} waves of ${foes} before they reach you.`, count: waves, role: 'enemy' },
      // Nepřítel u hrdiny ubere život a chvíli další nebere (P36A T2).
      mechanics: [livesMechanic()],
      // Počet terčů čte generátor (`COUNTED_ROLES`); nepřítel počet nenese – celkový počet by přebil vlny.
      roles: [
        { id: 'target', kind: 'target', label: target, ...(targets === undefined ? {} : { count: targets }) },
        { id: 'enemy', kind: 'hazard', label: enemy },
      ],
      tutorial: { goalLine: `Stop ${String(waves)} waves of ${foes}. Each wave is faster.`, controlsHint: 'Tap where you aim to shoot. Arrows aim, Space fires.' },
      mood: 'tense',
    });
  },
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    const text = sentence.toLowerCase();
    const match = AIMED_AT.exec(text) ?? AIM_CUE.exec(text);
    const shot = match === null ? null : nounPhrase(match[1]!, 2);
    // Na co věta míří, je terč dřív než protivník ze čtení: draft bere z obsazení první věc každé role.
    const cast = [...(shot === null ? [] : [{ label: singular(shot), does: 'shoot_at' as const }]), ...(roles.cast ?? [])];
    return { genre: 'shooter', mode: 'default', ...roles, ...(cast.length === 0 ? {} : { cast }) };
  },
};
