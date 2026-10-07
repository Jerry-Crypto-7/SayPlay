/**
 * Sdílený modul veřejných vad: co smí ven a jak často se o vadě dozví operátor.
 *
 * Měří se přímo na funkcích modulu. Dveře, které ho kdysi volaly (`/api/emit`,
 * `/api/edit`, `/api/generate`), odešly se starým studiem; `/api/health` ho
 * používá dál.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_DETAILS_PER_WINDOW,
  PUBLIC_CORPUS_FAULT,
  RATE_LIMIT_WINDOW_MS,
  STICKY_WINDOW_MS,
  withoutCredentials,
} from '../public-faults';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

/**
 * **Klíč lepivého zápisu je `detail`, ne kód** — a tohle je jediné místo, kde
 * se to dá soudit přímo.
 *
 * Nezávislá revize to změřila jako mrtvou vlastnost: mutace `has(detail)` →
 * `has(code)` nechala celou tehdejší sadu zelenou, přestože pod tím mutantem
 * **druhý a třetí rozbitý záznam mlčí napořád**. Šlo to jen proto, že funkce
 * byla soukromá uvnitř routy a nikdo ji nevolal přímo. Od 1. 9. 2026 bydlí
 * v `public-faults.ts`, takže tenhle test existovat může.
 */
describe('the sticky bound keys on the fault, not on its code', () => {
  async function sticky(): Promise<{
    readonly log: string[];
    readonly write: typeof import('../public-faults').logStickyFault;
  }> {
    const log = captureLog();
    vi.resetModules();
    return { log, write: (await import('../public-faults')).logStickyFault };
  }

  it('two broken records give two lines, a thousand requests on one give one', async () => {
    const { log, write } = await sticky();

    write('generate', 'req-1', 'NO_FROZEN_ANSWER', 'no frozen create response for C01');
    // Týž kód, týž vchod, **jiný záznam**. Kdyby se klíčovalo kódem, tenhle
    // řádek zmizí — a s ním každá další díra ve zmrazené sadě.
    write('generate', 'req-2', 'NO_FROZEN_ANSWER', 'no frozen create response for C02');
    // A tisíc požadavků na ten první pořád jeden řádek.
    for (let attempt = 0; attempt < 1000; attempt += 1)
      write('generate', `flood-${attempt}`, 'NO_FROZEN_ANSWER', 'no frozen create response for C01');

    expect(log).toHaveLength(2);
    expect(log[0]).toContain('req-1');
    expect(log[1]).toContain('req-2');
    expect(log.join('\n'), 'bound neplatí — opakování téže vady se zapsalo znovu').not.toContain(
      'flood-',
    );
  });

  /**
   * **Opravená vada, která se vrátí, není táž událost.**
   *
   * Nález nezávislé revize 1. 9. 2026 (`VERDICT: routed`, LOW): „jednou za
   * proces" mlčí i po opravě, takže operátor, který rozbitý zmrazený záznam
   * spraví a ten se v témž procesu rozejde znovu se stejným textem, nedostane
   * **nic** — a mlčící kanál vypadá v logu přesně jako zdravý server.
   *
   * Ten bound se přitom rušit nesmí: tisíc požadavků na jeden rozbitý záznam
   * je pořád jeden řádek. Obojí se proto soudí v jednom testu, protože každá
   * půlka bez té druhé je vada.
   */
  it('names a fault again once it was repaired and came back', async () => {
    const { log, write } = await sticky();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const broken = 'responses/index.jsonl is not readable';
    write('emit', 'req-1', 'CORPUS_UNREADABLE', broken);
    for (let attempt = 0; attempt < 1000; attempt += 1)
      write('emit', `flood-${attempt}`, 'CORPUS_UNREADABLE', broken);
    expect(log, 'bound neplatí — opakování téže vady se zapsalo znovu').toHaveLength(1);

    // Těsně pod hranou okna pořád ticho. Tenhle zápis navíc soudí, že okno
    // běží od posledního ZÁPISU, ne od posledního výskytu: kdyby ho posouval
    // každý potlačený požadavek, trvalá porucha pod trvalým provozem by se
    // nepřipomněla nikdy — táž vada, jen naruby.
    now += STICKY_WINDOW_MS - 1;
    write('emit', 'inside-window', 'CORPUS_UNREADABLE', broken);
    expect(log, 'lepivá mez se rozpadla na řádek za požadavek').toHaveLength(1);

    // Oprava, návrat — a operátor se to dozví.
    now += 1;
    write('emit', 'came-back', 'CORPUS_UNREADABLE', broken);
    expect(log, 'vada se vrátila a operátor se to nedozvěděl').toHaveLength(2);
    expect(log[1]).toContain('came-back');
    expect(log[1]).toContain(broken);
  });

  it('and on the door, so one broken corpus is still named by each door that hits it', async () => {
    const { log, write } = await sticky();

    write('emit', 'req-1', 'CORPUS_UNREADABLE', 'responses/index.jsonl is not readable');
    // Táž vada, jiné dveře. Řádek jmenuje **které dveře mluví**, takže sdílet
    // klíč napříč vchody by tu informaci zahodilo hned u druhého z nich.
    write('edit', 'req-2', 'CORPUS_UNREADABLE', 'responses/index.jsonl is not readable');

    expect(log).toHaveLength(2);
    expect(log[0]).toContain('[emit]');
    expect(log[1]).toContain('[edit]');
  });
});

/* ------------------------------------------------------------------ *
 * Vlastnosti sdíleného modulu.
 * ------------------------------------------------------------------ */

describe('the operator log is rate-limited, never silenced for good', () => {
  /**
   * Měří se přímo na funkci, ne přes routu: přes routu se nedá dojet ke stému
   * výskytu v rozumném čase a klíč by se soudil jen nepřímo.
   */
  async function limiter(): Promise<{ readonly log: string[]; readonly write: typeof import('../public-faults').logRateLimited }> {
    const log: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      log.push(String(line));
    });
    vi.resetModules();
    return { log, write: (await import('../public-faults')).logRateLimited };
  }

  it('writes the 1st, 10th and 100th of the same fault and nothing between', async () => {
    const { log, write } = await limiter();

    for (let attempt = 0; attempt < 250; attempt += 1)
      write('emit', `req-${attempt}`, 'BODY_UNREADABLE', 'the body ended mid-read');

    // 250 požadavků, tři řádky. Milion by dal sedm — logaritmus provozu.
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('(occurrence 1)');
    expect(log[1]).toContain('(occurrence 10)');
    expect(log[2]).toContain('(occurrence 100)');
    // Číslo výskytu je v textu schválně: bez něj vypadá desátý řádek jako
    // první a operátor záplavu nepozná.
    expect(log[1]).toContain('the body ended mid-read');
  });

  /**
   * **Ticho vyprší.** Ne „nedá se koupit" — to by tvrdilo víc, než kód umí, a
   * nezávislá revize přesně tenhle rozdíl 1. 9. 2026 změřila: 100 požadavků na
   * začátku každého okna (400 req/h) drží klíč umlčený natrvalo. Co je tady
   * doložené, je že jedna dávka umlčí kanál nejvýš na jedno okno.
   *
   * Hodiny se podvrhují `Date.now()`, protože přesně to okno čte. Na replay
   * cestě by to byl zákaz z `CLAUDE.md`; tady je to operátorův log serveru.
   */
  it('lets a bought silence expire with the window instead of standing for the process', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    // Předplacené umlčení: sto laciných selhání, tři řádky (1., 10., 100.).
    for (let attempt = 0; attempt < 100; attempt += 1)
      write('emit', `paid-${attempt}`, 'BODY_UNREADABLE', 'the body ended mid-read');
    expect(log).toHaveLength(3);

    // Táž příčina těsně pod hranou okna pořád mlčí — jinak by mez neexistovala.
    // Tenhle zápis zároveň soudí, že se okno kotví na svém PRVNÍM výskytu:
    // kdyby ho posouval každý další, útočník by ho držel otevřený napořád.
    now += RATE_LIMIT_WINDOW_MS - 1;
    write('emit', 'inside-window', 'BODY_UNREADABLE', 'the body ended mid-read');
    expect(log, 'okno neplatí — mez se rozpadla na řádek na požadavek').toHaveLength(3);

    // A hned za ní se táž příčina ohlásí PRVNÍM řádkem, ne stým prvním.
    now += 1;
    write('emit', 'after-window', 'BODY_UNREADABLE', 'the body ended mid-read');
    expect(log, 'ticho nevypršelo — počítadlo je zase na celý proces').toHaveLength(4);
    expect(log[3]).toContain('after-window');
    expect(log[3]).toContain('(occurrence 1)');
  });

  /**
   * **Příčina, kterou operátor ještě neviděl, se vydá i uvnitř koupeného ticha.**
   *
   * Tohle je to, co z vypršení dělá obranu i během okna: útočník drží počítadlo
   * nahoře **jednou** příčinou („aborted"), ale rozbitá proxy nese jinou hlášku,
   * takže projde hned. Bez tohohle pravidla dostal operátor v osmihodinovém
   * měření revize 96 řádků útočníka a nula o poruše, která padla 28 768krát.
   */
  it('always names a cause it has not seen in this window, even while another is flooding', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    for (let attempt = 0; attempt < 100; attempt += 1)
      write('emit', `paid-${attempt}`, 'BODY_UNREADABLE', 'aborted');
    expect(log).toHaveLength(3);

    // Uprostřed okna, dávno za posledním milníkem, a přece slyšet.
    now += 60_000;
    write('emit', 'proxy-1', 'BODY_UNREADABLE', 'Premature close');
    expect(log, 'nová příčina se ztratila pod cizím počítadlem').toHaveLength(4);
    expect(log[3]).toContain('proxy-1');
    expect(log[3]).toContain('Premature close');

    // Ale opakování téže příčiny už ne — jinak by pravidlo mez zrušilo.
    write('emit', 'proxy-2', 'BODY_UNREADABLE', 'Premature close');
    expect(log, 'opakovaná příčina obchází mez').toHaveLength(4);
  });

  /**
   * **A ten rozpočet je omezený, ale patří oknu** — obojí v jednom testu,
   * protože každá půlka bez té druhé je vada:
   *
   * - bez stropu by stačilo měnit hlášku a pravidlo o nové příčině by z meze
   *   udělalo řádek na požadavek;
   * - bez vrácení s oknem by osm příčin umlčelo devátou **napořád**, tedy táž
   *   předplacená tichost o patro níž. Mutace, která množinu příčin ponese
   *   přes hranu okna, musí položit druhou půlku — a nesmí položit první.
   */
  it('spends at most a fixed budget of causes per window, and gets it back with the window', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const causes = MAX_DETAILS_PER_WINDOW * 2 + 4;
    for (let attempt = 0; attempt < causes; attempt += 1)
      write('emit', `req-${attempt}`, 'BODY_UNREADABLE', `cause ${attempt}`);

    // Osm příčin (0..7) plus desátý výskyt jako milník — devět řádků z dvaceti.
    expect(log, `${causes} různých příčin nesmí dát řádek na požadavek`).toHaveLength(
      MAX_DETAILS_PER_WINDOW + 1,
    );
    expect(log.join('\n')).toContain('cause 7');
    expect(log.join('\n'), 'rozpočet příčin neplatí').not.toContain('cause 19');

    // Nové okno. První zápis je milník, takže se vydá tak či tak — je tu jen
    // proto, aby ten druhý padl na výskyt, který milník NENÍ, a rozhodovalo
    // o něm výhradně to, jestli se rozpočet příčin vrátil.
    now += RATE_LIMIT_WINDOW_MS;
    write('emit', 'fresh-1', 'BODY_UNREADABLE', 'cause 0');
    const spent = log.length;
    write('emit', 'fresh-2', 'BODY_UNREADABLE', 'a cause never seen before');

    expect(log, 'rozpočet příčin se s oknem nevrátil').toHaveLength(spent + 1);
    expect(log[log.length - 1]).toContain('fresh-2');
  });

  it('keeps each key on its own window, so one noisy door cannot mute another', async () => {
    const { log, write } = await limiter();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    write('emit', 'req-1', 'BODY_UNREADABLE', 'first');
    // Druhý klíč začíná své okno až tady, takže o hranu toho prvního nezavadí.
    now += RATE_LIMIT_WINDOW_MS - 1;
    write('edit', 'req-2', 'BODY_UNREADABLE', 'second');
    now += 2;
    // První klíč je za hranou (nové okno), druhý pořád ve svém. Obojí opakuje
    // příčinu, kterou ten klíč už v tomhle okně vydal — jinak by o tom, co se
    // vydá, rozhodlo pravidlo o nové příčině a ne okno.
    write('emit', 'req-3', 'BODY_UNREADABLE', 'first');
    write('edit', 'req-4', 'BODY_UNREADABLE', 'second');

    expect(log).toHaveLength(3);
    expect(log.join('\n')).toContain('req-3');
    expect(log.join('\n')).not.toContain('req-4');
  });

  it('keys on the code as well as the door, so a second fault is never swallowed', async () => {
    const { log, write } = await limiter();

    write('emit', 'req-1', 'BODY_UNREADABLE', 'first');
    // Jiný kód týchž dveří: kdyby se klíčovalo jen podle dveří, tenhle řádek
    // zmizí a s ním celá druhá třída poruch.
    write('emit', 'req-2', 'CORPUS_UNREADABLE', 'second');
    // A jiné dveře s týmž kódem, ze stejného důvodu opačným směrem.
    write('edit', 'req-3', 'BODY_UNREADABLE', 'third');
    // Opakování prvního klíče **s touž příčinou** se už nevydá — bound platí.
    // (Jiná příčina by se vydala schválně; to soudí test o rozpočtu příčin.)
    write('emit', 'req-4', 'BODY_UNREADABLE', 'first');

    expect(log).toHaveLength(3);
    expect(log.join('\n')).toContain('req-1');
    expect(log.join('\n')).toContain('req-2');
    expect(log.join('\n')).toContain('req-3');
    expect(log.join('\n')).not.toContain('req-4');
  });
});

describe('the shared table is the only thing the doors are allowed to say', () => {
  /**
   * `Record<ClientReason, string>` hlídá **úplnost** přes `tsc`. Tenhle test
   * hlídá to druhé: že v žádném z těch textů není nic, kvůli čemu tabulka
   * vznikla — číslo, hash ani cesta.
   */
  it('names what happened, never where or with what value', () => {
    const texts = Object.values(PUBLIC_CORPUS_FAULT);
    expect(texts.length).toBeGreaterThanOrEqual(6);

    for (const text of texts) {
      expect(text, `veřejný text nese číslo: „${text}"`).not.toMatch(/\d/);
      expect(text, `veřejný text nese cestu: „${text}"`).not.toMatch(/[/\\]/);
      expect(text).toBe(text.trim());
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('strips a password out of an address wherever it sits in the line', () => {
    expect(withoutCredentials('at https://operator:hunter2@upstream.invalid/v1')).toBe(
      'at https://<credentials>@upstream.invalid/v1',
    );
    expect(withoutCredentials('operator:hunter2@upstream.invalid')).toBe(
      '<credentials>@upstream.invalid',
    );
    expect(withoutCredentials('nothing to strip here')).toBe('nothing to strip here');
  });
});
