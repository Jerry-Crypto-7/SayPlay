/**
 * **Co model doopravdy napsal — na disku, bez klíče v souboru** (P19 T1).
 *
 * Deset běhů z P18 se neuložilo: zůstaly obrázky a časy, takže se dnes nedá
 * říct, ve které fázi se akvárium ztratilo. Tenhle archiv tu díru zavírá, a
 * měří se tady **dvě** věci naráz, protože každá sama by byla past:
 *
 * 1. **Že soubor vznikne** — jinak je celá P19 fáze 1 slepá stejně jako P18.
 * 2. **Že v něm není klíč ani adresa koncového bodu.** Přesně tahle vada se
 *    v repu už stala (`evals/worldstream/measure-create.ts:817-828`): hláška
 *    `fetch`e nesla celou adresu s klíčem v query stringu až do commitnutého
 *    souboru. `plans/` je sice mimo git, ale klíč na disku v nešifrovaném
 *    souboru je klíč na disku.
 *
 * Jede se přes **skutečný `cloudEmitter()`**, ne přes samotnou funkci archivu:
 * atrapa je jedině poskytovatel. Zápis na disk ani redakce se nedublují —
 * to jsou ty dvě věci, které se tu měří.
 *
 * **Falešný klíč tu schválně nemá tvar klíče poskytovatele.** Redakce stojí na
 * literálech z `UpstreamConfig`, ne na uhodnutých vzorech, takže tvar „jako od
 * Anthropicu" by netestoval nic navíc — jen by rozsvítil detektor tajemství
 * nad souborem, který žádné tajemství nenese.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerArchive } from '../answer-archive';
import { resetProcessSpendCap } from '../spend-cap';
import { upstreamConfigFromEnv } from '../upstream';

/**
 * Klíč a adresa, jak je uvidí konfigurace. **Adresa nese pověření v query
 * stringu** schválně — je to ten tvar, který vadu z 31. 8. 2026 vyrobil.
 */
const KEY = 'worldsmith-fake-credential-0123456789';
const ENDPOINT = 'https://internal-provider.example.com/v1/messages?credential=FAKE0123456789';

/** Odpověď, kterou atrapa poskytovatele vrátí. */
const ANSWER_BODY = {
  world: 'a dentist waiting room with an aquarium',
  note: `if this ever breaks call ${ENDPOINT} with ${KEY}`,
};

const generate = vi.fn();

vi.mock('../upstream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../upstream')>();
  return {
    ...actual,
    // Atrapa poskytovatele. `worstCaseUsd` je nula, takže strop nikoho
    // neodmítá a předmětem testu zůstane archiv; `usage: null` uzavře
    // rezervaci jako „neznámá spotřeba" a vyhne se ceníku.
    upstreamBranch: () => ({
      worstCaseUsd: () => 0,
      pricing: { usdPerMTokIn: 1, usdPerMTokOut: 1 },
      generate,
    }),
  };
});

const temporary: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** Prostředí s nakonfigurovanou živou větví. Archivní adresář se dosazuje zvlášť. */
function configure(archiveDir: string | null): void {
  vi.stubEnv('WORLDSMITH_MODEL_ENDPOINT', ENDPOINT);
  vi.stubEnv('WORLDSMITH_MODEL_KEY', KEY);
  vi.stubEnv('WORLDSMITH_MODEL_PROFILE', 'subscription');
  vi.stubEnv('WORLDSMITH_CALL_CAP', '10');
  vi.stubEnv('WORLDSMITH_USD_PER_MTOK_OUT', '1');
  vi.stubEnv('WORLDSMITH_MODEL', 'gpt-6-astra');
  if (archiveDir !== null) vi.stubEnv('WORLDSMITH_ARCHIVE_DIR', archiveDir);
}

/** Jedna věta poslaná emitorem, jak ji posílá produkt. */
const REQUEST = {
  model: 'gpt-6-astra',
  system: 'you write worlds',
  user: 'a dentist waiting room with an aquarium',
} as const;

beforeEach(() => {
  generate.mockReset();
  generate.mockResolvedValue({ ok: true, body: ANSWER_BODY, usage: null });
});

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetProcessSpendCap();
});

/** Konfigurace živé větve, jak ji postaví produkt. */
function liveConfig() {
  const config = upstreamConfigFromEnv({
    WORLDSMITH_MODEL_ENDPOINT: ENDPOINT,
    WORLDSMITH_MODEL_KEY: KEY,
    WORLDSMITH_MODEL_PROFILE: 'subscription',
    WORLDSMITH_CALL_CAP: '10',
    WORLDSMITH_USD_PER_MTOK_OUT: '1',
  });
  expect(config).not.toBeNull();
  return config!;
}

describe('archiv odpovědí modelu', () => {
  /**
   * **Tohle je ta aserce, která drží „nenastaveno znamená nikam".**
   *
   * Sledovat prázdný adresář nestačí: archiv, který by si při nenastavené
   * proměnné vybral **jinou** cestu — pracovní adresář, `tmp` — by nad
   * prázdným scratchem prošel a klíč by ležel někde jinde. Soudí se proto
   * rozhodnutí samo: bez proměnné se archiv nepostaví vůbec.
   */
  it('bez proměnné se archiv vůbec nepostaví', () => {
    const config = liveConfig();
    expect(answerArchive({}, config)).toBeNull();
    expect(answerArchive({ WORLDSMITH_ARCHIVE_DIR: '' }, config)).toBeNull();
  });

  it('bez nastavené proměnné nezapíše na disk nic', async () => {
    const dir = scratch('worldsmith-archive-off-');
    configure(null);

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    expect(emit).not.toBeNull();
    await emit!(REQUEST);

    expect(readdirSync(dir)).toEqual([]);
  });

  it('s nastavenou proměnnou uloží větu i odpověď modelu', async () => {
    const dir = scratch('worldsmith-archive-on-');
    configure(dir);

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    await emit!(REQUEST);

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as {
      call: number;
      request: { user: string; system: string; model: string };
      answer: { world: string };
    };
    expect(entry.call).toBe(1);
    expect(entry.request.user).toBe(REQUEST.user);
    expect(entry.request.system).toBe(REQUEST.system);
    expect(entry.answer.world).toBe(ANSWER_BODY.world);
  });

  it('druhé volání téhož emitoru je druhý soubor, ne přepsaný první', async () => {
    const dir = scratch('worldsmith-archive-two-');
    configure(dir);

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    await emit!(REQUEST);
    await emit!({ ...REQUEST, user: 'a beach at dusk' });

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const calls = files.map(
      (name) => (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { call: number }).call,
    );
    expect(calls.sort()).toEqual([1, 2]);
  });

  /**
   * **Jádro věci.** Klíč i adresa jdou tudy v obou směrech: v požadavku
   * (systémový prompt, který je nese) i v odpovědi (poskytovatel, který je
   * vrátí v hlášce). Soudí se celý soubor jako text, ne vybraná pole —
   * kdekoli v tom stromu je ten literál, je to únik.
   */
  it('klíč ani adresa koncového bodu se do souboru nedostanou', async () => {
    const dir = scratch('worldsmith-archive-secret-');
    configure(dir);

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    await emit!({
      ...REQUEST,
      system: `call ${ENDPOINT} with ${KEY} if the grammar is missing`,
    });

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(ENDPOINT);
    expect(raw).toContain('[redacted]');
    // Redakce nesmí sežrat zbytek věty — jinak je archiv prázdný a nikdo si
    // toho nevšimne, protože „klíč tam není" platí i nad smazaným souborem.
    expect(raw).toContain('if the grammar is missing');
  });

  /**
   * **Sentinel se neredaguje.** `codex-cli` neznamená adresu, ale „žádná
   * adresa, spusť CLI" — a je to zároveň slovo, které model umí napsat. Slepá
   * záměna podřetězce by z archivu vymazala obsah, kvůli kterému vzniká,
   * a nikdo by si toho nevšiml: „klíč tam není" platí i nad rozžvýkaným
   * souborem. Klíč se přitom maže dál.
   */
  it('sentinel codex-cli zůstane, klíč zmizí', async () => {
    const dir = scratch('worldsmith-archive-cli-');
    configure(dir);
    vi.stubEnv('WORLDSMITH_MODEL_ENDPOINT', 'codex-cli');
    generate.mockResolvedValue({
      ok: true,
      body: { world: 'a codex-cli terminal glowing on a desk' },
      usage: null,
    });

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    await emit!({ ...REQUEST, system: `run codex-cli with ${KEY}` });

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw).toContain('a codex-cli terminal glowing on a desk');
    expect(raw).toContain('run codex-cli with [redacted]');
    expect(raw).not.toContain(KEY);
  });

  it('chyba zápisu neshodí generování světa', async () => {
    const dir = scratch('worldsmith-archive-blocked-');
    // Souborem místo adresáře: `mkdir` na tuhle cestu selže vždycky a všude.
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x', 'utf8');
    configure(join(blocked, 'answers'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();

    await expect(emit!(REQUEST)).resolves.toEqual(ANSWER_BODY);
  });

  /**
   * **Nula souborů po deseti zaplacených voláních nesmí vypadat jako běh,
   * který se nearchivoval.** Hlásí se jednou za emitor: deset stejných řádků
   * je tentýž šum jako ticho.
   */
  it('selhání zápisu se ohlásí jednou, ne na každé volání', async () => {
    const dir = scratch('worldsmith-archive-warn-');
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x', 'utf8');
    configure(join(blocked, 'answers'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    await emit!(REQUEST);
    await emit!(REQUEST);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('the answer archive could not be written');
  });
});
