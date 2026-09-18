/**
 * **Věta průvodce nesmí obsahovat slovo, které ve světě není.**
 *
 * Celé tvrzení T13 je uzavřená zásoba slov. Odpověď „projdi kolem fontány a
 * pak doleva" se čte líp než ta pravdivá a pozná se jedině tím, že se každé
 * slovo hotové věty porovná se seznamem toho, co v ní stát smí. Sada proto
 * měří **hotový text**, ne konstanty vedle něj, a nad skutečnou odpovědí
 * průvodce z certifikovaného světa, ne nad ručně psanou strukturou.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../../ir/build';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '../../model/prompt';
import { guideRoute, type GuideAnswer } from '../guide';
import { GUIDE_FRAME_WORDS, guideVocabulary, phraseGuideAnswer, routeMarkers } from '../guide-answer';
import type { ProxyWorld } from '../proxy';

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

const BUDGET = { maxNodes: 20_000, maxTicks: 100_000, maxDepth: 6, settleTicks: 30 } as const;

/** Ukázkový svět z hotové systémové zprávy — týž zdroj, jaký používá `guide.test.ts`. */
function world() {
  const system = buildEmissionRequest('cokoli', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  const document = JSON.parse(system.slice(system.indexOf('{', at))) as { sim: Record<string, unknown> };
  const built = buildRuntimeWorld({ ...document.sim, witness: { tier: 'short', H_cert: 600, ops: [] } });
  expect(built.ok ? [] : built.issues, 'svět se nepostavil, test by měřil něco jiného').toEqual([]);
  if (!built.ok) throw new Error('unreachable');
  return built.world;
}

/** Slova hotové věty. Interpunkce není slovo. */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/i).filter((word) => word !== '');

function closedOver(answer: GuideAnswer): void {
  const allowed = guideVocabulary(answer).map((word) => word.toLowerCase());
  for (const word of wordsOf(phraseGuideAnswer(answer).text))
    expect(allowed, `slovo "${word}" není v cestě ani ve světě`).toContain(word);
}

describe('věta vzniká z cesty a z ničeho jiného', () => {
  const route = guideRoute(world(), 'gate', BUDGET);

  it('nalezená cesta dá větu, která jmenuje jen kroky té cesty', () => {
    expect(route.status).toBe('ROUTE');
    if (route.status !== 'ROUTE') return;

    const sentence = phraseGuideAnswer(route);
    closedOver(route);

    // Kroky ve větě jsou v pořadí, ve kterém je hledač našel. Měří se za
    // dvojtečkou: cíl cesty stojí i v její hlavě a hlava pořadí kroků není.
    const steps = sentence.text.slice(sentence.text.indexOf(': '));
    const positions = route.ops
      .filter((op) => op.target !== undefined)
      .map((op) => steps.indexOf(op.target!));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sentence.text).toContain(route.target);
  });

  it('cíl mimo svět nedostane ani jedno jméno ze světa', () => {
    const answer = guideRoute(world(), 'fountain', BUDGET);
    expect(answer.status).toBe('NOT_IN_WORLD');
    closedOver(answer);

    const sentence = phraseGuideAnswer(answer);
    expect(sentence.text).toContain('fountain');
    for (const name of ['gate', 'lever', 'card', 'player'])
      expect(sentence.text.toLowerCase(), `odpověď si přivolala ${name}`).not.toContain(name);
    expect(sentence.highlight).toEqual([]);
  });

  it('každý důvod, proč cesta není, má vlastní větu a všechny jsou uzavřené', () => {
    const texts = new Set<string>();
    for (const reason of ['BUDGET_EXHAUSTED', 'SEARCH_EXHAUSTED', 'WORLD_INELIGIBLE', 'UNCERTIFIED'] as const) {
      const answer: GuideAnswer = { status: 'NO_ROUTE', asked: 'gate', target: 'gate', reason };
      closedOver(answer);
      texts.add(phraseGuideAnswer(answer).text);
    }
    expect(texts.size).toBe(4);
  });

  it('zásoba slov je opravdu uzavřená — přidané slovo se pozná', () => {
    if (route.status !== 'ROUTE') return;
    const allowed = guideVocabulary(route).map((word) => word.toLowerCase());
    // Přesně ta vada, kvůli které tenhle modul existuje: plynulý orientační
    // bod, který ve světě není.
    expect(allowed).not.toContain('fountain');
    expect(wordsOf('walk past the fountain').every((word) => allowed.includes(word))).toBe(false);
    // A rámec sám žádné jméno ze světa nenese, jinak by uzavřenost neměřila nic.
    for (const name of ['gate', 'lever', 'card']) expect(GUIDE_FRAME_WORDS).not.toContain(name);
  });
});

describe('zvýraznění ve scéně', () => {
  const slot = (stableId: string, min: number[], max: number[]) => ({
    slot: { stableId, label: stableId, role: 'prop', importance: 1, source: { kind: 'geom', node: 0 }, localBounds: { min, max }, worldBounds: { min, max }, transform: {}, anchors: [] },
    form: {},
  });

  const built = {
    kind: 'built',
    title: 'test',
    sessionSeed: 1,
    resolution: 32,
    quality: 'full',
    slots: [slot('lever', [-1, 0, -1], [1, 2, 1]), slot('gate', [4, 0, 4], [5, 3, 5])],
  } as unknown as ProxyWorld;

  it('značka stojí na každé zastávce cesty, v jejím pořadí', () => {
    const markers = routeMarkers(built, ['gate', 'lever']);
    expect(markers.map((marker) => marker.stableId)).toEqual(['gate', 'lever']);
    expect(markers.map((marker) => marker.step)).toEqual([1, 2]);
    expect(markers[0]!.at).toEqual([4.5, 0, 4.5]);
    expect(markers[0]!.radius).toBeCloseTo(0.5);
  });

  it('zastávka bez hmoty ve světě žádnou značku nevyrobí', () => {
    expect(routeMarkers(built, ['fountain']).map((marker) => marker.stableId)).toEqual([]);
    // Plochý objekt dostane viditelný poloměr, ne nulu.
    expect(routeMarkers(built, ['lever'])[0]!.radius).toBeGreaterThan(0.3);
  });
});
