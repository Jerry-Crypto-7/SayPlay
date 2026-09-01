/**
 * **Offline větev generování — druhá produkční cesta, ne test double.**
 *
 * `DESIGN-BOOK.md` §12 ji vede pod `invasion-loop-generation-api`: cesta, kterou
 * se dá demo provozovat, když poskytovatel vypadne. Proto prochází **týmiž**
 * kontraktovými testy jako živá větev, ne vlastní zjednodušenou sadou.
 *
 * Odpovědi bere ze zmrazeného korpusu přes `src/model/client.ts`, takže dědí
 * obě jeho kontroly: hash souboru proti `MANIFEST.lock` a per-record `sha256`
 * nad tělem. Vlastní čtení korpusu tenhle soubor **nemá** schválně.
 *
 * ## Co odpoví a co ne
 *
 * Hledá zmrazený create prompt, jehož **text sedí přesně**. Cokoli jiného je
 * `NO_SOURCE` — poctivé „na tohle odpověď nemám", ne nejbližší svět vydaný za
 * odpověď. Vymyšlená shoda by z offline větve udělala generátor náhody a
 * měřicí běhy by z ní nešly odlišit.
 *
 * Prompty mimo korpus obsluhuje fallback z P2, a to o patro výš — v routě, ne
 * tady. Větev generování má jednu povinnost: buď odpověď, nebo důvod.
 *
 * ## Účtuje nulu, a je to pravda
 *
 * Čtení souboru z disku nestojí nic, takže `pricing` i `worstCaseUsd` jsou nula.
 * Není to obcházení stropu: strop tím pádem tuhle větev nikdy neodmítne, což je
 * správně — odmítat cestu, která neutrácí, by demo jen shodilo.
 */

import { emitWorld, frozenPrompts } from '../../model/client';
import type { GenerationBranch, GenerationCall, GenerationOutcome } from '../pipeline';

export const MOCK_BRANCH_ID = 'mock';

export function mockBranch(): GenerationBranch {
  return {
    id: MOCK_BRANCH_ID,
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    worstCaseUsd: () => 0,
    generate: (call) => Promise.resolve(generate(call)),
  };
}

function generate(call: GenerationCall): GenerationOutcome {
  const prompts = frozenPrompts();
  if (!prompts.ok)
    return {
      ok: false,
      // Rozbitý korpus je rozbité prostředí, ne chybějící odpověď. Volající
      // z toho dělá 503; kdyby to bylo `NO_SOURCE`, vydal by podvržený soubor
      // jako naměřený výsledek.
      reason: 'UPSTREAM_UNAVAILABLE',
      detail: `${prompts.reason}: ${prompts.detail}`,
      usage: null,
    };

  const match = prompts.value.find(
    (record) => record.kind === 'create' && record.prompt === call.prompt,
  );
  if (match === undefined)
    return {
      ok: false,
      reason: 'NO_SOURCE',
      detail: 'the offline branch has no frozen create response for this prompt text',
      usage: null,
    };

  // Sem se dojde jen s promptem, který v korpusu **je**. Chybějící odpověď
  // proto není „na tohle odpověď nemám" jako o pár řádků výš, ale díra ve
  // zmrazené sadě — a od 1. 9. 2026 to má vlastní důvod, aby se ty dvě věci
  // daly rozlišit tam, kde na tom záleží: v logu operátora. Ven jdou pořád
  // stejně, viz `PUBLIC_FAILURE` v `/api/generate`.
  const emission = emitWorld(match.id, call.request);
  if (!emission.ok)
    return {
      ok: false,
      reason: emission.reason === 'NO_FROZEN_RESPONSE' ? 'NO_FROZEN_ANSWER' : 'UPSTREAM_UNAVAILABLE',
      detail: `${emission.reason}: ${emission.detail}`,
      usage: null,
    };

  return {
    ok: true,
    body: emission.body,
    usage: { inputTokens: 0, outputTokens: 0 },
    provenance: {
      branch: MOCK_BRANCH_ID,
      promptId: match.id,
      source: emission.provenance.source,
      synthetic: emission.provenance.synthetic,
      file: emission.provenance.file,
      bodySha256: emission.provenance.bodySha256,
      declaredVerdict: emission.provenance.declaredVerdict,
    },
  };
}
