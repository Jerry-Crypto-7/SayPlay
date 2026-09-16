/**
 * **Co model doopravdy napsal, na disku** (P19 T1).
 *
 * P18 změřilo deset vět a uložilo z nich obrázky a časy — ne odpovědi. Když
 * pak brána skončila 2 z 10, nedalo se říct, jestli se akvárium ztratilo
 * v plánovači, v kompilátoru, nebo až ve stavbě: ta data prostě nebyla.
 * Codex CLI navíc běží s `--ephemeral`, takže po něm nezůstane ani stopa.
 *
 * ## Dvě věci naráz, a ta druhá je důvod, proč tenhle soubor existuje zvlášť
 *
 * Zapsat odpověď je triviální. Zapsat ji **bez klíče a bez adresy koncového
 * bodu** není, a v tomhle repu to už jednou selhalo: hláška `fetch`e nese
 * celou adresu („Failed to parse URL from …"), a když ta adresa má pověření
 * v query stringu, doputuje klíč do souboru na disku. Rozpad té vady je
 * v `evals/worldstream/measure-create.ts:817-828`.
 *
 * **Redakce stojí na literálech z konfigurace, ne na uhodnutých vzorech.**
 * Vzor umí jen tvary, které někdo předem uhodl; klíč a adresa jsou naopak
 * přesně známé řetězce, a emitor je jediný, kdo je drží. Adresa má tutéž váhu
 * jako klíč: nese jméno vnitřního stroje a umí nést pověření.
 *
 * ⚠ **Neopisuje se `evals/worldstream/measure-create.ts`.** `src/server/**`
 * a `evals/**` jsou oddělené vrstvy a jejich archivy o sobě vědět nesmějí —
 * tenhle běží za živého provozu u porotce, ten druhý v měřicím běhu.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { UpstreamRequest } from '../model/prompt';
import { CODEX_CLI_ENDPOINT, type UpstreamConfig } from './upstream';

export const REDACTED = '[redacted]';
export const HOME_MARK = '[home]';

/**
 * Domovské adresáře, jak se můžou objevit v chybovém výstupu Codexu.
 *
 * Větev `codex-cli` nese v `detail` až 300 bajtů stderr a
 * `CODEX_ENV_ALLOWLIST` vědomě propouští `USERPROFILE` / `HOME`, takže
 * chybějící binárka nebo chyba sandboxu zapíše do archivu skutečné jméno
 * uživatele. Kratší než čtyři znaky se nebere: `HOME=/` v kontejneru by
 * jinak přepsalo každé lomítko v souboru.
 *
 * Cesta přichází ve třech tvarech lomítek, protože `upstream.ts` ukládá chybu
 * přes `JSON.stringify` a zpětná lomítka se tím zdvojí; Windows navíc nedbá
 * velikosti písmen. **Samotné jméno uživatele se maskuje taky** (od tří
 * znaků), ale jen jako celé slovo: jméno `root` nebo `tom` by jinak rozžvýkalo
 * „rooted" a „atom" v textu, který P19 T3 analyzuje. Výjimka je `%5C`/`%2F`
 * před jménem, tedy cesta v URL.
 *
 * **Useknuté jméno se maskuje na konci řetězce** (nález revize 16. 9.). Obě
 * místa, kde `upstream.ts` stderr krátí na 300 znaků (`:769`, `:797`), nechají
 * useknutý kus na samém konci `detail`, a `C:\Users\jane.d` nesedí ani na
 * celou cestu, ani na celé jméno. Za lomítkem se proto maskuje i každý
 * začátek jména.
 */
function homesOf(env: Record<string, string | undefined>): readonly RegExp[] {
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const home of [env.USERPROFILE, env.HOME, homedir()]) {
    if (home === undefined || home.length < 4) continue;
    const slashed = home.replaceAll('\\', '/');
    paths.add(home);
    paths.add(slashed);
    paths.add(slashed.replaceAll('/', '\\\\'));
    const name = slashed.split('/').filter((part) => part.length > 0).at(-1);
    if (name !== undefined && name.length >= 3) names.add(name);
  }
  const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const longestFirst = (a: string, b: string): number => b.length - a.length;
  const byName = [...names].sort(longestFirst);
  return [
    ...[...paths].sort(longestFirst).map((path) => new RegExp(escape(path), 'gi')),
    // Hranaté závorky se vylučují jen u jména `home`, aby nepřepsalo vlastní značku.
    ...byName.map((name) => {
      const marker = name.toLowerCase() === 'home';
      return new RegExp(`(?<=^|[^A-Za-z0-9${marker ? '[' : ''}]|%5C|%2F)${escape(name)}(?![A-Za-z0-9${marker ? '\\]' : ''}])`, 'gi');
    }),
    // `jane.doe` → `j(?:a(?:n(?:…)?)?)?`: kterýkoli začátek jména za lomítkem na konci.
    ...byName.map((name) => new RegExp(`(?<=[\\\\/]|%5C|%2F)${[...name].reduceRight((inner, char) => `${escape(char)}(?:${inner})?`, '')}$`, 'i')),
  ];
}

/**
 * Jeden požadavek a jedna odpověď, obojí po redakci.
 *
 * Tvar je schválně týž jako `ArchiveEntry` měřidla, aby analýza z P19 T3
 * četla obojí stejně. `caseId` je tam případ ze sady, tady relace.
 */
export interface ArchiveEntry {
  readonly caseId: string;
  /** Pořadí volání v rámci jedné relace, od jedničky. */
  readonly call: number;
  readonly request: unknown;
  readonly answer: unknown;
}

export interface AnswerArchive {
  /** Id relace, pod kterým tenhle archiv píše. Je i v názvu souboru. */
  readonly caseId: string;
  /** Zapíše další volání relace; číslo volání roste napříč emitory téže relace. */
  write(request: UpstreamRequest, answer: unknown): Promise<void>;
}

/**
 * Poslední číslo volání na relaci. Druhá věta staví nový emitor, a kdyby se
 * počítalo v emitoru, spadla by každá na `call: 1` a přepsala soubor první.
 * Plní se jen s nastaveným archivem, tedy v měřicím běhu, ne u porotce.
 */
const callsByCase = new Map<string, number>();

/** Id relace jde do názvu souboru, takže projde jen tvar, který cestu neopustí. */
const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Nahradí známé literály v celém stromu: tajemství značkou `[redacted]`, domov `[home]`. Vstup se nemění. */
function redact(value: unknown, secrets: readonly string[], homes: readonly RegExp[]): unknown {
  if (typeof value === 'string') {
    const hidden = secrets.reduce((carry, secret) => carry.split(secret).join(REDACTED), value);
    return homes.reduce((carry, home) => carry.replace(home, HOME_MARK), hidden);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, homes));
  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>))
      clean[redact(key, secrets, homes) as string] = redact(nested, secrets, homes);
    return clean;
  }
  return value;
}

/**
 * Leží soubor v tomhle adresáři v cestě, kterou by git vzal do commitu?
 *
 * **Archiv nese plné znění promptů i odpovědí** — tutéž třídu dat jako
 * `evals/live/*` a `create-raw.json`, které `.gitignore` drží venku, protože
 * repo jde podle `RULES.md` §2 ven. Adresář si ale jmenuje operátor, takže
 * pravidlo v `.gitignore` by krylo jen jednu cestu. Soudí se proto každá.
 *
 * Rozhoduje **návratový kód** `git check-ignore`, ne vypsaný řádek: 0 =
 * ignorováno, 1 = git by soubor vzal. Cesta mimo repozitář (128) nebo chybějící
 * git do commitu doputovat nemůže, a tak se pouští.
 */
export function wouldBeCommitted(dir: string, cwd: string = process.cwd()): boolean {
  const probe = spawnSync('git', ['check-ignore', '-q', '--', join(dir, 'answer.json')], { cwd, stdio: 'ignore' });
  return probe.status === 1;
}

/**
 * Archiv, nebo `null`, když ho nikdo neobjednal.
 *
 * **Nenastavená proměnná znamená, že nevznikne žádný soubor** — ne prázdný
 * adresář, ne výchozí cesta. Produkt u porotce archivovat nemá; archivuje se
 * měřicí běh, který si `WORLDSMITH_ARCHIVE_DIR` nastaví sám.
 */
export function answerArchive(
  env: Record<string, string | undefined>,
  config: UpstreamConfig,
  /** Id existující relace (druhá věta); bez něj si archiv razí vlastní. */
  sessionId?: string,
): AnswerArchive | null {
  const dir = env.WORLDSMITH_ARCHIVE_DIR;
  if (dir === undefined || dir.length === 0) return null;
  if (wouldBeCommitted(dir)) {
    console.warn(`[worldstream] the answer archive is off: git would commit ${dir}; point WORLDSMITH_ARCHIVE_DIR at an ignored path`);
    return null;
  }

  // Prázdný literál by nahradil všechno; konfigurace ho sem nepustí, ale
  // filtr je levnější než důvěra v cizí invariant o jeden soubor dál.
  //
  // ⚠ **`codex-cli` je sentinel, ne adresa, a redigovat se nesmí** (nález
  // nezávislé revize 16. 9. 2026). Na téhle větvi žádný koncový bod neexistuje
  // — hodnota znamená „žádná adresa, spusť CLI" (`CODEX_CLI_ENDPOINT`) — takže
  // by ta redakce nechránila nic a přitom vymazala každou zmínku o codex-cli
  // v odpovědi modelu. Mazání je tu slepá záměna podřetězce: co se jednou
  // přepíše na `[redacted]`, se z archivu nedá dostat zpátky, a „klíč tam
  // není" platí i nad rozžvýkaným souborem.
  const secrets = [
    config.apiKey,
    config.endpoint === CODEX_CLI_ENDPOINT ? '' : config.endpoint,
  ].filter((secret) => secret.length > 0);
  const homes = homesOf(env);
  const caseId = sessionId !== undefined && CASE_ID.test(sessionId) ? sessionId : randomUUID();

  return {
    caseId,
    async write(request: UpstreamRequest, answer: unknown): Promise<void> {
      const call = (callsByCase.get(caseId) ?? 0) + 1;
      callsByCase.set(caseId, call);
      const entry: ArchiveEntry = {
        caseId,
        call,
        request: redact({ model: request.model, system: request.system, user: request.user }, secrets, homes),
        answer: redact(answer, secrets, homes),
      };
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${caseId}-${String(call)}.json`), JSON.stringify(entry, null, 2), 'utf8');
    },
  };
}
