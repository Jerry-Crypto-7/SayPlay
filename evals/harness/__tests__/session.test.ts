/**
 * Tříúpravová relace (T19) — dokázaná **bez jediného placeného volání.**
 *
 * Poskytovatel i prohlížeč jsou tu double; skutečné je všechno ostatní — router,
 * commit, verifikátor svědka, scorer i zmrazené kontrakty. Na síť zbývá jenom
 * samotný HTTP požadavek, a ten měří `e2e/three-edit-session.spec.ts`.
 *
 * Sada cílí na tři vlastnosti, které se **nedají odvodit z jednotahového měření**
 * a kvůli kterým tenhle harness existuje:
 *
 * 1. druhý tah se ptá na svět **po** prvním, ne na základní;
 * 2. tichý no-op je selhání tahu, i když scorer strukturálně projde;
 * 3. úspěšnost relace se měří, nedopočítává z tahů.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { UpstreamRequest } from '../../../src/model/prompt';
import type { WorldDoc } from '../../../src/ir/worlddoc';
import { verifyWitness, type VerifiableWorld } from '../../../src/verify/witness';
import { loadContracts, type Contract } from '../../scorer/semantic';
import { frozenResponses, stageHash, validateEmission, type Transport } from '../chain';
import { PreflightError, type LiveCompletion, type ProviderTransport } from '../live';
import type { Env } from '../preflight';
import { TURNS_PER_SESSION, editSessions, preservationOf, runEditSessions, sessionPassed } from '../session';

/** Předplatné: bez klíče, strop v počtu volání. Vývojový profil, viz preflight. */
const SUBSCRIPTION: Env = { EVAL_MODEL: 'gpt-5.6-sol@proxy', EVAL_CALL_CAP: '12' };

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'edit-session-'));

const contractOf = (id: string): Contract => {
  const found = loadContracts().find((contract) => contract.id === id);
  if (found === undefined) throw new Error(`fixture je rozbitá: kontrakt ${id} v korpusu není`);
  return found;
};

/** Sealed dokument základního světa — týmž kódem, jakým ho vydává `/api/emit`. */
function baseDoc(promptId: string): WorldDoc {
  const frozen = frozenResponses().find((entry) => entry.forPrompt === promptId && entry.branch === 'create');
  if (frozen === undefined) throw new Error(`fixture je rozbitá: create odpověď ${promptId} v korpusu není`);
  const validated = validateEmission(frozen.body);
  if (validated.doc === null) throw new Error(`fixture je rozbitá: ${promptId} nevydal dokument (${validated.reason})`);
  return validated.doc;
}

function fakeTransport(doc: WorldDoc | null): Transport & { readonly posted: unknown[] } {
  const posted: unknown[] = [];
  return {
    posted,
    post: async (path, data) => {
      posted.push({ path, data });
      return doc === null ? { status: 503, body: {} } : { status: 200, body: { doc } };
    },
    replay: async (world, witness) => verifyWitness(world as VerifiableWorld, witness as never),
  };
}

/**
 * Doprava, která vydává předepsané patche a **pamatuje si, co dostala**.
 *
 * Zapamatované požadavky jsou jediný způsob, jak dokázat, že se druhý tah ptal na
 * jiný svět než první — což je celá relace.
 */
function patchProvider(patches: readonly unknown[]): ProviderTransport & { readonly sent: UpstreamRequest[] } {
  const sent: UpstreamRequest[] = [];
  return {
    sent,
    complete: async (request): Promise<LiveCompletion> => {
      const body = patches[Math.min(sent.length, patches.length - 1)];
      sent.push(request);
      return {
        raw: { id: `resp_${sent.length}`, content: [{ type: 'text', text: JSON.stringify(body) }] },
        text: JSON.stringify(body),
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };
}

// C02: layout se dvěma sokety, jeden časovač `flood` (1200 tiků), čtyři pravidla.
const SLOWER_FLOOD = [{ op: 'replace', path: '/sim/state/timers/flood/durationTicks', value: 2400 }];
const RESTORE_FLOOD = [{ op: 'replace', path: '/sim/state/timers/flood/durationTicks', value: 1200 }];
/** Přidá vlajku, kterou nečte žádné pravidlo — diffem se hne, během ne. */
const DECORATIVE_FLAG = [{ op: 'add', path: '/sim/state/flags/decorative', value: false }];
/**
 * Pravidlo, které kontrakt `E10` splní do písmene a **nikdy nespustí**.
 *
 * Čeká na `use` nad entitou `pump`, a tu nedělá ani svědek, ani prázdná stopa.
 * Přesně ten tvar, kvůli kterému strukturální `notNoOp` nestačí: dokument se
 * hnul, kontrakt sedí, běh je bit po bitu tentýž.
 */
const DEAD_RULE = [
  { op: 'add', path: '/sim/entities/pump', value: { role: 'prop', socket: 'valve', state: 'idle' } },
  { op: 'add', path: '/sim/collisionAabb/pump', value: [9, 2, 1, 1] },
  {
    op: 'add',
    path: '/sim/rules/pump',
    value: {
      id: 'pump',
      phase: 1,
      priority: 1,
      event: { kind: 'onAction', actionId: 'use', target: 'pump' },
      condition: null,
      actions: [{ kind: 'startTimer', ref: 'flood' }],
    },
  },
];

const run = (patches: readonly unknown[], env: Env = SUBSCRIPTION) => {
  const provider = patchProvider(patches);
  const transport = fakeTransport(baseDoc('C02'));
  return {
    provider,
    transport,
    report: runEditSessions({ env, provider, transport, baseWorlds: ['C02'], root: tempRoot() }),
  };
};

describe('editSessions — výběr relací ze zmrazené sady', () => {
  it('bere každý svět, který unese tři úpravy, a bere je v pevném pořadí', () => {
    const plans = editSessions();
    expect(plans.map((plan) => plan.baseWorld)).toEqual(['C01', 'C02', 'C03', 'C09']);
    for (const plan of plans) expect(plan.prompts, plan.baseWorld).toHaveLength(TURNS_PER_SESSION);
    expect(plans.find((plan) => plan.baseWorld === 'C02')!.prompts.map((prompt) => prompt.id)).toEqual([
      'E01',
      'E10',
      'E19',
    ]);
  });

  it('je deterministické — dvě volání dají tentýž plán', () => {
    expect(stageHash(editSessions())).toBe(stageHash(editSessions()));
  });
});

describe('runEditSessions — rozpočet stojí před voláním', () => {
  it('bez stropu počtu volání se poskytovatel nezavolá ANI JEDNOU', async () => {
    const provider = patchProvider([SLOWER_FLOOD]);
    await expect(
      runEditSessions({
        env: { EVAL_MODEL: 'gpt-5.6-sol@proxy' },
        provider,
        transport: fakeTransport(baseDoc('C02')),
        root: tempRoot(),
      }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(provider.sent, 'preflight selhal a přesto se volalo').toHaveLength(0);
  });

  it('vyčerpaný strop relaci useknе a běh se přizná k neúplnosti', async () => {
    const { provider, report } = run([SLOWER_FLOOD], { ...SUBSCRIPTION, EVAL_CALL_CAP: '2' });
    const result = await report;
    expect(provider.sent).toHaveLength(2);
    expect(result.sessions[0].turns).toHaveLength(2);
    expect(result.sessions[0].abortedAt).toMatch(/rozpočet/);
    expect(result.complete).toBe(false);
    expect(result.stoppedReason).toMatch(/CALL_CAP_EXHAUSTED/);
    // Neúplná relace nemůže uspět, i kdyby oba odbavené tahy prošly.
    expect(result.sessions[0].passed).toBe(false);
    expect(result.sessionSuccessRate, 'žádná relace nedoběhla — nula by lhala o jmenovateli').toBeNull();
  });
});

describe('runEditSessions — relace je jeden svět, ne tři nezávislé tahy', () => {
  it('druhý tah se ptá na svět PO prvním, ne na základní', async () => {
    const { provider, report } = run([SLOWER_FLOOD, DECORATIVE_FLAG, DECORATIVE_FLAG]);
    const result = await report;

    expect(result.sessions[0].turns[0].committed, 'první tah se necommitnul, druhý nemá co vidět').toBe(true);
    // Tohle je celý rozdíl proti jednotahovému měření: dokument v systémové
    // zprávě druhého tahu nese hodnotu, kterou tam zapsal ten první.
    expect(provider.sent[0].system).toContain('"durationTicks":1200');
    expect(provider.sent[1].system).toContain('"durationTicks":2400');
    expect(provider.sent[1].system).toContain('simRevision 1');
    expect(provider.sent[2].system).toContain('simRevision 2');
  });

  it('nedostupný základní svět relaci zastaví a je to selhání harnessu, ne modelu', async () => {
    const provider = patchProvider([SLOWER_FLOOD]);
    const result = await runEditSessions({
      env: SUBSCRIPTION,
      provider,
      transport: fakeTransport(null),
      baseWorlds: ['C02'],
      root: tempRoot(),
    });
    expect(provider.sent).toHaveLength(0);
    expect(result.sessions[0].abortedAt).toBe('základní svět');
    expect(result.failures.map((failure) => failure.kind)).toContain('transport');
    expect(result.ok).toBe(false);
  });
});

describe('behaviouralEffect — tichý no-op se pozná chováním, ne diffem', () => {
  it('úprava, kterou nečte žádné pravidlo, je tichá i když diffem hne', async () => {
    const { report } = run([DECORATIVE_FLAG]);
    const result = await report;
    const turn = result.sessions[0].turns[0];

    expect(turn.committed, 'patch se necommitnul, tohle by netestovalo no-op').toBe(true);
    expect(turn.changedLeaves.length, 'strukturálně se dokument nehnul').toBeGreaterThan(0);
    expect(turn.behaviour.effect).toBe('silent');
    expect(turn.passed, 'tichý no-op prošel jako úspěšný tah').toBe(false);
  });

  it('úprava, kterou pravidlo čte, chováním hne', async () => {
    const { report } = run([SLOWER_FLOOD]);
    const turn = (await report).sessions[0].turns[0];
    expect(turn.committed).toBe(true);
    expect(turn.behaviour.effect).toBe('moved');
  });

  it('kontrakt splněný do písmene tah nezachrání, když se běh nehnul', async () => {
    // Tohle je jediný tvar, který odděluje behaviorální oracle od scorerova
    // strukturálního `notNoOp`: E10 dostane `FULFILLED`, protože pravidlo
    // doopravdy přibylo a na správné cestě — a přesto nikdy nespustí.
    const { report } = run([SLOWER_FLOOD, DEAD_RULE, DECORATIVE_FLAG]);
    const turn = (await report).sessions[0].turns[1];

    expect(turn.promptId).toBe('E10');
    expect(turn.verdict, 'fixture se rozešla s kontraktem E10 — bez FULFILLED test nic neoddělí').toBe('FULFILLED');
    expect(turn.committed).toBe(true);
    expect(turn.behaviour.effect).toBe('silent');
    expect(turn.passed, 'mrtvé pravidlo prošlo jako úspěšný tah').toBe(false);
  });

  it('necommitnutý tah není no-op — nemá co porovnávat', async () => {
    const { report } = run([[{ op: 'replace', path: '/sim/state/timers/nic/durationTicks', value: 5 }]]);
    const turn = (await report).sessions[0].turns[0];
    expect(turn.committed).toBe(false);
    expect(turn.behaviour.effect).toBe('unobservable');
    expect(turn.passed).toBe(false);
  });
});

describe('preservationOf — co udělal první tah, musí platit i na konci', () => {
  it('tah, který vrátí předchozí úpravu zpátky, relaci shodí', async () => {
    const { report } = run([SLOWER_FLOOD, DECORATIVE_FLAG, RESTORE_FLOOD]);
    const session = (await report).sessions[0];

    const undone = session.preservation.find((check) => check.rid === 'E01.e2');
    expect(undone, 'postpodmínka prvního tahu se na konci vůbec neověřila').toBeDefined();
    expect(undone!.held, 'třetí tah přepsal první a relace to nepoznala').toBe(false);
    expect(session.passed).toBe(false);
  });

  it('úprava, které se nikdo nedotkl, na konci pořád platí', async () => {
    const { report } = run([SLOWER_FLOOD, DECORATIVE_FLAG, DECORATIVE_FLAG]);
    const session = (await report).sessions[0];
    expect(session.preservation.find((check) => check.rid === 'E01.e2')!.held).toBe(true);
  });

  it('přeemitovaný svět spadne na revizi, i kdyby entity seděly', () => {
    const base = baseDoc('C02');
    const reset = { ...base, simRevision: base.simRevision } as WorldDoc;
    const checks = preservationOf(base, reset, [{ index: 1, contract: contractOf('E01'), committedSim: true }]);
    const monotone = checks.find((check) => check.rid === 'session.revisionMonotone')!;
    expect(monotone.held, 'commitnutý tah nezvedl revizi a nikdo si toho nevšiml').toBe(false);
  });

  it('zmizelá entita je ztráta stavu, ne detail', () => {
    const base = baseDoc('C02');
    const entities = { ...(base.sim as { entities: Record<string, unknown> }).entities };
    delete entities.valve;
    const stripped = { ...base, sim: { ...base.sim, entities }, simRevision: base.simRevision + 1 } as WorldDoc;
    const checks = preservationOf(base, stripped, [{ index: 1, contract: contractOf('E01'), committedSim: true }]);
    expect(checks.find((check) => check.rid === 'session.entitiesSurvive')!.held).toBe(false);
  });
});

describe('sessionPassed — tři podmínky, a všechny musí platit', () => {
  const passing = Array.from({ length: TURNS_PER_SESSION }, () => ({ passed: true }));

  it('projde jedině relace, kde prošly všechny tahy a nic se neztratilo', () => {
    expect(sessionPassed(passing, [{ held: true }, { held: true }])).toBe(true);
  });

  it('ztracený stav relaci shodí, i když všechny tahy prošly', () => {
    // Zmrazený korpus tuhle kombinaci vyrobit neumí (E19 má
    // `witnessPreserved: false`), takže bez tohoto testu by ta podmínka byla
    // nedokázaná — a mutace v ní by prošla celou sadou.
    expect(sessionPassed(passing, [{ held: true }, { held: false }])).toBe(false);
  });

  it('neúspěšný tah relaci shodí, i když se nic neztratilo', () => {
    expect(sessionPassed([{ passed: true }, { passed: false }, { passed: true }], [{ held: true }])).toBe(false);
  });

  it('nedoběhnutá relace neuspěje, i kdyby všechno ostatní sedělo', () => {
    expect(sessionPassed(passing.slice(0, 2), [{ held: true }])).toBe(false);
  });
});

describe('runEditSessions — úspěšnost relace se měří, nedopočítává', () => {
  it('naměřená úspěšnost relace se rozchází s dopočtem z nezávislosti tahů', async () => {
    // Dva tahy pohnou chováním, třetí ho vrátí zpátky. Kdyby se relace počítala
    // z tahů, vyšlo by kladné číslo; naměřená je nula, protože se ztratil stav.
    const result = await run([SLOWER_FLOOD, DECORATIVE_FLAG, RESTORE_FLOOD]).report;
    expect(result.sessionsCompleted).toBe(1);
    expect(result.turnsRun).toBe(TURNS_PER_SESSION);
    // Obě strany nenulově, jinak by se rovnost 0 = 0 dala splnit nedopatřením.
    expect(result.turnsPassed, 'žádný tah neprošel — rozdíl obou čísel by byl vakuózní').toBeGreaterThan(0);
    expect(result.independenceEstimate!).toBeGreaterThan(0);
    expect(result.sessionSuccessRate, 'relace ztratila stav a přesto se počítá za úspěšnou').toBe(0);
    expect(result.independenceEstimate).toBe(result.turnSuccessRate! ** TURNS_PER_SESSION);
  });

  it('neúspěšný tah není selhání běhu — `ok` mluví o harnessu, ne o modelu', async () => {
    const result = await run([DECORATIVE_FLAG]).report;
    expect(result.sessions[0].turns.every((turn) => !turn.passed)).toBe(true);
    expect(result.failures, 'neúspěch modelu se propsal do selhání běhu').toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('runEditSessions — zmrazený korpus se nesmí vydávat za živý', () => {
  const frozenE01 = (): unknown => {
    const found = frozenResponses().find((entry) => entry.forPrompt === 'E01' && entry.branch === 'edit');
    if (found === undefined) throw new Error('zmrazený záznam E01 chybí');
    return found.body;
  };

  it('zmrazený záznam dosazený do role obálky odpovědi je selhání běhu', async () => {
    // Tvrdá brána. Obálku zmrazený korpus nemá z čeho vydat, takže shoda tady
    // znamená, že se do ní posadil záznam — na rozdíl od shody samotného těla.
    const body = frozenE01();
    const provider: ProviderTransport = {
      complete: async (): Promise<LiveCompletion> => ({
        raw: body,
        text: JSON.stringify(body),
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    };
    const result = await runEditSessions({
      env: SUBSCRIPTION,
      provider,
      transport: fakeTransport(baseDoc('C02')),
      baseWorlds: ['C02'],
      root: tempRoot(),
    });

    expect(result.failures.map((failure) => failure.kind)).toContain('frozen-leak');
    expect(result.ok).toBe(false);
  });

  it('tělo shodné se zmrazeným je naměřený nález, ne selhání běhu', async () => {
    // Naměřeno živě 14. 8. 2026: model na `E01` vydal přesně ta dvě `replace`,
    // která nese zmrazený záznam. Minimální správný patch má jeden tvar, takže
    // shoda těla o původu odpovědi neříká nic — viz `FrozenBodyMatch`.
    const result = await run([frozenE01()]).report;

    expect(result.failures.filter((failure) => failure.kind === 'frozen-leak')).toEqual([]);
    expect(result.frozenBodyMatches.map((match) => match.caseId)).toContain('E01');
    expect(result.sessions[0].turns[0].frozenBodyMatch?.detail).toMatch(/bit po bitu/);
  });

  it('nález se nese do reportu, mlčky se nespolkne', async () => {
    // Brána vznikla proti tichému propašování záznamu. Kdyby se shoda jen
    // překlopila na `null`, zmizela by z reportu i z důkazu — a to je horší než
    // falešný poplach, protože se to nedá zpětně poznat.
    const clean = await run([SLOWER_FLOOD]).report;
    expect(clean.frozenBodyMatches).toEqual([]);
    expect(clean.sessions[0].turns.every((turn) => turn.frozenBodyMatch === null)).toBe(true);
  });

  it('živá odpověď se ukládá na disk a kotví řetěz hashem ze souboru', async () => {
    const result = await run([SLOWER_FLOOD]).report;
    const turn = result.sessions[0].turns[0];
    expect(turn.responsePath).toContain(result.runId);
    expect(turn.records[0].inputHash, 'první stadium nekotví na uloženou odpověď').toBe(turn.rawHash);
    expect(turn.records.map((record) => record.stage)).toEqual(['emit', 'validate', 'repair', 'commit', 'replay']);
  });
});
