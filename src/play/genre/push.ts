/**
 * Žánr Vytlačování z ringu (P54C T12, sumo): hrdina výpadem vytlačí soupeře z kulatého ringu (ovládání `push`,
 * generátor `push_ring` v `arcade/pieces/push-ring.ts`, fyzika Rapier). Kdo se tlačí, je soupeř z obsazení
 * (`fight`, jinak `chase_me`/`shoot_at`/`avoid`; výchozí býk).
 *
 * Hloubka: `rivals` soupeřů (`COUNT_PARAMS.push.default.enemy`) ve třech kolech, ve třetím se ring zmenšuje;
 * 3 životy – každý vezme pád hrdiny z ringu. Hodiny `PUSH.seconds`.
 *
 * Věty sem vede klasifikátor (T13b, sloveso `push`: vystrčit soupeře z ringu, plošiny nebo kry; „sumo“) a skladba hraje
 * recept buňky `push.default` celý (`wholeGame`: akce `push` na pohybu `roam`); režisér ho nabízí od T14b.
 */

import { PUSH } from '../arcade/pieces/push-ring';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí soupeř, když ho věta nejmenuje. */
export const PUSH_DEFAULTS = { rival: 'bull' } as const;

/**
 * Soupeř bez jména („pushes rivals out“, „shove the opponents off“): v ringu se přetlačují stejní – soupeř je
 * hrdina věty (zápasník sumo proti zápasníkům sumo), ne model, který katalog najde pod slovem „rival“ (auto).
 */
const NAMELESS = /^(?:rival|opponent|enemy|foe|competitor|challenger|contender|other)s?$/;

/** Kdo se tlačí ven („pushes rivals out“, „shove the penguins off“, „knock bears out of the ring“). */
const PUSH_OBJECT = /\b(?:push|pushes|pushed|pushing|shove|shoves|shoved|shoving|knock|knocks|knocked|knocking|bump|bumps|bumped|bumping|throw|throws|throwing)\s+(?:the\s+|all\s+|other\s+|every\s+|some\s+)*([a-z][a-z -]*?)\s+(?:out|off)\b/;
/** „push it out“, „knock them off“ nejsou soupeř. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|everyone|everybody)$/;
/** Kdo se přetlačuje mezi sebou („sumo wrestlers push each other out“, P54C T13b): hrdina i soupeři jsou z nich. */
const EACH_OTHER = /^(?:two\s+|the\s+|some\s+|a\s+few\s+)?([a-z]+(?:\s+[a-z]+)?)\s+(?:push|shove|bump|knock|ram)\w*\s+(?:each other|one another)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const pushGenre: GenreModule<'push'> = {
  id: 'push',
  modes: ['default'],
  // Narážky žádné: věty k žánru vede klasifikátor jen se znakem žánru (T13b) – „push the cart to the top“ není ring.
  cues: [],
  heroClasses: ['animal', 'humanoid', 'robot', 'monster', 'vehicle'],
  // Méně soupeřů robot vystrčí pod 30 s (G1; T14br1, 20 semínek: 3 → 15,9 s, 6 → 29,1 s, 7–9 → 30,4–82,0 s).
  // Generátor dál postaví i 3 (`PUSH.rivals`), aby uložené hry šly otevřít; nová hra dostane jen tyhle meze.
  paramBounds: { rivals: { min: 7, max: PUSH.rivals.max } },
  availability: () => 'ready',
  compile: (spec) => {
    const rivals = spec.params?.rivals ?? PUSH.rivals.default;
    const named = castFor(spec, 'fight', 'chase_me', 'shoot_at', 'avoid')?.label;
    const rival = named === undefined ? PUSH_DEFAULTS.rival : NAMELESS.test(named) ? spec.hero : named;
    const many = plural(singular(rival), rivals);
    return legacySpec(spec, {
      control: 'push',
      controlParams: { generator: 'push_ring', ...(rivals === PUSH.rivals.default ? {} : { tuning: { rivals } }) },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Push`,
      objective: {
        kind: 'defeat_targets',
        description: fit(120, `Push ${String(rivals)} ${many} out of the ring in three rounds. Do not fall off yourself.`, `Push ${String(rivals)} ${many} out of the ring.`, 'Push every rival out of the ring.'),
        count: rivals,
        role: 'rival',
      },
      mechanics: [livesMechanic()],
      roles: [{ id: 'rival', kind: 'chaser', label: rival, count: rivals }],
      tutorial: {
        goalLine: fit(50, `Push every ${singular(rival)} out of the ring!`, 'Push them all out of the ring!'),
        controlsHint: 'Drag to move, tap to lunge. Arrows and Space work too.',
      },
      mood: 'playful',
      targetDurationSec: PUSH.seconds,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero: subject, setting, cast } = draftRoles(sentence, reading);
    const mutual = EACH_OTHER.exec(sentence.toLowerCase().trim())?.[1];
    const hero = mutual === undefined ? subject : singular(mutual);
    // Ring zná jen soupeře: každý nepřítel věty se tu přetlačuje, věci ke sběru nemají kde ležet.
    let roles = (cast ?? []).filter((item) => item.does !== 'collect' && item.does !== 'reach').map((item): CastItem => ({ ...item, does: 'fight' }));
    const found = PUSH_OBJECT.exec(sentence.toLowerCase());
    const phrase = found === null ? null : nounPhrase(found[1] as string);
    if (phrase !== null && !PRONOUN.test(phrase)) {
      const label = singular(phrase);
      roles = [{ label, does: 'fight' }, ...roles.filter((item) => item.label !== label)];
    }
    return {
      genre: 'push',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles.slice(0, 1) }),
    };
  },
};
