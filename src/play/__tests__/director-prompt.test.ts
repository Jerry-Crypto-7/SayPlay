/**
 * Prompt režiséra (P23-B T3; na žánrech od P32B T4). Prompt s ručně opsanou
 * nabídkou by vypadal úplně a zestárl by; test drží, že nabídka žánrů je
 * vyrenderovaná z modulů (jen režimy `ready`, třídy hrdinů, meze parametrů),
 * že v něm nezůstal seznam starých ovládání ani `tap_go` – prompt, který je
 * dál zmiňuje, vypadá v pořádku a model by psal hru, kterou odpověď nepustí –
 * a že velikost nepřeteče stropu 14 200 B (P45B T10, dřív 12 700 B).
 *
 * Do P32B T4 prompt vypisoval 11 ovládání, registr mechanik a tvar GameSpecu:
 * 12 691 B nad 40 zlatými větami. Žánrový prompt to celé nahrazuje.
 */

import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

import { EMISSION_MODEL } from '@/model/prompt';

import { goldenPrompts } from '../../../evals/play/golden';
import runnerFixture from '../arcade/__fixtures__/runner.json';
import shooterFixture from '../arcade/__fixtures__/shooter.json';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA, RECIPE_ANSWER_SCHEMA, readyModes, recipeAnswerSchema } from '../director/answer-schema';
import { buildCompactRequest } from '../director/compact';
import { COURSE_LINE, DIRECTOR_PROMPT_VERSION, GENRE_PITCH, GENRE_RULES, GENRE_SHAPE_LINE, buildDirectorRequest, checklistLines, compactSchema, directorSystemPrompt, renderRegistry } from '../director/prompt';
import { readDirectorAnswer } from '../director/read';
import { repairDeterministically } from '../director/repair';
import { draftGameSpecWithMeta } from '../draft';
import { CAST_ROLES, type GenreModule } from '../genre/contract';
import { P68_GENRES } from '../genre/p68-contract';
import { GENRE_MODULES } from '../genre/index';
import { ARCHETYPE_IDS, MECHANIC_IDS } from '../registry';
import { liveCells } from '../compose/allowed';
import { extractIntent } from '../intent/extract';
import { essentialTriples } from '../intent/contract';

const MODULES = Object.values(GENRE_MODULES) as GenreModule[];

describe('director prompt', () => {
  it('asks for a GenreSpec with the draft GenreSpec as the starting point', () => {
    const sentence = 'A wizard lights candles in a haunted castle';
    const request = buildDirectorRequest(sentence, draftGameSpecWithMeta(sentence).genre);
    expect(request.model).toBe(EMISSION_MODEL);
    expect(request.system.startsWith(GENRE_RULES)).toBe(true);
    expect(request.system).toContain(GENRE_SHAPE_LINE);
    expect(request.outputSchema).toBe(RECIPE_ANSWER_SCHEMA);
    expect(request.user).toContain('Starting point (a keyword guess, replace what it got wrong): {"genre":');
    // P37A T8: mezi větou a výchozím bodem stojí kontrolní seznam věty a hlavní sloveso – podle nich brána upgradu AI verzi pustí.
    const checklist = 'Checklist: hero "wizard"; role "candle"; setting "haunted castle".\nMain verb: "light" – genre quest, mode spatial.';
    expect(checklistLines(sentence)).toBe(checklist);
    // P45B T11: za výchozím bodem řádek průběhu hry (`COURSE_LINE`).
    expect(buildDirectorRequest(sentence, null).user).toBe(`${sentence}\n\n${checklist}\n\nStarting point: none – choose from the sentence.\n\n${COURSE_LINE}`);
  });

  it('names the verb family and says when the sentence has no game verb (P37A T8)', () => {
    expect(checklistLines('a grandma cat knits a giant scarf by the fireplace')).toBe('Checklist: hero "grandma cat".\nMain verb: "knit" (family craft) – genre rhythm.');
    expect(checklistLines('a long queue at the pharmacy')).toContain('Main verb: none – the sentence names no game verb.');
    // Kompaktní prompt (výchozí v produkci) nese tytéž řádky jako plný.
    const sentence = 'a walrus chef stirs a big pot of soup on an iceberg';
    const draft = draftGameSpecWithMeta(sentence).genre;
    for (const request of [buildDirectorRequest(sentence, draft), buildCompactRequest(sentence, draft), buildCompactRequest(sentence, draft, true)]) {
      expect(request.user).toContain(`${sentence}\n\n${checklistLines(sentence)}\n\nStarting point (a keyword guess, replace what it got wrong):`);
      expect(request.user).toContain('Main verb: "stir" (family cook) – genre quest, mode station.');
      expect(request.system).toContain('Checklist and main verb (in the request) are what the keyword reader found');
      // P38: dvě činnosti věty se hrají obě – skákání nese žánr, střelbu doplněk.
      expect(request.system).toContain('Multiple actions must coexist in the live recipe');
      expect(request.system).toContain('FULL INTENT is authoritative');
    }
  });

  // P39: model staví obsazení – každá věc věty s tím, co dělá – a o starém jednom nepříteli neslyší.
  it('asks for the cast with every does explained, never for enemy, collectible or target', () => {
    const draft = draftGameSpecWithMeta('a robot jumps across factory platforms and shoots rust bugs').genre;
    for (const system of [buildDirectorRequest('x', draft).system, buildCompactRequest('x', draft, true).system]) {
      expect(system).toContain('cast: every thing the sentence names except the hero and the place, each {label, does}');
      for (const does of CAST_ROLES.filter((role) => role !== 'hero')) expect(system, does).toMatch(new RegExp(`^- ${does}: \\S`, 'm'));
      expect(system).not.toMatch(/\benemyMoves\b|\benemy\?:|\bcollectible\?:|\btarget\?: \{|\benemy:|\bcollectible:/);
    }
    expect(GENRE_SHAPE_LINE).toContain('cast?: [{label: string<=60, does: shoot_at|chase_me|avoid|collect|reach|fight|throw_at|scenery');
    // Schéma odpovědi je ze zod: každá varianta nese obsazení s uzavřeným výčtem `does`, žádný starý slot.
    const variants = ((GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, unknown> }[] }>).spec.anyOf);
    for (const variant of variants) {
      expect(Object.keys(variant.properties)).toContain('cast');
      expect(Object.keys(variant.properties).filter((key) => ['enemy', 'enemyMoves', 'collectible', 'target'].includes(key))).toEqual([]);
      expect(JSON.stringify(variant.properties.cast)).toContain('"shoot_at"');
    }
  });

  it('offers exactly the ready modes of each genre with its hero classes and param bounds', () => {
    const system = directorSystemPrompt();
    for (const module of MODULES) {
      const ready = readyModes(module);
      const line = system.split('\n').find((text) => text.startsWith(`- ${module.id} (`));
      if (ready.length === 0) {
        expect(line, module.id).toBeUndefined();
        continue;
      }
      // P54C T14b: jediný režim `default` řádek nevypisuje – záhlaví říká „mode default unless listed“.
      if (ready.join() === 'default') expect(line, module.id).not.toContain('modes ');
      else expect(line, module.id).toContain(`modes ${ready.join('|')};`);
      expect(line, module.id).toContain(`hero ${module.heroClasses.join('/')}`);
      for (const [key, range] of Object.entries(module.paramBounds)) expect(line, module.id).toContain(`${key} ${String(range.min)}..${String(range.max)}`);
    }
  });

  it('offers live recipe movement names without exposing low-level control specs', () => {
    for (const system of [directorSystemPrompt(), buildCompactRequest('x', null).system]) {
      expect(system).not.toMatch(/tap_go|CONTROLS|controlParams/);
      // P54C T14: tabulka po pohybech – řádek `- <pohyb>: akce/cíl/hrozby, …`, víc kusů spojuje `+`.
      // T14b: pohyby se stejnými kombinacemi sdílejí řádek (`- run, jump: …`).
      const rows = system.split('\n').slice(system.split('\n').findIndex((line) => line.startsWith('LIVE COMBINATIONS')) + 1, system.split('\n').findIndex((line) => line.startsWith('LEGACY GENRES')));
      const entriesOf = (move: string) => {
        const row = rows.find((line) => line.slice(2, line.indexOf(': ')).split(', ').includes(move));
        return row?.slice(row.indexOf(': ') + 2).split(', ') ?? [];
      };
      // Každý pohyb stojí v tabulce právě jednou.
      expect(rows.flatMap((line) => line.slice(2, line.indexOf(': ')).split(', ')).sort()).toEqual([...new Set(liveCells().filter((cell) => !DIRECTOR_PENDING.has(cell.preset.genre)).map((cell) => cell.recipe.move))].sort());
      for (const cell of liveCells()) {
        const entry = `${cell.recipe.actions.join('+') || '-'}/${cell.recipe.objective}/${cell.recipe.threats.join('+') || '-'}`;
        // P54C T5: živý žánr, který režisér ještě nenabízí (`DIRECTOR_PENDING`), v promptu není – ani buňkou, ani řádkem žánru.
        if (DIRECTOR_PENDING.has(cell.preset.genre)) expect(entriesOf(cell.recipe.move), cell.id).not.toContain(entry);
        else expect(entriesOf(cell.recipe.move), cell.id).toContain(entry);
      }
      for (const genre of DIRECTOR_PENDING) expect(system).not.toMatch(new RegExp(`^- ${genre} \\(`, 'm'));
      expect(system).toContain('unmet');
    }
  });

  // P54C T14: žánr bez narážek (žánry pruhů) by v nabídce stál jako „- catch ()“ – model by nevěděl, co hraje.
  it('describes every offered genre: its cues or one sentence with one example sentence (P54C T14)', () => {
    const system = directorSystemPrompt();
    for (const module of MODULES.filter((each) => readyModes(each).length > 0)) {
      const about = system.split('\n').find((text) => text.startsWith(`- ${module.id} (`))?.match(/^- \S+ \((.*)\): (?:modes|hero) /)?.[1];
      expect(about, module.id).toBeTruthy();
      if (module.cues.length === 0) {
        expect(GENRE_PITCH[module.id], module.id).toBeDefined();
        expect(about, module.id).toMatch(/^[^;"]+; "[^"]+"$/);
      }
    }
    // T14: čtyři žánry pruhů, T14b: čtyři žánry fáze 3.
    for (const genre of ['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push'] as const) {
      expect(readyModes(GENRE_MODULES[genre] as GenreModule), genre).toEqual(['default']);
      expect(system, genre).toContain(`- ${genre} (${GENRE_PITCH[genre]!}): hero `);
    }
  });

  // P54C T14: odpověď smí jmenovat živé žánry pruhů oběma tvary. T14b: i žánry fáze 3 – kostra už žádná nezbyla.
  it('accepts the eight new genres as a recipe and as a legacy GenreSpec', () => {
    // Brána aktivace drží jen kostry P68 (T1) a klikací simulaci P83C (T4, režisér v P83B); jinou kostru režisér nemá.
    expect([...DIRECTOR_PENDING].filter((genre) => ![...P68_GENRES, 'orrery'].includes(genre))).toEqual([]);
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    const genres = variants.flatMap((variant) => variant.properties.genre?.enum ?? []);
    const content = { hero: 'fox', setting: 'forest', unmet: [] };
    for (const genre of ['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push']) {
      expect(genres, genre).toContain(genre);
      const cell = liveCells().find((live) => live.preset.genre === genre);
      expect(cell, genre).toBeDefined();
      expect(recipeAnswerSchema.safeParse({ ...content, recipe: cell!.recipe }).success, cell!.id).toBe(true);
    }
  });

  it('keeps the registry of mechanics and archetypes for remix and repair rounds', () => {
    const registry = renderRegistry();
    for (const id of MECHANIC_IDS) expect(registry).toContain(`- ${id} {`);
    for (const id of ARCHETYPE_IDS) expect(registry).toContain(`- ${id}: objective=`);
  });

  // P32B T4: nejdelší je kompaktní s příklady, 3 633 B (do T4 plný prompt 12 691 B).
  // T5b: 6 282 B – první odpověď zas nese pravidla P29A (B-R5: gramatika a jeden příklad) a počty rolí (B-R4),
  // výchozí bod draftu k tomu parametry modulu a počty z věty. B-R8: 6 414 B – spouštěč `interact` a jeho meze v gramatice pravidel.
  // T7: 6 718 B – co má AI verze proti výchozímu bodu přidat, popisky v jednotném čísle, nepřítel není nástroj hráče.
  // Revize fáze 3: 6 746 B – `interact` jen jako vítězné pravidlo. Kolo 2: 6 777 B – vyhrává se až se všemi cíli.
  // O9: 6 788 B – po sloučení všech stop popisují moduly žánrů E, F a G víc parametrů výchozího bodu.
  // P35 T3: 6 828 B – skákačka počítá věci ke sběru (`items 1..8`, `counts collectible`) a výchozí bod nese cíl z věty.
  // P36A T4: 6 884 B – běžec natahuje trať podle počtů (`items 1..50, obstacles 1..50`, `counts enemy/collectible`).
  // P36A T8: 7 569 B – hloubka pro všechny žánry (`lives`, `targetScore`, `timeLimit`, `enemyMoves`), dva příklady s ní
  // a věta, že pravidlo prohry dokáže robot, který do něj vleze.
  // P36A T10: 7 989 B – dva žánry navíc (Střílečka, Hod) se svými režimy a parametry (`waves`, `enemies`, `targets`;
  // `goal`, `spareThrows`, `seconds`) a hloubkou.
  // P36A T11: 8 540 B – čtyři žánry navíc (Načasování se třemi režimy, Rytmus, Souboj, Poletování), řádek z modulu.
  // P37A T8: 8 908 B – kontrolní seznam věty a hlavní sloveso s rodinou v požadavku a řádek, podle kterého brána upgradu AI verzi pustí.
  // P38: 9 254 B – výchozí bod je odhad, ne kostra; dvě činnosti věty (skok + střelba); věta v jiném jazyce.
  // P39 T11: 10 082 B – obsazení místo `enemy`/`enemyMoves`/`collectible`/`target`: tvar položky a řádek na každé `does`.
  // P45B T10: +1 500 B na průběh hry (`logic`) – řádek gramatiky a příklad s fází, časovačem a vlnou; strop 14 200 B.
  // P46E T3: řádek novinek AI verze (boss, akce, úseky) s příkladem na každý hlavní žánr – 14 964 B; strop 15 000 B.
  // P54C T14: čtyři žánry pruhů (řádek s větou a příkladem, buňky v tabulce, +828 B) by daly ~15 800 B; tabulka živých
  // kombinací po pohybech a zkrácené duplicitní věty pokynů – 14 968 B, strop beze změny.
  // P54C T14b: čtyři žánry fáze 3 (+853 B) – jediný režim `default` v záhlaví, run a jump jedním řádkem tabulky, zapojení
  // průběhu jen v řádku Course, sloučené věty pokynů, příklady pravidel bez null – 14 970 B, strop beze změny.
  // P66 T13: pět žánrů P66 (+1 386 B) – 16 356 B; strop 16 500 B (gpt-oss: ~350 tokenů navíc na volání).
  // P68 R7: `drawsave` (řádek žánru, buňka tabulky, příklad) – 16 768 B; strop 16 900 B (~70 tokenů navíc).
  // P68 R9: `railfps` (řádek žánru, buňka tabulky, příklad) – 17 096 B; strop 17 200 B (~80 tokenů navíc).
  // P68 R12: `minigolf` (řádek žánru, buňka tabulky, příklad) – 17 481 B; strop 17 600 B (~100 tokenů navíc).
  // P68R T5: `buildshift` (řádek žánru, buňka tabulky) – 17 802 B; strop 17 900 B (~80 tokenů navíc).
  it('stays under 17 900 bytes for all forty golden sentences, with examples and the complete intent', () => {
    let max = 0;
    for (const entry of goldenPrompts()) {
      const draft = draftGameSpecWithMeta(entry.prompt).genre;
      for (const request of [buildDirectorRequest(entry.prompt, draft), buildCompactRequest(entry.prompt, draft, true)]) {
        const intent = extractIntent(entry.prompt);
        const fullIntent = `\n\nFULL INTENT:\n${JSON.stringify({ sentence: entry.prompt, essential: essentialTriples(intent), negated: intent.negated })}`;
        max = Math.max(max, Buffer.byteLength(request.system + request.user + fullIntent));
      }
    }
    expect(max).toBeLessThanOrEqual(17_900);
    // P41 adds a live recipe table and all essential triples; the historical
    // 10,082 B observation was not the 12,700 B budget. Report both channels.
    if (process.env.P41_PROMPT_REPORT) writeFileSync(process.env.P41_PROMPT_REPORT, JSON.stringify({ maxPromptBytes: max, outputSchemaBytes: Buffer.byteLength(JSON.stringify(GENRE_ANSWER_SCHEMA)), includesFullIntent: true, budgetBytes: 17_900 }, null, 2));
    // Čtyřicet návrhů s ověřením robotem: arénu od P45C T12 ověřují i sondy nových chování (samotný test ~21 s).
  }, 90_000);

  it('rejects an addon the control does not take and the deterministic repair drops it', () => {
    const body = { ...(shooterFixture as object), addons: ['shoot'] };
    const read = readDirectorAnswer(body);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('MALFORMED_SPEC');
    const repaired = repairDeterministically(body, read.reason);
    expect(repaired?.spec.addons).toBeUndefined();
    expect(repaired?.applied.join()).toContain('dropped addons shoot');
    const kept = repairDeterministically({ ...(runnerFixture as object), addons: ['shoot', 'shoot', 'collect'] }, 'MALFORMED_SPEC');
    expect(kept?.spec.addons).toEqual(['shoot', 'collect']);
  });

  it('compacts schemas: role ids, enums, bounded ints, optional fields with defaults', () => {
    expect(compactSchema({ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.]{0,63}$' })).toBe('roleId');
    expect(compactSchema({ type: 'string', enum: ['slow', 'fast'] })).toBe('slow|fast');
    expect(compactSchema({ type: 'integer', minimum: 1, maximum: 20 })).toBe('int 1..20');
    expect(
      compactSchema({ type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'integer', default: 1 } }, required: ['a', 'b'] }),
    ).toBe('{a: bool, b?: int=1}');
  });

  it('keeps the version stable across calls and moves it when a genre module changes', async () => {
    const again = await import('../director/prompt');
    expect(again.DIRECTOR_PROMPT_VERSION).toBe(DIRECTOR_PROMPT_VERSION);

    vi.resetModules();
    vi.doMock('../genre/index', async () => {
      const actual = await vi.importActual<typeof import('../genre/index')>('../genre/index');
      const voyage = { ...actual.GENRE_MODULES.voyage, cues: [...actual.GENRE_MODULES.voyage.cues, 'glide'] };
      return { ...actual, GENRE_MODULES: { ...actual.GENRE_MODULES, voyage } };
    });
    const mocked = await import('../director/prompt');
    expect(mocked.DIRECTOR_PROMPT_VERSION).not.toBe(DIRECTOR_PROMPT_VERSION);
    vi.doUnmock('../genre/index');
    vi.resetModules();
  });
});
