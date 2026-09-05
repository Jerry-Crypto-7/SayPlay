/**
 * Sklad uvařených světů.
 *
 * ⚠ **Oracle téhle sady je `runGeneration()`, ne tvar JSONu.** Sklad má jediný
 * smysl: vydat odpověď, se kterou serverová cesta dojede až do fáze `world`.
 * Test, který jen přečte soubor a spočítá klíče, by prošel i nad emisí, kterou
 * `compileBlueprint()` odmítne — a to je přesně případ, kvůli kterému sklad
 * existuje.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildIntentRequest } from '@/model/worldstream-intent';
import { buildCompilerRequest } from '@/model/worldstream-prompt';
import { frozenGrammar } from '@/model/client';

import {
  AUTHORED_STORE,
  authoredEmitter,
  chooseAuthored,
  type AuthoredWorld,
} from '../authored';
import { clearSessions, openSession, runGeneration, serverGrammar } from '../sessions';

const KNOWN = AUTHORED_STORE.worlds[0];
if (KNOWN === undefined) throw new Error('sklad je prázdný — sada nemá co měřit');

function grammar() {
  const read = frozenGrammar();
  if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
  return read.value;
}

beforeEach(() => {
  clearSessions();
});

/* ================================================================== *
 * 1. Celá cesta, protože jen ta odpovídá na otázku, k čemu sklad je.
 * ================================================================== */

describe('an authored world goes down the same path a live emission does', () => {
  it('drives a real session to the world phase', async () => {
    const emit = authoredEmitter(KNOWN.prompt);
    expect(emit).not.toBeNull();

    const stored = openSession('authored-happy', 4021)!;
    const seen: string[] = [];
    await runGeneration(stored, KNOWN.prompt, {
      emit: emit!,
      grammar: serverGrammar() as ReturnType<typeof grammar>,
      log: (fault, detail) => seen.push(`${fault}: ${detail}`),
    });

    expect(seen).toEqual([]);
    expect(stored.session.phase).toBe('world');
  });

  it('ends the session the way a broken live emission would, not silently', async () => {
    // Break-it-on-purpose: sklad, jehož compiler emise je próza. Kdyby ji sklad
    // pustil dál bez následku, demo by ukazovalo svět, který branami neprošel.
    const broken: AuthoredWorld = { ...KNOWN, compiler: { geometry: 'a cathedral, obviously' } };
    const emit = authoredEmitter(KNOWN.prompt, [broken]);

    const stored = openSession('authored-broken', 4021)!;
    const seen: string[] = [];
    await runGeneration(stored, KNOWN.prompt, {
      emit: emit!,
      grammar: serverGrammar() as ReturnType<typeof grammar>,
      log: (fault, detail) => seen.push(`${fault}: ${detail}`),
    });

    expect(stored.session.phase).toBe('failed');
    expect(seen[0]).toMatch(/^BLUEPRINT_REJECTED: /);
  });
});

/* ================================================================== *
 * 2. Kdy sklad říká „není z čeho".
 * ================================================================== */

describe('the store says when it has nothing', () => {
  it('is null on an empty store, not an emitter that answers with nothing', () => {
    // Prázdná emise by se tvářila jako odpověď modelu a relace by skončila
    // odmítnutím, které volajícímu nic neřekne. `null` je informace.
    expect(authoredEmitter(KNOWN.prompt, [])).toBeNull();
    expect(chooseAuthored(KNOWN.prompt, [])).toBeNull();
  });

  it('is null for a sentence nobody authored, because a stranger world needs a label', () => {
    // `T43` tenhle případ převezme a vydá nejbližší svět **s popiskem, že je
    // nejbližší**. Do té doby je nevydat nic poctivější než vydat cizí svět tiše.
    expect(authoredEmitter('A lighthouse on a cliff above a storm-lit harbour')).toBeNull();
  });

  it('matches a sentence through punctuation and case, which a person will get wrong', () => {
    expect(chooseAuthored(`  ${KNOWN.prompt.toUpperCase().replace(/\.$/, '')}  `)?.id).toBe(
      KNOWN.id,
    );
  });
});

/* ================================================================== *
 * 3. Která emise na který požadavek — a NIKDY podle pořadí.
 * ================================================================== */

describe('the store answers the stage that asked, not the call that came first', () => {
  it('hands the planner answer to the planner request', async () => {
    const emit = authoredEmitter(KNOWN.prompt)!;
    const answer = (await emit(buildIntentRequest(KNOWN.prompt))) as Record<string, unknown>;

    expect(Object.keys(answer).sort()).toEqual(['intent', 'objects']);
  });

  it('hands the compiler answer to every compiler request, repair rounds included', async () => {
    // ⚠ **Tohle je celý důvod, proč se nerozlišuje podle pořadí.** Spike
    // z 5. 9. 2026 poslal na jednu větu čtyři požadavky: planner, compiler,
    // compiler, compiler. Pravidlo „druhé volání je compiler" by třetímu
    // a čtvrtému vydalo plán a smyčka by opravovala nesmysl.
    const emit = authoredEmitter(KNOWN.prompt)!;
    const plan = (await emit(buildIntentRequest(KNOWN.prompt))) as Parameters<
      typeof buildCompilerRequest
    >[0];
    const request = buildCompilerRequest(plan, grammar());

    for (let round = 0; round < 3; round += 1) {
      const answer = (await emit(request)) as Record<string, unknown>;
      expect(Object.keys(answer).sort()).toEqual(['geometry', 'placements', 'shapes', 'world']);
    }
  });

  it('refuses a request from neither stage instead of guessing', async () => {
    const emit = authoredEmitter(KNOWN.prompt)!;

    await expect(
      emit({ model: 'whatever', system: 'no stage claims this', user: '' }),
    ).rejects.toThrow(/does not recognise/);
  });
});
