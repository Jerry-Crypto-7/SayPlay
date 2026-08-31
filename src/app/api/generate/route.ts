/**
 * `POST /api/generate` — volný text od uživatele skrz řetěz moderace → strop →
 * generování.
 *
 * Je to **jediný endpoint** pro obě větve. Která pojede, rozhoduje prostředí, ne
 * volající: klient, který si smí vybrat mezi placenou a neplacenou cestou, si
 * vybere placenou. `WORLDSMITH_BRANCH=live` zapne živou, cokoli jiného (a
 * hlavně chybějící hodnota) nechává offline.
 *
 * ## Čím se liší od `/api/emit`
 *
 * `/api/emit` bere `promptId` ze zmrazeného korpusu a je to **měřicí** cesta —
 * validuje, snižuje do IR a certifikuje svědka. Tenhle endpoint bere text a
 * vrací **emisi tak, jak přišla**. Validaci a certifikaci dělá až vrstva nad
 * ním; kdyby ji dělal tady, měřicí a produktová cesta by se rozešly a P1 by
 * měřil něco jiného, než co pojede na demu.
 *
 * ## Mapování na stavové kódy
 *
 * | Výsledek | Kód | Proč |
 * |---|---|---|
 * | emise | 200 | |
 * | moderace odmítla | 400 | vada dotazu, ne serveru |
 * Text odmítnutí stropem se ven posílá **oříznutý** — viz `PUBLIC_REFUSAL` níž.
 *
 * | rozpočet vyčerpán | 429 | dočasné, dá se zopakovat později |
 * | vyčerpaný počet volání | 429 | týž tvar, jen to nedrží ceník, ale počítadlo |
 * | vypínač rozbitý, špatný odhad | 503 | provozní stav, ne dotaz |
 * | větev nemá zdroj (`NO_SOURCE`) | 404 | poctivé „na tohle odpověď nemám" |
 * | větev nenakonfigurovaná | 503 | |
 * | poskytovatel spadl nebo mluví nesmysly | 502 | |
 *
 * `NO_SOURCE` je schválně 404, ne chyba: u offline větve je to normální
 * odpověď na prompt mimo zmrazený korpus. Fallback z P2 se na něj věší o patro
 * výš, ne uvnitř generování.
 *
 * Bez přihlašování a bez databáze — AC úlohy T301 to zakazuje obojí. Strop se
 * proto ovládá souborem na disku, ne administrátorskou routou; odůvodnění je
 * v hlavičce `src/server/spend-cap.ts`.
 */

import { randomUUID } from 'node:crypto';

import { BODY_DEADLINE_MS, MAX_BODY_BYTES, readBody } from '../../../http/body';
import { frozenGrammar, type ClientReason } from '../../../model/client';
import { withRequest } from '../../../obs/trace';
import { mockBranch } from '../../../server/mock';
import {
  runPipeline,
  type GenerationBranch,
  type GenerationFailureReason,
} from '../../../server/pipeline';
import { spendCapFromEnv, type RefusalReason } from '../../../server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '../../../server/upstream';

/** Strop je stav procesu, ne požadavku — jedna instance na celý běh serveru. */
const CAP = spendCapFromEnv(process.env);

export const runtime = 'nodejs';

/**
 * Která větev pojede. Ptá se na **objednávku**, ne na dostupnost, a ten rozdíl
 * je naměřený: `cloudBranchAvailable()` (viz `src/server/upstream.ts`) odpovídá
 * `false`, když je objednaná živá větev bez klíče — a kdyby se routa řídila jím,
 * takový server by tiše sjel na offline větev a **vydával mock za model**.
 * Operátor s překlepem v klíči by se to nedozvěděl nikdy.
 *
 * Tady se proto selhává nahlas: objednal jsi živou větev bez klíče, dostaneš
 * 503 `BRANCH_UNCONFIGURED`. Táž doktrína jako u rozbitého vypínače stropu
 * (`src/server/spend-cap.ts`) — vadné nastavení nikdy neznamená tichý průchod.
 */
function branchFor(env: NodeJS.ProcessEnv): GenerationBranch {
  return env.WORLDSMITH_BRANCH === 'live' ? upstreamBranch(upstreamConfigFromEnv(env)) : mockBranch();
}

/**
 * Co se o odmítnutí stropem řekne **ven**.
 *
 * Text ze `spend-cap.ts` je pro operátora a nese čísla i cestu k ovládacímu
 * souboru. `/api/generate` nechce přihlášení (AC T301), takže „ven" znamená
 * komukoli na internetu — a tomu se přesný zbytek rozpočtu ani absolutní cesta
 * na disku serveru neposílají. První umožňuje načasovat zneužití, druhá
 * prozradí rozvržení souborů včetně jména účtu.
 *
 * Dělí se to tady, a ne ve stropu, schválně: „co se stalo" je věc stropu, „co
 * řekneme internetu" je věc téhle vrstvy. Kdyby si text ořezával strop sám,
 * přišel by operátor o diagnostiku úplně — žádný logovací kanál pod tím není.
 *
 * `Record<RefusalReason, string>` je tu kvůli **úplnosti**: nová příčina bez
 * veřejného textu neprojde překladem. Bez toho by stačilo příčinu přidat a
 * detail by tiše odešel ven i s čísly.
 */
const PUBLIC_REFUSAL: Record<RefusalReason, string> = {
  CAP_EXHAUSTED: 'the spend cap for this process is used up; no further calls will be made',
  CALL_CAP_EXHAUSTED: 'the call cap for this process is used up; no further calls will be made',
  CONTROL_UNREADABLE: 'the spend cap is misconfigured; no calls will be made until it is fixed',
  INVALID_ESTIMATE: 'the spend cap could not price this call; it was not made',
};

/**
 * Totéž pro **selhání generování**, a je to druhá polovina téže doktríny.
 *
 * ⚠ **Naměřeno 31. 8. 2026, ne odhadnuto.** Do té doby se sem předával
 * `result.detail` doslova. Koncový bod bez schématu v `.env` (`api.example.com/v1`
 * místo `https://api.example.com/v1`) — běžný překlep při kopírování
 * z `.env.example`, tedy spouštěč dosažitelný bez útočníka — dá hlášku
 * `Failed to parse URL from <celá adresa včetně query>`, a ta odešla
 * neověřenému volajícímu. Kdyby brána poskytovatele nesla klíč v query,
 * odešel by s ní; naše hlavičková varianta ho tam nemá, takže leak zůstal
 * u adresy. To je rozdíl mezi „vážné" a „katastrofa", ne mezi „vada" a „nic".
 *
 * `Record<GenerationFailureReason, string>` znovu kvůli **úplnosti**: nový
 * důvod bez veřejného textu neprojde přes `tsc`. Detail zůstává operátorovi
 * ve stopě požadavku, ven jde jen tohle.
 */
const PUBLIC_FAILURE: Record<GenerationFailureReason, string> = {
  UPSTREAM_UNAVAILABLE: 'the model could not be reached; nothing was generated',
  UPSTREAM_REJECTED: 'the model provider rejected the request; nothing was generated',
  MALFORMED_RESPONSE: 'the model answered with something this server cannot read',
  NO_SOURCE: 'this deployment has no answer for that prompt',
  BRANCH_UNCONFIGURED: 'this deployment is not configured to generate; no call was made',
};

/**
 * A totéž pro zmrazený korpus, ze stejného důvodu a s jinou kořistí.
 *
 * `readFrozen()` skládá detail jako „<soubor> is not readable under <FROZEN_DIR>",
 * a `FROZEN_DIR` je **absolutní cesta na disku serveru včetně jména účtu** —
 * přesně to, co si hlavička `PUBLIC_REFUSAL` výš zakazuje posílat ven.
 */
const PUBLIC_CORPUS_FAULT: Record<ClientReason, string> = {
  MANIFEST_MISMATCH: 'the frozen corpus does not match its manifest; no answers will be served',
  CORPUS_UNREADABLE: 'the frozen corpus cannot be read on this server',
  NO_FROZEN_RESPONSE: 'the frozen corpus has no answer for that prompt',
  RESPONSE_TAMPERED: 'a frozen answer failed its own checksum; it will not be served',
  BASE_WORLD_MISMATCH: 'the edit names a different base world than the one that arrived',
  BASE_WORLD_MISSING: 'the frozen corpus is missing the base world that edit names',
};

function error(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ requestId, error: { code, message } }, { status });
}

/**
 * Diagnostika, která nesmí ven — ale nesmí ani zmizet.
 *
 * Bez tohohle řádku by ořezání textů výš vyměnilo jednu vadu za druhou:
 * operátor s překlepem v adrese by dostal „the model could not be reached" a
 * **žádný způsob, jak zjistit proč**. `withRequest()` nese jen korelační ID,
 * nic neloguje, takže pod tím doopravdy nebyl žádný kanál (viz hlavička
 * `PUBLIC_REFUSAL`). Tenhle je: stderr procesu vidí ten, kdo server provozuje,
 * a nikdo jiný. `requestId` je stejné jako v odpovědi, takže se dvojice spáruje.
 */
function logForOperator(requestId: string, code: string, detail: string): void {
  console.error(`[generate] ${requestId} ${code}: ${detail}`);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    const raw = await readBody(request);
    if (!raw.ok)
      return raw.reason === 'TOO_LARGE'
        ? error(requestId, 413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`)
        : error(requestId, 408, 'BODY_TIMEOUT', `request body did not arrive within ${BODY_DEADLINE_MS} ms`);

    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      return error(requestId, 400, 'MALFORMED_BODY', 'request body is not JSON');
    }

    const grammar = frozenGrammar();
    if (!grammar.ok) {
      logForOperator(requestId, grammar.reason, grammar.detail);
      return error(requestId, 503, grammar.reason, PUBLIC_CORPUS_FAULT[grammar.reason]);
    }

    const result = await runPipeline((body as { prompt?: unknown } | null)?.prompt, {
      branch: branchFor(process.env),
      cap: CAP,
      grammar: grammar.value,
    });

    if (result.outcome === 'GENERATED')
      return Response.json({
        requestId,
        branch: result.branch,
        emission: result.body,
        usage: result.usage,
        costUsd: result.costUsd,
        provenance: result.provenance,
      });

    if (result.outcome === 'REFUSED')
      return result.stage === 'moderation'
        ? Response.json(
            { requestId, error: { code: 'PROMPT_REFUSED', message: result.detail, category: result.category } },
            { status: 400 },
          )
        : error(
            requestId,
            result.reason === 'CAP_EXHAUSTED' || result.reason === 'CALL_CAP_EXHAUSTED' ? 429 : 503,
            result.reason,
            PUBLIC_REFUSAL[result.reason],
          );

    logForOperator(requestId, result.reason, result.detail);
    const status = result.reason === 'NO_SOURCE' ? 404 : result.reason === 'BRANCH_UNCONFIGURED' ? 503 : 502;
    return Response.json(
      {
        requestId,
        error: { code: result.reason, message: PUBLIC_FAILURE[result.reason] },
        branch: result.branch,
      },
      { status },
    );
  });
}
