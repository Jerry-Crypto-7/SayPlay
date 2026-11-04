/**
 * Duch a výzva řetězu v klientovi (P56C T12): duch z uloženého záznamu je v každém tiku v témž kole a stavu jako
 * `replayChain` téhož záznamu, v jiném kole než hráč se nekreslí, a Dare řetězu odejde s globálními tiky.
 * Duch posunutý o kartu by vypadal jako duch a závodil s jiným během – proto hash, ne jen kolo.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type ArcadeWorld, HEADER, type InputEvent } from '@/play/arcade/contract';
import { runBot } from '@/play/arcade/verify';
import { buildChain } from '@/play/chain/build';
import type { ChainWorld } from '@/play/chain/contract';
import { readForChain } from '@/play/chain/read';
import { replayChain } from '@/play/chain/run';
import { packInputs, unpackInputs } from '@/play/score/dare';

import { publishDare } from '../../../ShareButton';
import { createChainGhostSource, fetchChainGhost } from '../chain-ghost';
import { type ChainSession, createChainSession } from '../chain-session';

/** Kroky ducha: přetáčení od tiku 0 se pozná na počtu `stepChain`, ne na obraze. */
const steps = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/play/chain/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/play/chain/run')>();
  return {
    ...actual,
    stepChain: (...args: Parameters<typeof actual.stepChain>) => {
      steps.count += 1;
      return actual.stepChain(...args);
    },
  };
});

const MULTI = 'can u make one where a robot hops over lava cracks and shoots bubbles at grumpy clouds';

let chain: ChainWorld;
let record: readonly InputEvent[];
let session: ChainSession;

/** Hraje řetěz robotem kola tik po tiku; `skip` = kola, ve kterých hráč nic nedělá. */
function play(skip: ReadonlySet<number> = new Set()): ChainSession {
  const run = createChainSession(chain);
  let planned = -1;
  let events = new Map<number, InputEvent>();
  while (run.outcome() === 'running') {
    if (run.card() > 0) {
      run.advance(1000 / 60);
      continue;
    }
    const round = run.current();
    if (run.round() !== planned) {
      planned = run.round();
      events = new Map(skip.has(planned) ? [] : runBot(round.world as ArcadeWorld).inputs.map((event) => [event.tick, event]));
    }
    const event = events.get(round.state()[HEADER.tick] as number);
    if (event !== undefined) run.press(event.buttons, event.axis);
    round.stepOnce();
  }
  return run;
}

beforeAll(() => {
  const built = buildChain(MULTI, readForChain(MULTI, null), 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  chain = built.chain;
  // P70A T3: prohrané kolo řetěz zastaví, takže duch projde všemi koly jen vyhraný (Dare vzniká jen z výhry).
  session = play();
  record = session.inputs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createChainGhostSource (P56C T12)', () => {
  it('is in the same round and state as replayChain at every tick, forwards and backwards', () => {
    const ghost = createChainGhostSource(chain, record);
    const end = session.tick();
    const ticks = [...Array.from({ length: Math.ceil(end / 23) }, (_, index) => index * 23), end - 1, 610, 5, end];
    const rounds = new Set<number>();
    let cards = 0;
    for (const tick of ticks) {
      const at = ghost.at(tick);
      expect(at).not.toBeNull();
      expect(ghost.hash(), `tick ${String(tick)}`).toBe(replayChain(chain, record, undefined, tick).hash);
      rounds.add(at!.round);
      if (at!.card) {
        cards += 1;
        expect(at!.pose).toBeNull();
      } else expect(at!.pose).not.toBeNull();
    }
    expect(rounds.size).toBe(chain.rounds.length);
    expect(cards).toBeGreaterThan(0);
    expect(ghost.end()).toEqual({ tick: end, outcome: session.outcome(), hash: session.hash() });
    // Za koncem záznamu duch není.
    expect(ghost.at(end + 1)).toBeNull();
  });

  it('draws in a round only while the player is in the same round', () => {
    const ghost = createChainGhostSource(chain, record);
    // Kolo 2 začne hráč v jiném globálním tiku než duch (duch kolo 2 prohrál nečinně a rychle) – kreslí se jen v kole, kde duch je.
    const ghostStart = (round: number): number => {
      for (let tick = 0; ; tick += 1) {
        const at = ghost.at(tick)!;
        if (at.round === round && !at.card) return tick;
      }
    };
    const second = ghostStart(1);
    const sameRound = ghost.forRound(1, second);
    expect(sameRound.poseAt(0)).not.toBeNull();
    // Hráč v kole 1 v tiku, kdy duch hraje kolo 2: duch se v kole 1 nekreslí.
    const otherRound = ghost.forRound(0, 0);
    expect(otherRound.poseAt(second + 10)).toBeNull();
    expect(ghost.at(second + 10)!.round).toBe(1);
    // Hráč v kole 3, duch ještě v kole 2: nekreslí se ani tam.
    expect(ghost.forRound(2, second).poseAt(5)).toBeNull();
  });

  it('a card does not rewind the ghost: the HUD walks the card while the finished round scene stays on its last tick', () => {
    const ghost = createChainGhostSource(chain, record);
    let end = 0;
    while (!ghost.at(end + 1)!.card) end += 1;
    const scene = ghost.forRound(0, 0);
    scene.poseAt(end);
    steps.count = 0;
    // Snímky karty jako v `ChainPlay`: HUD `at(session.tick())`, scéna kola 1 interpoluje `poseAt(tik − 1)` a `poseAt(tik)`.
    for (let frame = 1; frame <= chain.cardTicks; frame += 1) {
      expect(ghost.at(end + frame)!.card).toBe(true);
      scene.poseAt(end - 1);
      scene.poseAt(end);
    }
    // Jen HUD jde dál o tik za snímek; přetočení od nuly by stálo `end` kroků za snímek.
    expect(steps.count).toBeLessThanOrEqual(chain.cardTicks);
  });

  it('fetchChainGhost reads the stored replay; a record with live changes is no chain ghost', async () => {
    const replay = { v: 1, inputs: packInputs(record), patches: [] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ replay }), { status: 200 }));
    const ghost = await fetchChainGhost('a'.repeat(16), 'd1', chain, fetcher as unknown as typeof fetch);
    expect(ghost).not.toBeNull();
    ghost!.at(session.tick());
    expect(ghost!.hash()).toBe(session.hash());
    const patched = { v: 1, inputs: packInputs(record), patches: [{ tick: 3, patch: { kind: 'visual' } }] };
    const refused = await fetchChainGhost('a'.repeat(16), 'd1', chain, (async () => new Response(JSON.stringify({ replay: patched }), { status: 200 })) as unknown as typeof fetch);
    expect(refused).toBeNull();
  });
});

describe('Dare of a chain (P56C T12)', () => {
  it('posts the global ticks through packInputs and the server replay gives the session hash', async () => {
    const won = play();
    expect(won.outcome()).toBe('won');
    let sent: { inputs: unknown; patches: unknown } | null = null;
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as { inputs: unknown; patches: unknown };
      return new Response(JSON.stringify({ dareId: 'x1' }), { status: 201 });
    }));
    await publishDare('a'.repeat(16), won.inputs(), []);
    expect(sent).not.toBeNull();
    expect(sent!.inputs).toEqual(packInputs(won.inputs()));
    expect(sent!.patches).toEqual([]);
    const unpacked = unpackInputs(sent!.inputs);
    expect(typeof unpacked).not.toBe('string');
    expect(replayChain(chain, unpacked as readonly InputEvent[]).hash).toBe(won.hash());
    // Globální tiky, ne místní tiky kola: poslední vstup leží v posledním kole.
    expect((unpacked as readonly InputEvent[]).at(-1)!.tick).toBeGreaterThan(won.tick() / 2);
  });
});
