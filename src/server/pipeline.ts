/**
 * **Jediný řetěz od promptu k emisi: moderace → strop → generování.**
 *
 * Endpointy nad tímhle souborem se liší jen tím, co s výsledkem udělají.
 * Pořadí článků se nemění nikdy a je vynucené kódem, ne kázní: moderace běží
 * první, takže odmítnutý prompt nezamluví rozpočet ani nedojde k poskytovateli,
 * a strop se rezervuje druhý, takže volání vzniká až po jeho souhlasu.
 *
 * ## Dvě větve, jeden kontrakt
 *
 * `GenerationBranch` má dvě implementace a **ani jedna z nich není test double**:
 *
 * - `src/server/mock/` — offline větev nad zmrazeným korpusem. Je to druhá
 *   **produkční** cesta: demo se na ní dá provozovat, když poskytovatel vypadne.
 * - `src/server/upstream.ts` — živá větev přes HTTP. Podle rozhodnutí ze
 *   14. 8. 2026 se dnes nevolá (klíč se nevkládá), ale kontrakt drží stejný.
 *
 * Testy v `src/server/__tests__/pipeline.test.ts` jsou proto **jedna sada
 * puštěná dvakrát**, jednou nad každou větví, včetně chování při selhání
 * generování. Rozdíl mezi větvemi je jen ve fixture, nikdy v tvrzení.
 *
 * ## Co se účtuje, když generování selže
 *
 * Rezervace se musí vyrovnat vždycky, jinak by strop tekl a po pár selháních
 * by odmítal provoz, který nic nestál. Kolik se naúčtuje, ale závisí na tom,
 * co o volání víme:
 *
 * | Selhání | Účtuje se | Proč |
 * |---|---|---|
 * | poskytovatel požadavek odmítl | nic | odpověď se negenerovala, tokeny nevznikly |
 * | větev není nakonfigurovaná | nic | nikam se nevolalo |
 * | zdroj odpovědi neexistuje | nic | dtto |
 * | spojení spadlo, odpověď je vadná | **nejhorší případ** | nevíme, kolik se spálilo |
 *
 * Poslední řádek je schválně nepříjemný. Kdyby se neúspěch účtoval nulou,
 * padající poskytovatel by byl cesta, jak strop obejít: každé volání selže, nic
 * se nenaúčtuje a peníze přitom odcházejí. Když větev spotřebu ohlásí i u
 * selhání, účtuje se ta ohlášená a odhad se zahodí.
 */

import { buildEmissionRequest, type Grammar, type UpstreamRequest } from '../model/prompt';

import { moderatePrompt, type Blocked, type ModerationRules } from './moderation';
import { costUsd, type Pricing, type SpendCap, type Usage, type RefusalReason } from './spend-cap';

/** Co větev dostane. `prompt` je text po moderaci, `request` je z něj poskládaný. */
export interface GenerationCall {
  readonly prompt: string;
  readonly request: UpstreamRequest;
}

export type GenerationFailureReason =
  /** Nedovolali jsme se, spadlo to v půlce, nebo vypršel čas. */
  | 'UPSTREAM_UNAVAILABLE'
  /** Poskytovatel požadavek odmítl — stavem, ne obsahem. */
  | 'UPSTREAM_REJECTED'
  /** Odpověď dorazila a nedá se použít. */
  | 'MALFORMED_RESPONSE'
  /** Větev pro tenhle prompt žádný zdroj odpovědi nemá. */
  | 'NO_SOURCE'
  /**
   * Zdroj ten prompt **zná**, ale odpověď k němu chybí.
   *
   * Zvenku je to totéž co `NO_SOURCE` a zůstat to tak musí — rozdíl mezi
   * „neznám tvou větu" a „mám rozbitý korpus" je stav serveru a volajícímu do
   * něj nic není. Uvnitř je to ale opak: `NO_SOURCE` je u offline větve
   * **normální odpověď** na vlastní větu porotce, kdežto tohle je **vada
   * zmrazené sady**, kterou se nikdo nedozví, dokud ji někdo netrefí.
   *
   * Do 1. 9. 2026 nesly obě situace tentýž důvod, takže filtr logu v
   * `/api/generate` musel mlčet na obě — a mlčel na tu, která je porucha.
   * Naměřeno nezávislou revizí; zatím **latentní**: 15 create promptů,
   * 0 chybějících odpovědí.
   */
  | 'NO_FROZEN_ANSWER'
  /** Větvi chybí konfigurace, takže se nevolalo nikam. */
  | 'BRANCH_UNCONFIGURED';

export interface GenerationSuccess {
  readonly ok: true;
  /** Tělo emise tak, jak přišlo. Validaci dělá až volající. */
  readonly body: unknown;
  /**
   * `null` znamená „spotřebu neumíme přečíst" — účtuje se nejhorší případ,
   * přesně jako u selhání níž. **Nula tady být nesmí:** úspěšné volání, jehož
   * účtenku neumíme přečíst, tokeny spálilo, takže nulová útrata je volání
   * zadarmo a strop ho neuvidí. Naměřeno 21. 8. 2026 — poskytovatel, který
   * `usage` vynechá nebo pošle nečíslo, takhle projde stropem donekonečna.
   */
  readonly usage: Usage | null;
  /** Odkud odpověď je. Jde do odpovědi endpointu, aby byl běh auditovatelný. */
  readonly provenance: Readonly<Record<string, string | boolean>>;
}

export interface GenerationFailure {
  readonly ok: false;
  readonly reason: GenerationFailureReason;
  readonly detail: string;
  /** `null` znamená „nevíme, kolik to spálilo" — účtuje se nejhorší případ. */
  readonly usage: Usage | null;
}

export type GenerationOutcome = GenerationSuccess | GenerationFailure;

export interface GenerationBranch {
  readonly id: string;
  readonly pricing: Pricing;
  /** Horní odhad ceny **před** voláním. Z něj se rezervuje. */
  worstCaseUsd(call: GenerationCall): number;
  generate(call: GenerationCall): Promise<GenerationOutcome>;
}

/**
 * Které selhání se účtuje odhadem a které nulou.
 *
 * Je to tabulka, ne řetěz `if`ů, aby přibytí důvodu bez rozhodnutí o účtování
 * neprošlo typovou kontrolou.
 */
const BILLED_ON_FAILURE: Record<GenerationFailureReason, 'estimate' | 'nothing'> = {
  UPSTREAM_UNAVAILABLE: 'estimate',
  MALFORMED_RESPONSE: 'estimate',
  UPSTREAM_REJECTED: 'nothing',
  NO_SOURCE: 'nothing',
  // Nikam se nevolalo, jen se to poznalo o krok později než u `NO_SOURCE`.
  NO_FROZEN_ANSWER: 'nothing',
  BRANCH_UNCONFIGURED: 'nothing',
};

export interface Generated {
  readonly outcome: 'GENERATED';
  readonly branch: string;
  readonly body: unknown;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly provenance: Readonly<Record<string, string | boolean>>;
}

export interface ModerationRefusal {
  readonly outcome: 'REFUSED';
  readonly stage: 'moderation';
  readonly category: Blocked['category'];
  readonly ruleId: string | null;
  readonly detail: string;
}

export interface CapRefusal {
  readonly outcome: 'REFUSED';
  readonly stage: 'spend-cap';
  readonly reason: RefusalReason;
  readonly detail: string;
}

export interface GenerationFailed {
  readonly outcome: 'FAILED';
  readonly stage: 'generation';
  readonly branch: string;
  readonly reason: GenerationFailureReason;
  readonly detail: string;
  /** Co se za tenhle neúspěch naúčtovalo. Nula je taky odpověď. */
  readonly costUsd: number;
}

export type PipelineResult = Generated | ModerationRefusal | CapRefusal | GenerationFailed;

export interface PipelineDeps {
  readonly branch: GenerationBranch;
  readonly cap: SpendCap;
  readonly grammar: Grammar;
  readonly moderation?: ModerationRules;
}

export async function runPipeline(prompt: unknown, deps: PipelineDeps): Promise<PipelineResult> {
  const verdict = moderatePrompt(prompt, deps.moderation);
  if (!verdict.ok)
    return {
      outcome: 'REFUSED',
      stage: 'moderation',
      category: verdict.category,
      ruleId: verdict.ruleId,
      detail: verdict.detail,
    };

  const call: GenerationCall = {
    prompt: verdict.prompt,
    request: buildEmissionRequest(verdict.prompt, deps.grammar),
  };

  const reservation = deps.cap.reserve(deps.branch.worstCaseUsd(call));
  if (!reservation.ok)
    return {
      outcome: 'REFUSED',
      stage: 'spend-cap',
      reason: reservation.reason,
      detail: reservation.detail,
    };

  // Od téhle chvíle musí každá cesta ven rezervaci vyrovnat. Vyhozená výjimka
  // by ji jinak držela až do restartu procesu a strop by se sám utáhl.
  let generated: GenerationOutcome;
  try {
    generated = await deps.branch.generate(call);
  } catch (thrown) {
    // **Vyrovnat na vlastním řádku, ne uvnitř literálu.** Vlastnosti objektu se
    // vyhodnocují v pořadí zápisu, takže vyrovnání za `detail` by u výjimky,
    // ze které `.message` přečíst nejde (`Promise.reject(null)`), neproběhlo
    // vůbec — TypeError by vylétl dřív a rezervace by visela až do konce
    // procesu. Nasazení by pak odmítalo 429 na stropu, který nic neutratil.
    // Naměřeno nezávislou revizí 1. 9. 2026 nad `10e8b8b`.
    const settledUsd = reservation.settle('unknown');
    return {
      outcome: 'FAILED',
      stage: 'generation',
      branch: deps.branch.id,
      reason: 'UPSTREAM_UNAVAILABLE',
      detail: `the ${deps.branch.id} branch threw: ${(thrown as Error).message}`,
      costUsd: settledUsd,
    };
  }

  if (generated.ok) {
    // Neznámá spotřeba se účtuje rezervací, ne nulou — táž cesta, kterou jde
    // vyhozená výjimka výš. Nula by znamenala, že poskytovatel, který `usage`
    // vynechá, volá zadarmo a strop ho nikdy neuvidí.
    const spent = generated.usage === null ? null : costUsd(generated.usage, deps.branch.pricing);
    return {
      outcome: 'GENERATED',
      branch: deps.branch.id,
      body: generated.body,
      usage: generated.usage ?? { inputTokens: 0, outputTokens: 0 },
      // **Hlásí se stržené, ne poslané.** `settle()` účtenku, která nedává
      // smysl, zahodí a strhne celou rezervaci — a do 1. 9. 2026 se to nikdo
      // nedozvěděl: `{input_tokens: -1e9}` strhlo 0,2195 USD a vrátilo sem
      // `-5000`, `{input_tokens: 1e999}` vrátilo `Infinity`. Je to jediný
      // účetní údaj, který produkt vydává, takže operátor hledající, kam se
      // rozpočet poděl, dostal součet, který se stropem nesedí.
      costUsd: reservation.settle(spent ?? 'unknown'),
      provenance: generated.provenance,
    };
  }

  const billed =
    generated.usage !== null
      ? costUsd(generated.usage, deps.branch.pricing)
      : BILLED_ON_FAILURE[generated.reason] === 'estimate'
        ? reservation.reservedUsd
        : 0;
  return {
    outcome: 'FAILED',
    stage: 'generation',
    branch: deps.branch.id,
    reason: generated.reason,
    detail: generated.detail,
    // Táž věc jako u úspěchu: `billed` je návrh, `settle()` je rozhodnutí.
    costUsd: reservation.settle(billed),
  };
}
