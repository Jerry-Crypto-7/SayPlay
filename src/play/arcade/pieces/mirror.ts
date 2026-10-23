/**
 * Zrcadlo, mutátor řetězu (P56C T15): obal ovládání otočí vodorovnou osu (vlevo ↔ vpravo, osa × −1) uvnitř
 * jádra – záznam vstupů zůstává, co hráč stiskl, takže replay i Dare sedí. Robot zrcadla rozhoduje jako
 * robot pod ním a jeho rozhodnutí se zrcadlí zpět.
 */

import { z } from 'zod';

import { type ArcadeInput, BUTTON, type BotPiece, type ControlPiece } from '../contract';

const SIDES = BUTTON.LEFT | BUTTON.RIGHT;

/** Vlevo ↔ vpravo a osa × −1; obojí naráz zůstane obojím. Dvakrát zrcadlený vstup je původní. */
export function mirrorInput(input: ArcadeInput): ArcadeInput {
  const sides = input.buttons & SIDES;
  const flipped = sides === BUTTON.LEFT ? BUTTON.RIGHT : sides === BUTTON.RIGHT ? BUTTON.LEFT : sides;
  return { buttons: (input.buttons & ~SIDES) | flipped, axis: input.axis === 0 ? 0 : -input.axis };
}

const wrapped = z.object({ base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict() }).strict();
type Wrapped = z.infer<typeof wrapped>;

/** Parametry kusu pod obalem, přečtené jednou: obal běží každý tik (jako `paramsOf` v `addons.ts`). */
const parsed = new WeakMap<object, unknown>();
function paramsOf(piece: { readonly params: { parse(input: unknown): unknown } }, raw: Readonly<Record<string, unknown>>): unknown {
  if (!parsed.has(raw)) parsed.set(raw, piece.params.parse(raw));
  return parsed.get(raw);
}

function baseOf<P extends { readonly params: { parse(input: unknown): unknown } }>(pieces: Readonly<Record<string, P>>, params: Wrapped, kind: string): P {
  const piece = pieces[params.base.id];
  if (piece === undefined) throw new Error(`arcade: unknown ${kind} ${params.base.id}`);
  return piece;
}

export function makeMirrorControl(controls: Readonly<Record<string, ControlPiece>>): ControlPiece<Wrapped> {
  return {
    id: 'mirror_control',
    params: wrapped,
    roles: ['player'],
    cost: () => ({ bodies: 1, rules: 0 }),
    step: (state, player, input, params) => {
      const base = baseOf(controls, params, 'control');
      base.step(state, player, mirrorInput(input), paramsOf(base, params.base.params));
    },
  };
}

export function makeMirrorBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<Wrapped> {
  return {
    id: 'mirror_bot',
    params: wrapped,
    roles: ['player'],
    // Všichni základní roboti reagují s 8 tiky (`makeAddonBot`); obal musí vidět stejně staré stavy.
    reactionTicks: 8,
    cost: () => ({ bodies: 0, rules: 0 }),
    decide: (observation, params) => {
      const base = baseOf(bots, params, 'bot');
      // Robot pod obalem žije v nezrcadleném světě: i jeho nedávné vstupy dostane nezrcadlené.
      const decided = base.decide({ ...observation, recent: observation.recent.map(mirrorInput) }, paramsOf(base, params.base.params));
      return mirrorInput(decided);
    },
  };
}
