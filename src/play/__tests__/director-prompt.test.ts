/**
 * Prompt režiséra (P23-B T3). Prompt s ručně opsaným seznamem mechanik by
 * vypadal úplně a zestárl by; test drží, že registr je vyrenderovaný ze
 * zdroje (změna `explanation` hne verzí), že v něm je všech 16 mechanik a
 * 8 archetypů, a že velikost nepřeteče – naměřené maximum 20. 9. 2026 je
 * 10 485 B nad 40 větami korpusu (strop plánu 12 000 B); 22. 9. 2026 s poli
 * `control`/`controlParams` (P25A) 10 654 B, s popisem běžce (T7) 11 135 B,
 * po sloučení s P25B (výhled hlídky, pořadí, bedny, menu objednávek) 11 253 B,
 * s fázemi světla (P25D T1) 11 362 B, se skrýšemi (P25D T2) 11 453 B.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { EMISSION_MODEL } from '@/model/prompt';

import { goldenPrompts } from '../../../evals/play/golden';
import { ANSWER_SHAPE_LINE, DIRECTOR_PROMPT_VERSION, DIRECTOR_RULES, buildDirectorRequest, compactSchema, renderRegistry } from '../director/prompt';
import { draftGameSpec } from '../draft';
import { ARCHETYPE_IDS, MECHANIC_IDS } from '../registry';

const RULES_FILE = fileURLToPath(new URL('../../../docs/play/pack/director.md', import.meta.url));

describe('director prompt', () => {
  it('quotes the pack rules verbatim and demands a single gamespec.v1 object', () => {
    expect(DIRECTOR_RULES).toBe(readFileSync(RULES_FILE, 'utf8').trim());
    const request = buildDirectorRequest('Collect five glowing mushrooms then open a portal.', draftGameSpec('Collect five glowing mushrooms then open a portal.'));
    expect(request.model).toBe(EMISSION_MODEL);
    expect(request.system.startsWith(DIRECTOR_RULES)).toBe(true);
    expect(request.system).toContain(ANSWER_SHAPE_LINE);
    expect(request.user).toContain('Starting point (keep or improve): {"schema":"gamespec.v1"');
  });

  it('renders every mechanic and archetype from the registry and none that the runtime lacks', () => {
    const registry = renderRegistry();
    for (const id of MECHANIC_IDS) expect(registry).toContain(`- ${id} {`);
    for (const id of ARCHETYPE_IDS) expect(registry).toContain(`- ${id}: objective=`);
    const request = buildDirectorRequest('anything', draftGameSpec('anything'));
    // Skok už runtime má – běžec (P25A T7); střelba a pohyblivé plošiny ne.
    for (const forbidden of ['projectile', 'moving_platform']) expect(request.system).not.toContain(forbidden);
  });

  // Po sloučení vlny 1: 11 558 B. Vlna 2 přidala sedm ovládání (P25F řízení a aréna,
  // P25G střelba a hod, P25H načasování, rytmus a souboj); s popisem každého zvlášť
  // by to bylo 12 068 B, tedy přes strop. Řádek ovládání proto říká legendou jednou,
  // co se opakovalo u každého (role `player` a `finish`, slovo `controlParams`):
  // 11 963 B. Do stropu zbývá 37 B, takže další ovládání se do téhle podoby nevejde –
  // vlna 3 musí řádek generovat z tabulky, ne ho psát ručně.
  // P26 T4: +34 B za pokyn, že AI smí ovládání změnit – 11 997 B. Místo vrátí
  // P26 T5, která řádek ovládání vyrobí z tabulky schopností.
  // P26 T5: řádek z tabulky nese **všechny** klíče `controlParams` (ruční řádek je
  // u střelby a hodu vynechal a model je hádal – přísné schéma neznámý klíč odmítne),
  // mechaniky a popisky, které hra ukáže, a tvar ověření arkády: 12 390 B. Strop
  // 12 000 B byl rozpočet plánu P23, ne mez poskytovatele; posouvá se na 12 500 B.
  // P26 T7 přidal pravidlo o popiscích rolí (1–3 slova, žádný pokyn): 12 447 B.
  it('stays under 12 500 bytes for all forty golden sentences (pin: 12 447 B)', () => {
    let max = 0;
    for (const entry of goldenPrompts()) {
      const request = buildDirectorRequest(entry.prompt, draftGameSpec(entry.prompt));
      max = Math.max(max, Buffer.byteLength(request.system + request.user));
    }
    expect(max).toBeLessThanOrEqual(12_500);
    expect(max).toBeLessThanOrEqual(12_447);
  });

  // Zlaté věty vedou všechny na mřížku, arkádové fixtury tak strop neměřil nikdo.
  // Naměřeno 23. 9. 2026: 11 286–11 672 B, nejdelší je rytmus.
  it.each([
    'car racing game',
    'like agar.io but you are a fish eating smaller fish',
    'zombie shooter in a mall',
    'throw a basketball into a hoop from crazy angles',
    'stack blocks as high as you can',
    'tap to the beat with glowing tiles',
    'boxing match against a kangaroo',
  ])('stays under 12 500 bytes for the arcade draft of "%s"', (sentence) => {
    const draft = draftGameSpec(sentence);
    expect(draft.control).toBeDefined();
    const request = buildDirectorRequest(sentence, draft);
    expect(Buffer.byteLength(request.system + request.user)).toBeLessThanOrEqual(12_500);
  });

  it('compacts schemas: role ids, enums, bounded ints, optional fields with defaults', () => {
    expect(compactSchema({ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.]{0,63}$' })).toBe('roleId');
    expect(compactSchema({ type: 'string', enum: ['slow', 'fast'] })).toBe('slow|fast');
    expect(compactSchema({ type: 'integer', minimum: 1, maximum: 20 })).toBe('int 1..20');
    expect(
      compactSchema({ type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'integer', default: 1 } }, required: ['a', 'b'] }),
    ).toBe('{a: bool, b?: int=1}');
  });

  it('keeps the version stable across calls and moves it when a registry explanation changes', async () => {
    const again = await import('../director/prompt');
    expect(again.DIRECTOR_PROMPT_VERSION).toBe(DIRECTOR_PROMPT_VERSION);

    vi.resetModules();
    vi.doMock('../registry', async () => {
      const actual = await vi.importActual<typeof import('../registry')>('../registry');
      const chaser = { ...actual.MECHANICS.chaser, explanation: 'A pursuer that never gives up.' };
      return { ...actual, MECHANICS: { ...actual.MECHANICS, chaser } };
    });
    const mocked = await import('../director/prompt');
    expect(mocked.DIRECTOR_PROMPT_VERSION).not.toBe(DIRECTOR_PROMPT_VERSION);
    vi.doUnmock('../registry');
    vi.resetModules();
  });
});
