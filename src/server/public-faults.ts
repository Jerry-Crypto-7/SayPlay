/**
 * **Jeden veřejný text na jednu vadu zmrazeného korpusu, pro všechny čtyři dveře.**
 *
 * `readFrozen()` (`src/model/client.ts`) skládá detail jako
 * „<soubor> is not readable under <FROZEN_DIR>", a `FROZEN_DIR` je
 * `join(process.cwd(), 'evals', 'frozen')` — **absolutní cesta na disku serveru
 * včetně jména účtu**. Do 31. 8. 2026 ji `/api/generate` posílal neověřenému
 * volajícímu; oprava tam ale zavřela jen jedny dveře ze čtyř. `/api/emit`,
 * `/api/emit/stream` a `/api/edit` vracely `failure.detail` doslova dál.
 *
 * Spouštěč je pravděpodobný, ne teoretický: serverless balíček nemusí
 * `readFileSync(process.cwd() + …)` dohledat vůbec, takže na nasazeném demu
 * odpoví 503 s `/var/task/evals/frozen/…`, a na VPS i se jménem účtu.
 *
 * ## Proč modul, a ne čtyři kopie
 *
 * Protože se to jednou už rozešlo. Čtvrté dveře se opravily a tři zůstaly
 * otevřené právě proto, že každá routa měla svůj vlastní pohled na to, co je
 * „veřejný text". Jeden `Record<ClientReason, string>` navíc dělá z **úplnosti**
 * věc překladače: nový `ClientReason` bez veřejného textu neprojde přes `tsc`
 * v žádné z těch čtyř rout naráz.
 *
 * ## Doktrína, kterou ten modul nese celou
 *
 * Ořezat ven **nestačí** — diagnostika nesmí zmizet, jen se přesunout. Proto sem
 * patří i `logForOperator()`: kdo použije veřejný text, má vedle sebe kanál,
 * kterým pošle ten pravý operátorovi. Bez toho by se jedna vada vyměnila za
 * druhou a rozbitý korpus by nebylo jak najít.
 */

import type { ClientReason } from '../model/client';

/**
 * Co se o vadě zmrazeného korpusu řekne **ven**.
 *
 * Texty jsou anglicky, protože je čte porotce (`CLAUDE.md`, Konvence), a jsou
 * úmyslně bez čísel, cest a hashů: jmenují **co se stalo**, ne kde a s jakou
 * hodnotou. To druhé je v operátorově logu.
 */
export const PUBLIC_CORPUS_FAULT: Record<ClientReason, string> = {
  MANIFEST_MISMATCH: 'the frozen corpus does not match its manifest; no answers will be served',
  CORPUS_UNREADABLE: 'the frozen corpus cannot be read on this server',
  NO_FROZEN_RESPONSE: 'the frozen corpus has no answer for that prompt',
  RESPONSE_TAMPERED: 'a frozen answer failed its own checksum; it will not be served',
  BASE_WORLD_MISMATCH: 'the edit names a different base world than the one that arrived',
  BASE_WORLD_MISSING: 'the frozen corpus is missing the base world that edit names',
};

/**
 * `user:heslo@host` → `<credentials>@host`, kdekoli v textu.
 *
 * Vzor je úmyslně širší než URL: hlášky `fetch`e adresu přeformátovávají a
 * dvakrát ji nesou jinak („Failed to parse URL from …", „…URL that includes
 * credentials: …"). Hledá se proto **dvojice před zavináčem**, ne platná URL.
 */
export function withoutCredentials(text: string): string {
  return text.replace(/(^|[\s(/@])[^\s/@:]+:[^\s/@]*@/g, '$1<credentials>@');
}

/**
 * Diagnostika, která nesmí ven — ale nesmí ani zmizet.
 *
 * Bez tohohle by ořezání veřejných textů vyměnilo jednu vadu za druhou:
 * operátor s rozbitým korpusem by dostal „the frozen corpus cannot be read"
 * a **žádný způsob, jak zjistit který soubor a proč**. `withRequest()` nese jen
 * korelační ID a nic neloguje, takže pod tím doopravdy žádný kanál není.
 * Tenhle je: stderr procesu vidí ten, kdo server provozuje.
 *
 * ⚠ **„Operátorův stderr" není tak úzký kanál, jak to zní.** Na cílové
 * platformě jdou runtime logy každému členovi projektu a do všech nastavených
 * odtoků, takže adresa s přihlašovacími údaji by se v nich objevila čitelně.
 * Heslo se proto **před zápisem odstraní**; zbytek adresy zůstává, protože bez
 * něj ten řádek nediagnostikuje nic.
 *
 * `route` je jméno dveří, ne cesta — v logu se podle něj pozná, které z těch
 * čtyř mluví.
 */
export function logForOperator(
  route: string,
  requestId: string,
  code: string,
  detail: string,
): void {
  console.error(`[${route}] ${requestId} ${code}: ${withoutCredentials(detail)}`);
}
