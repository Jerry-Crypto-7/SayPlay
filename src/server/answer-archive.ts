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

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { UpstreamRequest } from '../model/prompt';
import { CODEX_CLI_ENDPOINT, type UpstreamConfig } from './upstream';

export const REDACTED = '[redacted]';

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
  write(call: number, request: UpstreamRequest, answer: unknown): Promise<void>;
}

/** Nahradí známé literály v celém stromu. Vstup se nemění. */
function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string')
    return secrets.reduce((carry, secret) => carry.split(secret).join(REDACTED), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>))
      clean[key] = redact(nested, secrets);
    return clean;
  }
  return value;
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
): AnswerArchive | null {
  const dir = env.WORLDSMITH_ARCHIVE_DIR;
  if (dir === undefined || dir.length === 0) return null;

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
  const caseId = randomUUID();

  return {
    caseId,
    async write(call: number, request: UpstreamRequest, answer: unknown): Promise<void> {
      const entry: ArchiveEntry = {
        caseId,
        call,
        request: redact({ model: request.model, system: request.system, user: request.user }, secrets),
        answer: redact(answer, secrets),
      };
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${caseId}-${String(call)}.json`), JSON.stringify(entry, null, 2), 'utf8');
    },
  };
}
