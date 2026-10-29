/**
 * Háčky na obrazovce (P66 T4) z ručního seznamu zpráv jádra: kolik popů, hlášek a karet vznikne, a že klepnutí na
 * kartu pošle relaci **tentýž** vstup jako klávesa (`BUTTON.PICK_1..3`). Karta, která vypadá dobře, ale pošle jinou
 * volbu, by hru změnila tiše – proto test drží vstup, ne jen vzhled. Hra bez háčků (`genre.v5`) nevykreslí nic.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ArcadeEffect, BODY, BUTTON, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { CALLOUTS, type HookEffect, UPGRADE_PICK_BUTTONS, type UpgradeId } from '@/play/arcade/hooks/contract';

import type { RunFacts } from '../../../PostRun';
import type { RemixJob } from '../../../RemixBox';
import { hookEffectsOf, onHookEffects } from '../../effects/bus';
import type { ArcadeEventListener, ArcadeSession } from '../../session';
import { CALLOUT_MS, CALLOUT_TEXT } from '../Callout';
import { hooksOf } from '@/play/arcade/hooks';
import { fightSpec, fightTuned, worldOf } from '@/play/arcade/hooks/__tests__/harness';
import { openOffer } from '@/play/arcade/hooks/upgrades';
import { instantiate } from '@/play/arcade/kernel';

import { HookScreen, type HookTick, HooksLayer, type HooksView, NO_HOOKS, hookTickOf, nextView, pruneView, resumedView } from '../HooksLayer';
import { ROUND_BANNER_MS } from '../RoundBanner';
import { POP_MAX, POP_MERGE_MS, POP_MS } from '../ScorePop';
import { UpgradeCards, pickCard, pickKey } from '../UpgradePick';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

/** Stav s těly `[x, y, z, h]` v metrech; hráč je tělo 0. */
function stateWith(bodies: readonly (readonly [number, number, number, number])[]): Int32Array {
  const state = new Int32Array(bodyBase(bodies.length));
  state[HEADER.bodyCount] = bodies.length;
  state[HEADER.player] = 0;
  bodies.forEach(([x, y, z, h], body) => {
    const base = bodyBase(body);
    state[base + BODY.x] = x * UNIT;
    state[base + BODY.y] = y * UNIT;
    state[base + BODY.z] = z * UNIT;
    state[base + BODY.h] = h * UNIT;
  });
  return state;
}

/** Těla v řadě po `gap` metrech. */
const row = (count: number, gap: number): Int32Array => stateWith(Array.from({ length: count }, (_, body) => [body * gap, 0, 0, 1] as const));

const OFFER: readonly [UpgradeId, UpgradeId, UpgradeId] = ['speed', 'fire_rate', 'extra_life'];

/** Obraz po tikách `[čas ms, zprávy]` nad stavem `state`. */
function play(ticks: readonly (readonly [number, readonly HookEffect[]])[], state = row(8, 5), from: HooksView = NO_HOOKS): HooksView {
  let key = 0;
  return ticks.reduce((view, [now, effects]) => nextView(view, hookTickOf(effects, state), now, () => (key += 1)), from);
}

const screen = (view: HooksView, press = vi.fn()): string => renderToStaticMarkup(<HookScreen view={view} session={{ press }} />);
const count = (markup: string, testId: string): number => markup.split(`data-testid="${testId}"`).length - 1;

/** Všechny prvky stromu (bez vykreslení – klepnutí se volá přímo na `onClick` karty). */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elementsOf(node.props.children as ReactNode)];
}

describe('hook messages from a tick', () => {
  it('keeps only hook messages; a genre.v5 tick has none', () => {
    const v5: ArcadeEffect[] = [{ kind: 'score', amount: 10 }, { kind: 'despawn', body: 2 }, { kind: 'combo', body: 3, multiplier: 2 }];
    expect(hookEffectsOf(v5)).toEqual([]);
    const pop: HookEffect = { kind: 'score_pop', amount: 10, body: 2 };
    expect(hookEffectsOf([...v5, pop, { kind: 'boss_enter', body: 4 }])).toEqual([pop, { kind: 'boss_enter', body: 4 }]);
  });

  it('calls the listener only for ticks with hook messages and resets when the session restarts', () => {
    const state = new Int32Array(bodyBase(1));
    const events = new Set<ArcadeEventListener>();
    const changes = new Set<() => void>();
    const session = {
      state: () => state,
      onEvents: (listener: ArcadeEventListener) => (events.add(listener), () => events.delete(listener)),
      subscribe: (listener: () => void) => (changes.add(listener), () => changes.delete(listener)),
    };
    const listener = vi.fn();
    const reset = vi.fn();
    const off = onHookEffects(session, listener, reset);
    const tickTo = (tick: number, effects: readonly ArcadeEffect[]): void => {
      for (const on of events) on(effects, tick - 1);
      state[HEADER.tick] = tick;
      for (const on of changes) on();
    };
    tickTo(1, [{ kind: 'score', amount: 5 }]);
    expect(listener).not.toHaveBeenCalled();
    tickTo(2, [{ kind: 'score', amount: 5 }, { kind: 'score_pop', amount: 5, body: 0 }]);
    expect(listener).toHaveBeenCalledWith([{ kind: 'score_pop', amount: 5, body: 0 }], 1);
    expect(reset).not.toHaveBeenCalled();
    tickTo(0, []);
    expect(reset).toHaveBeenCalledTimes(1);
    off();
    expect(events.size + changes.size).toBe(0);
  });
});

describe('ScorePop', () => {
  it(`shows at most ${POP_MAX} at once – the oldest go`, () => {
    const view = play([[0, Array.from({ length: 8 }, (_, body) => ({ kind: 'score_pop', amount: 10 + body, body }) as const)]]);
    expect(view.pops).toHaveLength(POP_MAX);
    expect(view.pops.map((pop) => pop.amount)).toEqual([12, 13, 14, 15, 16, 17]);
    expect(count(screen(view), 'hook-score-pop')).toBe(POP_MAX);
  });

  it('merges pops that land close together into one sum, but not far apart or later', () => {
    const near = play([[0, [0, 1, 2].map((body) => ({ kind: 'score_pop', amount: 10, body }) as const)]], row(3, 0.5));
    expect(near.pops.map((pop) => pop.amount)).toEqual([30]);
    const far = play([[0, [0, 1, 2].map((body) => ({ kind: 'score_pop', amount: 10, body }) as const)]], row(3, 4));
    expect(far.pops).toHaveLength(3);
    const later = play([[0, [{ kind: 'score_pop', amount: 10, body: 0 }]], [POP_MERGE_MS + 1, [{ kind: 'score_pop', amount: 10, body: 0 }]]], row(1, 0));
    expect(later.pops).toHaveLength(2);
  });

  it('sits over the body (x mirrored like particles) and takes the rarity of the find', () => {
    const state = stateWith([[0, 0, 0, 1], [2, 1, 6, 1.5]]);
    const view = play([[0, [{ kind: 'score_pop', amount: 30, body: 1 }, { kind: 'rare_found', rarity: 'epic', body: 1 }]]], state);
    expect(view.pops).toHaveLength(1);
    expect(view.pops[0]).toMatchObject({ amount: 30, rarity: 'epic', x: -2, z: 6 });
    expect(view.pops[0]!.y).toBeGreaterThan(2.5);
    expect(screen(view)).toContain('data-rarity="epic"');
    expect(screen(view)).toContain('>+30</span>');
    // Zpráva bez platného těla patří hráči.
    const lost = play([[0, [{ kind: 'score_pop', amount: 5, body: -1 }]]], state).pops[0]!;
    expect([Math.abs(lost.x), lost.z]).toEqual([0, 0]);
  });

  it('fades after its flight', () => {
    const view = play([[0, [{ kind: 'score_pop', amount: 10, body: 0 }]]]);
    expect(pruneView(view, POP_MS - 1).pops).toHaveLength(1);
    expect(pruneView(view, POP_MS).pops).toHaveLength(0);
  });
});

describe('Callout', () => {
  it('shows one callout at a time – the most important of the tick', () => {
    const view = play([[0, [{ kind: 'callout', callout: 'combo_2' }, { kind: 'callout', callout: 'combo_3' }]]]);
    const markup = screen(view);
    expect(count(markup, 'hook-callout')).toBe(1);
    expect(markup).toContain('>Combo ×3</p>');
    expect(markup).toContain('sp-world-tag--goal');
  });

  it('says "Boss!" when the boss enters, as a threat tag', () => {
    const markup = screen(play([[0, [{ kind: 'boss_enter', body: 4 }]]]));
    expect(markup).toContain('>Boss!</p>');
    expect(markup).not.toContain('sp-world-tag--goal');
  });

  it('does not replay the same callout while it still shows, and fades after it', () => {
    const once = play([[0, [{ kind: 'callout', callout: 'round_clear' }]]]);
    const again = play([[CALLOUT_MS / 2, [{ kind: 'callout', callout: 'round_clear' }]]], undefined, once);
    expect(again.callout).toBe(once.callout);
    expect(pruneView(once, CALLOUT_MS).callout).toBeNull();
  });

  it('has short English copy for every callout id', () => {
    for (const id of CALLOUTS) expect(CALLOUT_TEXT[id]).toMatch(/^[A-Z][A-Za-z' ×0-9!]{2,15}$/);
    expect(CALLOUT_TEXT.round_clear).toBe('Round clear!');
    expect(CALLOUT_TEXT.epic_find).toBe('Epic find!');
    // T11: body výzvy přebité za běhu ještě nejsou výhra – „You beat it!“ patří až výsledku.
    expect([CALLOUT_TEXT.new_best, CALLOUT_TEXT.beat_it]).toEqual(['New best!', "You're ahead!"]);
  });
});

describe('RoundBanner', () => {
  it('says "Round 2 of 3" on the start of the second round, and goes within a second', () => {
    const view = play([[0, [{ kind: 'round_start', round: 1, rounds: 3 }]]]);
    expect(screen(view)).toContain('>Round 2 of 3</p>');
    expect(ROUND_BANNER_MS).toBeLessThanOrEqual(1000);
    expect(pruneView(view, ROUND_BANNER_MS).round).toBeNull();
  });

  it('shows nothing for a game without rounds', () => {
    expect(play([[0, [{ kind: 'round_start', round: 0, rounds: 1 }]]]).round).toBeNull();
  });
});

describe('UpgradePick', () => {
  it('shows three cards on an offer and none after the pick or a restart', () => {
    const offered = play([[0, [{ kind: 'upgrade_offer', offer: OFFER }]]]);
    const markup = screen(offered);
    expect(count(markup, 'upgrade-pick')).toBe(1);
    expect([0, 1, 2].map((card) => count(markup, `upgrade-card-${card}`))).toEqual([1, 1, 1]);
    OFFER.forEach((upgrade, card) => expect(markup).toMatch(new RegExp(`data-testid="upgrade-card-${card}" data-upgrade="${upgrade}"`)));
    const picked = play([[100, [{ kind: 'upgrade_pick', card: 1, upgrade: 'fire_rate' }]]], undefined, offered);
    expect(count(screen(picked), 'upgrade-pick')).toBe(0);
    expect(screen(NO_HOOKS)).toBe('');
  });

  // Node nemá DOM: `isTyping` pozná pole formuláře podle `HTMLElement` a `closest` (vzor `ready-gate.test.ts`).
  class Element {
    readonly isContentEditable = false;
    constructor(private readonly field: boolean) {}
    closest(): object | null {
      return this.field ? {} : null;
    }
  }
  beforeEach(() => vi.stubGlobal('HTMLElement', Element));
  afterEach(() => vi.unstubAllGlobals());

  it('a card tap sends the session the same input as its key', () => {
    const tapped = vi.fn();
    const keyed = vi.fn();
    const cards = elementsOf(UpgradeCards({ offer: OFFER, pressed: null, onPick: (card) => pickCard({ press: tapped }, card) })).filter((element) => element.type === 'button');
    expect(cards.map((card) => card.props['data-testid'])).toEqual(['upgrade-card-0', 'upgrade-card-1', 'upgrade-card-2']);
    cards.forEach((card, index) => {
      (card.props.onClick as () => void)();
      expect(pickKey({ press: keyed }, { key: String(index + 1), repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: null })).toBe(true);
    });
    expect(tapped.mock.calls).toEqual(keyed.mock.calls);
    expect(tapped.mock.calls.map(([buttons]) => buttons)).toEqual([BUTTON.PICK_1, BUTTON.PICK_2, BUTTON.PICK_3]);
    expect(UPGRADE_PICK_BUTTONS).toEqual([BUTTON.PICK_1, BUTTON.PICK_2, BUTTON.PICK_3]);
  });

  it('ignores other keys, held keys and shortcuts', () => {
    const press = vi.fn();
    const key = (over: Partial<Parameters<typeof pickKey>[1]>) => pickKey({ press }, { key: '1', repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: null, ...over });
    const field = new Element(true) as unknown as EventTarget;
    expect([key({ key: '4' }), key({ key: ' ' }), key({ repeat: true }), key({ ctrlKey: true }), key({ metaKey: true }), key({ target: field })]).toEqual([false, false, false, false, false, false]);
    expect(press).not.toHaveBeenCalled();
  });
});

describe('RarityToast', () => {
  it('counts rare and epic finds of the run in a rarity frame', () => {
    const view = play([
      [0, [{ kind: 'rare_found', rarity: 'rare', body: 1 }]],
      [500, [{ kind: 'rare_found', rarity: 'rare', body: 2 }]],
    ]);
    expect(view.found).toEqual({ rare: 2, epic: 0 });
    const markup = screen(view).replace(/<!-- -->/g, '');
    expect(markup).toContain('data-rarity="rare"');
    expect(markup).toMatch(/data-testid="hud-counter-rare" data-count="2"[^>]*>2 rare</);
    const epic = play([[900, [{ kind: 'rare_found', rarity: 'epic', body: 3 }]]], undefined, view);
    expect(screen(epic)).toContain('data-testid="hud-counter-epic"');
  });
});

describe('a game without hooks', () => {
  it('renders nothing new', () => {
    const world = worldOf(fightTuned(() => ({ enemies: 3, waves: 3 })), 1);
    const state = instantiate(world);
    expect(renderToStaticMarkup(<HooksLayer session={{ world, state: () => state } as unknown as ArcadeSession} />)).toBe('');
    const empty: HookTick = hookTickOf([], row(1, 0));
    expect(screen(play([[0, empty.effects]]))).toBe('');
  });
});

describe('PostRun rarity row', () => {
  const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };
  const facts: RunFacts = { won: true, tick: 600, hz: 60, survive: false, goal: null, extra: [] };
  const card = async (extra: Partial<RunFacts>): Promise<string> => {
    const { PostRun } = await import('../../../PostRun');
    return renderToStaticMarkup(createElement(PostRun, { versionId: 'v1', remix: job, facts: { ...facts, ...extra }, onReplay: () => undefined, offline: true }));
  };

  it('lists the finds by rarity, and is absent without rarity or finds', async () => {
    const markup = await card({ found: { common: 12, rare: 3, epic: 1 } });
    expect(markup).toContain('data-testid="play-found"');
    expect(markup.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '')).toContain('You found 12 common 3 rare 1 epic');
    expect(await card({})).not.toContain('play-found');
    expect(await card({ found: { common: 0, rare: 0, epic: 0 } })).not.toContain('play-found');
  });
});

describe('a layer that mounts mid-game (back in the feed)', () => {
  it('shows the offer the core still holds open, and nothing when none is open or the game has no hooks', () => {
    const world = worldOf(fightSpec(), 1);
    const state = instantiate(world);
    const keeper = hooksOf(world.rules)!.keeper;
    expect(resumedView({ world, state: () => state })).toBe(NO_HOOKS);
    openOffer(state, keeper, ['extra_life', 'speed', 'fire_rate']);
    expect(resumedView({ world, state: () => state }).offer?.cards).toEqual(['extra_life', 'speed', 'fire_rate']);
    // Hra bez háčků: `genre.v5` (od P66 T10 má `genre.v6` souboje háčky i bez klíčů).
    const plain = worldOf(fightTuned(() => ({ enemies: 3, waves: 3 }), 'genre.v5'), 1);
    expect(resumedView({ world: plain, state: () => state })).toBe(NO_HOOKS);
  });
});

describe('play-hooks.css', () => {
  it('uses only kit tokens and nothing purple', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/play/play-hooks.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/purple|violet|indigo|magenta|fuchsia|lavender|plum/i);
    for (const name of css.match(/var\(--[\w-]+/g) ?? []) expect(name).toMatch(/^var\(--(sp-|_)/);
  });
});
