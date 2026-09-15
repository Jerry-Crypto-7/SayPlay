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

/**
 * Jak dlouho platí jedna odpověď.
 *
 * **Bez tohohle je veřejná adresa zesilovač** — nález nezávislé revize
 * 3. 9. 2026, potvrzený měřením: každé zavolání dělá `write` + `fsync` +
 * `read` + `unlink` na tomtéž svazku, po kterém čte zmrazený protokol
 * `/api/generate`. Kdokoli zvenku tedy uměl jedním `while true; do curl`
 * zpomalit disk natolik, že sonda sama začne trvat dlouho — a instance se
 * odhlásí z rotace kvůli požadavku, který ji měl jen zkontrolovat.
 *
 * Dvě vteřiny jsou pod periodou, kterou se vyvažovač ptá (jednotky vteřin),
 * takže poctivá kontrola o nic nepřijde; nad ní se z tisíce dotazů stane
 * jeden zápis. **Cachuje se i verdikt „nepřipraven"** — plný disk se za dvě
 * vteřiny nespraví a odpověď, která by se místo toho ptala znovu, by dala
 * útočníkovi zesilovač zpátky přesně ve chvíli, kdy je stroj nejslabší.
 */
const CACHE_MS = 2_000;

type Answer = Awaited<ReturnType<typeof healthReport>>;

let cached: { readonly at: number; readonly answer: Answer } | null = null;

/**
 * Sonda, která právě běží. **Bez tohohle cache neslučuje souběh** — nález
 * nezávislé revize 3. 9. 2026, potvrzený měřením nad věrnou replikou:
 * **200 souběžných dotazů = 200 sond**, protože `cached` se přiřazovalo až
 * po doběhnutí `await` a každý dotaz, který mezitím přišel, viděl prázdno.
 * Zesilovač, který měla cache zavřít, tak zůstal otevřený přesně pod náporem,
 * na který byl určený.
 */
let inFlight: Promise<Answer> | null = null;

/** Hodiny sondy. Wall-clock je tu legální — není to replay cesta. */
function freshEnough(at: number): boolean {
  return Date.now() - at < CACHE_MS;
}

/**
 * Jedna sonda na okno, ať se ptá kdokoli.
 *
 * **Razítko `at` vzniká, až když sonda doběhne, ne než začne.** Druhá půlka
 * téhož nálezu: se starým pořadím byl záznam po pomalé sondě prošlý ve chvíli,
 * kdy vznikl (sonda přes 2 s → cache platná 0 ms), takže na pomalém svazku
 * cache mlčky přestala existovat. Měřeno: pět dotazů za sebou nad sondou
 * 2 100 ms dalo pět sond.
 *
 * Sonda se předává parametrem, protože jinak tuhle logiku nejde testovat —
 * a revize našla, že netestovaná byla celá. `GET` je její jediný volající.
 */
export function cachedReport(probe: () => Promise<Answer>): Promise<Answer> {
  if (cached !== null && freshEnough(cached.at)) return Promise.resolve(cached.answer);
  if (inFlight !== null) return inFlight;

  inFlight = probe()
    .then((answer) => {
      cached = { at: Date.now(), answer };
      return answer;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function GET(): Promise<Response> {
  const { status, body } = await cachedReport(() => healthReport(tmpdir(), nodeReadinessDeps()));

  // **`no-store` je součást odpovědi, ne ladění.** Zdravotní kontrola, kterou
  // někdo po cestě uloží do cache, odpovídá za instanci, která už neběží —
  // a to je horší než žádná kontrola, protože vypadá stejně jako platná.
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
