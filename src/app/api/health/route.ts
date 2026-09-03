/**
 * `GET /api/health` — **připraven zapisovat, ne jen naživu.**
 *
 * `src/server/readiness.ts` je 270 řádků hotové sondy, kterou do `T28`
 * nevolal nikdo. Tahle routa je její jediný volající a smysl celé té sondy:
 * odpovědět vyvažovači nebo watchdogu na otázku „**má se sem posílat
 * provoz?**" jinak než pingem, který řekne „ano" i na svazku jen pro čtení,
 * na plném disku a při vyčerpané kvótě.
 *
 * ## Proč `os.tmpdir()`
 *
 * Zapisovat za běhu jinam než do dočasného adresáře na cílové platformě
 * nejde — serverless má celý strom kromě `/tmp` jen pro čtení, a `os.tmpdir()`
 * je přesně on. Kdyby sonda zkoušela repozitář, hlásila by `WRITE_FAILED` na
 * zdravé instanci; kdyby nezkoušela nic, byla by to ta pětiřádková lež, kvůli
 * které `readiness.ts` vznikl.
 *
 * ## Co odpověď NEOBSAHUJE, a proč
 *
 * **Cestu sondy ani text chyby.** Obojí je diagnostika pro operátora a jde do
 * logu; ven z veřejné adresy by to byla mapa souborového systému instance
 * zadarmo pro kohokoli. Volající zvenku potřebuje rozhodnout „posílat, nebo
 * ne", a k tomu stačí stavový kód a jméno třídy selhání.
 *
 * ## Stavové kódy
 *
 * `200` = připraveno. `503` = běžím, ale nepřipraven — a to je jiný stav než
 * `500`, který znamená „jsem rozbitý". Sonda proto nikdy nevyhazuje: kdyby
 * z ní vyletěla výjimka, složil by odpověď Next jako pětistovku a rozdíl mezi
 * „nepřipraven" a „rozbitý" by zmizel právě v okamžiku, kdy na něm záleží.
 */

import { tmpdir } from 'node:os';

import { logRateLimited } from '../../../server/public-faults';
import {
  checkReadiness,
  nodeReadinessDeps,
  type ReadinessDeps,
  type ReadinessFailure,
} from '../../../server/readiness';

/** Sonda zapisuje na disk, takže Node, ne Edge. */
export const runtime = 'nodejs';

/**
 * Co jde ven. **Jen tohle** — pole se přidávají po jednom a s důvodem, protože
 * každé z nich je informace o instanci, kterou dostane kdokoli.
 */
export interface HealthBody {
  readonly ready: boolean;
  /** Kolik sondě trvalo projít cyklus. Číslo, ne cesta a ne text chyby. */
  readonly elapsedMs: number;
  /**
   * Jestli se zápis vynutil na zařízení, nebo skončil v cache stránek.
   * `false` **není** porucha a instanci nevyřazuje — je to slabší kontrola a
   * z odpovědi to má být poznat, jinak sonda hlásí tutéž větu o zdraví
   * v obou případech.
   */
  readonly durabilityVerified?: boolean;
  /** Třída selhání, když `ready` je `false`. Jméno, ne detail. */
  readonly reason?: ReadinessFailure;
}

/**
 * Odpověď jako data, aby se dala testovat i selhání.
 *
 * Sonda si bere závislosti parametrem schválně (`ReadinessDeps`), takže
 * `WRITE_FAILED`, `READBACK_MISMATCH` i `CLEANUP_FAILED` se dají vyrobit bez
 * plného disku. Kdyby si je routa skládala uvnitř, byla by testovatelná
 * jediná větev ze čtyř — ta šťastná.
 */
export async function healthReport(
  directory: string,
  deps: ReadinessDeps,
): Promise<{ readonly status: number; readonly body: HealthBody }> {
  const verdict = await checkReadiness(directory, deps);

  if (verdict.ready)
    return {
      status: 200,
      body: {
        ready: true,
        elapsedMs: verdict.elapsedMs,
        durabilityVerified: verdict.durabilityVerified,
      },
    };

  // Detail zůstává operátorovi. Omezenou rychlostí proto, že nepřipravená
  // instance dostává sondu každých pár vteřin a plný disk by se jinak do logu
  // zapsal tisíckrát za hodinu — tedy porucha, která přepíše vlastní příčinu.
  logRateLimited('health', verdict.probePath, verdict.reason, verdict.detail);

  return {
    status: 503,
    body: { ready: false, elapsedMs: verdict.elapsedMs, reason: verdict.reason },
  };
}

export async function GET(): Promise<Response> {
  const { status, body } = await healthReport(tmpdir(), nodeReadinessDeps());

  // **`no-store` je součást odpovědi, ne ladění.** Zdravotní kontrola, kterou
  // někdo po cestě uloží do cache, odpovídá za instanci, která už neběží —
  // a to je horší než žádná kontrola, protože vypadá stejně jako platná.
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
