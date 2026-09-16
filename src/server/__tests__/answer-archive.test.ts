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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerArchive, wouldBeCommitted } from '../answer-archive';
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

  /**
   * **Archiv nese plné znění promptů a repo jde ven** (`RULES.md` §2).
   * Adresář, který git nevidí jako ignorovaný, se odmítne — nezáleží na tom,
   * kam ho operátor namíří. Soudí se nad skutečným `.gitignore` tohohle repa.
   */
  it('odmítne adresář, který by git vzal do commitu', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(wouldBeCommitted('src/server/answers')).toBe(true);
    expect(answerArchive({ WORLDSMITH_ARCHIVE_DIR: 'src/server/answers' }, liveConfig())).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('pustí ignorovaný adresář i cestu mimo repozitář', () => {
    expect(wouldBeCommitted('plans/P19/answers')).toBe(false);
    expect(wouldBeCommitted(scratch('worldsmith-archive-outside-'))).toBe(false);
    expect(answerArchive({ WORLDSMITH_ARCHIVE_DIR: 'plans/P19/answers' }, liveConfig())).not.toBeNull();
  });

  /** Absolutní cesta do cizího repa soudí jeho `.gitignore`, ne náš. */
  it('v cizím repozitáři rozhoduje jeho check-ignore, bez gitu se archiv vypne', () => {
    const repo = scratch('worldsmith-archive-foreign-');
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
    expect(wouldBeCommitted(join(repo, 'answers'))).toBe(true);
    expect(wouldBeCommitted(join(repo, 'ignored', 'answers'))).toBe(false);

    // Jen jednou: Windows nedbá velikosti písmen a druhý stub `Path` by si jako
    // původní hodnotu zapamatoval už prázdnou – PATH by zůstal prázdný i dál.
    vi.stubEnv('PATH', '');
    expect(wouldBeCommitted(scratch('worldsmith-archive-nogit-'))).toBe(true);
  });

  /** Git vrací 128 i repu, kterému nevěří – to ale commitovat umí. */
  it('nedůvěryhodné repo archiv vypne, nepustí ho', () => {
    vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
    expect(wouldBeCommitted('src/newdir')).toBe(true);
  });

  it('proměnné GIT_* přesměrování gitu archiv nepustí', () => {
    vi.stubEnv('GIT_DIR', join(scratch('worldsmith-archive-gitdir-'), 'none'));
    expect(wouldBeCommitted('src/server/answers')).toBe(true);
  });

  /** Ignorovaný jen `answer.json` neříká nic o `<relace>-<n>.json`, které se zapíšou. */
  it('soudí jméno souboru, jaké archiv opravdu zapíše', () => {
    const repo = scratch('worldsmith-archive-name-');
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    writeFileSync(join(repo, '.gitignore'), 'answer.json\n');
    expect(wouldBeCommitted(join(repo, 'answers'))).toBe(true);
  });

  it('každé volání soudí své vlastní jméno, ne jen první', async () => {
    const repo = scratch('worldsmith-archive-each-');
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    writeFileSync(join(repo, '.gitignore'), '*-1.json\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = join(repo, 'answers');
    const archive = answerArchive({ WORLDSMITH_ARCHIVE_DIR: dir }, liveConfig());
    await archive!.write(REQUEST, { n: 1 });
    await archive!.write(REQUEST, { n: 2 });
    expect(readdirSync(dir)).toEqual([`${archive!.caseId}-1.json`]);
  });

  /** Git junction projde a ohlásí „mimo repozitář" (128); cesta na disku `.git` nemá. */
  it('junction do cizího repa archiv vypne', () => {
    const repo = scratch('worldsmith-archive-junction-');
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    mkdirSync(join(repo, 'sub'));
    const link = join(scratch('worldsmith-archive-link-'), 'link');
    symlinkSync(join(repo, 'sub'), link, 'junction');
    expect(wouldBeCommitted(link)).toBe(true);

    // Nefunkční junction: cíl ještě neexistuje, `existsSync` odkaz nevidí.
    const dangling = join(scratch('worldsmith-archive-dangling-'), 'link');
    symlinkSync(join(repo, 'later'), dangling, 'junction');
    expect(wouldBeCommitted(join(dangling, 'answers'))).toBe(true);
  });

  /** `subst` disk není odkaz; git ho dovede do repa a ohlásí 128. */
  it.runIf(process.platform === 'win32')('subst disk do podadresáře repa archiv vypne', () => {
    const repo = scratch('worldsmith-archive-subst-');
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    mkdirSync(join(repo, 'src'));
    const letter = [...'QRSTUVWXYZ'].find((candidate) => !existsSync(`${candidate}:\\`));
    expect(letter, 'žádné volné písmeno disku').toBeDefined();
    expect(spawnSync('subst', [`${letter}:`, join(repo, 'src')]).status).toBe(0);
    try {
      expect(wouldBeCommitted(`${letter}:/answers`)).toBe(true);
    } finally {
      spawnSync('subst', [`${letter}:`, '/D']);
    }
  });

  it('konfigurace gitu z prostředí ignorování nepodvrhne', () => {
    const excludes = join(scratch('worldsmith-archive-excludes-'), 'ignore');
    writeFileSync(excludes, '*\n');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.excludesFile');
    vi.stubEnv('GIT_CONFIG_VALUE_0', excludes);
    expect(wouldBeCommitted('src/server/answers')).toBe(true);

    // Totéž přes globální konfiguraci v podvrženém domově.
    vi.unstubAllEnvs();
    const home = scratch('worldsmith-archive-home-');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${excludes.replaceAll('\\', '/')}\n`);
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    expect(wouldBeCommitted('src/server/answers')).toBe(true);
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

  /**
   * Chyba sandboxu na větvi `codex-cli` nese v `detail` cestu do profilu,
   * tedy skutečné jméno uživatele. Do archivu se dostane jen značka.
   */
  it('domovskou cestu z chybového výstupu nahradí značkou', async () => {
    const dir = scratch('worldsmith-archive-home-');
    configure(dir);
    const home = 'C:\\Users\\jane.doe';
    vi.stubEnv('USERPROFILE', home);
    generate.mockResolvedValue({
      ok: false,
      reason: 'MODEL_UNAVAILABLE',
      detail: `spawn failed: ${home}\\AppData\\Roaming\\npm\\codex.cmd and C:/Users/jane.doe/.codex`,
      usage: null,
    });

    const { cloudEmitter } = await import('../worldstream-emitter');
    const emit = await cloudEmitter();
    await expect(emit!(REQUEST)).rejects.toThrow();

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw).not.toContain('jane.doe');
    expect(raw).toContain('[home]');
    expect(raw).toContain('codex.cmd');
  });

  /**
   * `upstream.ts` ukládá chybu přes `JSON.stringify`, takže lomítka v `detail`
   * jsou zdvojená; stderr je navíc useknuté a může skončit uprostřed cesty.
   */
  it('domov nenajde ani ve zdvojených lomítkách, malými písmeny a useknutý', async () => {
    const dir = scratch('worldsmith-archive-escaped-');
    const home = 'C:\\Users\\Jane.Doe';
    const archive = answerArchive({ WORLDSMITH_ARCHIVE_DIR: dir, USERPROFILE: home }, liveConfig());
    await archive!.write(REQUEST, {
      detail: JSON.stringify({ reason: 'MODEL_UNAVAILABLE', detail: `spawn ${home}\\AppData\\codex.cmd` }),
      lower: 'c:\\users\\jane.doe\\.codex',
      cut: 'sandbox denied C:\\Users\\jane.doe\\AppDa',
      bare: 'owner jane.doe',
    });

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw.toLowerCase()).not.toContain('jane.doe');
    expect(raw).toContain('codex.cmd');
    expect(raw).toContain('owner [home]');
  });

  /** `upstream.ts` krátí stderr na 300 znaků, a řez může padnout doprostřed jména. */
  it('useknuté jméno na konci detailu zamaskuje, jméno uvnitř slova nechá být', async () => {
    const dir = scratch('worldsmith-archive-cut-');
    const archive = answerArchive({ WORLDSMITH_ARCHIVE_DIR: dir, USERPROFILE: 'C:\\Users\\jane.doe', HOME: '/root' }, liveConfig());
    await archive!.write(REQUEST, {
      cut: 'codex exec exited with code 1 sandbox: C:\\Users\\jane.d',
      json: 'codex refused the turn: {"message":"C:\\\\Users\\\\tom',
      prose: 'rooted grass and roots, a root cellar',
      bracket: 'user [jane.doe] denied',
      encoded: 'GET /files?p=C:%5CUsers%5Cjane.d',
      'C:\\Users\\jane.doe': 'key',
    });

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw).not.toContain('jane.d');
    expect(raw).not.toMatch(/Users\\\\+tom/);
    expect(raw).toContain('rooted grass and roots, a [home] cellar');
  });

  it('krátké jméno 8.3 z TEMP zamaskuje', async () => {
    const dir = scratch('worldsmith-archive-short-');
    const archive = answerArchive(
      { WORLDSMITH_ARCHIVE_DIR: dir, USERPROFILE: 'C:\\Users\\jane.doe', TEMP: 'C:\\Users\\JANEDO~1\\AppData\\Local\\Temp' },
      liveConfig(),
    );
    await archive!.write(REQUEST, { detail: 'sandbox: C:\\Users\\JANEDO~1\\AppData\\Local\\Temp\\codex-x denied' });

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw).not.toContain('JANEDO~1');
    expect(raw).toContain('codex-x denied');
  });

  it('krátké jméno najde i v TEMP s předponou \\\\?\\', async () => {
    const dir = scratch('worldsmith-archive-long-');
    const archive = answerArchive({ WORLDSMITH_ARCHIVE_DIR: dir, TEMP: '\\\\?\\C:\\Users\\JANEDO~1\\AppData\\Local\\Temp' }, liveConfig());
    await archive!.write(REQUEST, { detail: 'owner JANEDO~1 denied' });
    expect(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')).not.toContain('JANEDO~1');
  });

  it('z TEMP bere jen jméno pod X:\\Users, ne společný profil ani hlubší Users', async () => {
    const dir = scratch('worldsmith-archive-shared-');
    const detail = 'Public build by bob';
    for (const temp of ['C:\\Users\\Public\\Temp', 'D:\\build\\Users\\bob\\tmp']) {
      const archive = answerArchive({ WORLDSMITH_ARCHIVE_DIR: dir, USERPROFILE: 'C:\\Users\\jane.doe', TEMP: temp, TMP: temp }, liveConfig());
      await archive!.write(REQUEST, { detail });
    }
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), 'utf8')).toContain(detail);
  });

  it('krátký domov jako HOME=/ nepřepíše každé lomítko', async () => {
    const dir = scratch('worldsmith-archive-root-');
    const archive = answerArchive({ WORLDSMITH_ARCHIVE_DIR: dir, HOME: '/', USERPROFILE: 'C:' }, liveConfig());
    await archive!.write(REQUEST, { detail: 'see /usr/local/bin/codex' });

    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8');
    expect(raw).toContain('see /usr/local/bin/codex');
  });

  /**
   * Druhá věta staví nový emitor. S id relace musí pokračovat v číslování
   * téže relace, jinak nový soubor nese `call: 1` a nedá se spojit se světem.
   */
  it('dvě věty nad touž relací skončí pod týmž caseId s rostoucím call', async () => {
    const dir = scratch('worldsmith-archive-session-');
    configure(dir);
    const sessionId = 'f0e1d2c3-b4a5-4697-8899-aabbccddeeff';

    const { cloudEmitter } = await import('../worldstream-emitter');
    await (await cloudEmitter(sessionId))!(REQUEST);
    await (await cloudEmitter(sessionId))!({ ...REQUEST, user: 'make the aquarium bigger' });

    const entries = readdirSync(dir).map(
      (name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { caseId: string; call: number },
    );
    expect(entries.map((entry) => entry.caseId)).toEqual([sessionId, sessionId]);
    expect(entries.map((entry) => entry.call).sort()).toEqual([1, 2]);
  });

  it('id relace, které by opustilo adresář, nahradí vlastním', async () => {
    const dir = scratch('worldsmith-archive-escape-');
    configure(join(dir, 'answers'));

    const { cloudEmitter } = await import('../worldstream-emitter');
    await (await cloudEmitter('../escaped'))!(REQUEST);

    expect(readdirSync(dir)).toEqual(['answers']);
    const [name] = readdirSync(join(dir, 'answers'));
    expect(name).not.toContain('escaped');
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
