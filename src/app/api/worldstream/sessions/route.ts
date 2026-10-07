import {withSessionStorageResponse} from '@/server/session-persistence';
import {assertSessionStorageReady} from '@/worldstream/sessions';
import {ownerIdentityRejection} from '@/server/owner-identity';
import { observePhaseAsync } from '@/model/phase-observer';
import { withServerMetrics, serverPhaseObserver, currentServerMetrics, reportServerMetrics } from '@/server/worldstream-metrics';
/**
 * `POST /api/worldstream/sessions` — z věty vznikne relace (P13 T16, §21).
 *
 * Odpověď je **202 a adresa proudu**, ne hotový svět. Design book to říká
 * doslova: „validní odpověď neznamená hotový svět". Generace běží dál za
 * odpovědí a hlásí se rámci do relace (`src/worldstream/sessions.ts`).
 *
 * ## Kdo svět píše: sklad, nebo model
 *
 * **Od `T14r-acttwo` rozhoduje tělo požadavku, ne dostupnost modelu.**
 * `{ prompt }` je dějství I a obslouží ho **vždycky sklad**; `{ prompt, live:
 * true }` je dějství II a to je **jediná** cesta k modelu.
 *
 * Že sklad obslouží dějství I *vždycky*, není podmínka, ale dnešní fakt:
 * `chooseAuthored()` vrací `null` jedině nad **prázdným** skladem (vybírá
 * nejbližší svět, ne jen přesnou shodu — `src/worldstream/authored.ts`), a
 * `authored-worlds.json` drží **11 světů**. Dějství I tedy k modelu nedojde
 * nikdy, nebere placený slot a nic nestojí. Obě 503 větve nad prázdným
 * skladem — `TOO_MANY_SESSIONS` a `NO_WORLD_AVAILABLE` — jsou proto dnes
 * **mrtvý kód**; ožily by jedině nad skladem bez jediného světa. Která
 * z těch dvou promluví, rozhoduje model: nakonfigurovaný a plný dá
 * `TOO_MANY_SESSIONS`, vypnutý nebo chybějící dá `NO_WORLD_AVAILABLE`.
 *
 * ⚠ **Pro konzumenta mimo prohlížeč je to tichá změna kontraktu.** `{ prompt }`
 * dřív znamenalo „nech to napsat model, když můžeš"; dnes vrátí uvařený svět
 * a popisek, jestli je shoda přesná, nebo nejbližší (`T45-honestlabel`).
 *
 * ## Čtyři brány, v tomhle pořadí
 *
 * 1. **Tvar těla.** Přijímá se **`prompt`, volitelně `live`, a nic jiného**.
 *    Klíč navíc je 400, ne tiše ignorovaný — kdyby se ignoroval, `shapes` nebo
 *    `geometry` od klienta by vypadaly jako přijaté a produkt by tvrdil, že
 *    geometrii píše model, zatímco by ji směl podstrčit kdokoli.
 * 2. **Moderace** (`src/server/moderation.ts`), tedy táž brána jako `/api/emit`.
 * 3. **Strop souběhu** — **jen pro dějství II**, protože slot si bere jedině
 *    živá větev. Je to **týž strop** jako u preview druhé věty a jako
 *    u `/api/generate`, jen se každé ty dveře zastaví o kus dřív — vlastní
 *    strop nad společným dnem `MAX_CONCURRENT_GENERATIONS`. V letu se počítá
 *    po dveřích, takže rezerva platí na všechny strany. Odůvodnění a invariant,
 *    na kterém to stojí, jsou u `DOOR_CEILING`.
 * 4. **Strop utrácení** — také jen pro dějství II, uvnitř emitoru, u každého
 *    placeného volání zvlášť. Dějství I neutratí nic, takže se ho netýká.
 *
 * ## Proč tu není `AdmissionQueue`, ačkoli je napsaná
 *
 * `submit()` splní slib **až když práce doběhne**, a tahle route musí odpovědět
 * dřív, než práce doběhne — jinak se 202 změní v „počkej si třicet vteřin".
 * Fronta se sem tedy nedá zapojit tak, jak je: zapojení celé ochrany proti
 * náporu je vlna 7 (T28) a bude potřebovat slot držený **napříč** požadavkem
 * a generací. Do té doby drží nápor jediná věc, která tuhle vlastnost nemá:
 * čítač souběžných generací níž — a ten od `T14r-acttwo` počítá **jen dějství
 * II**. Nápor na dějství I dnes nezastavuje tenhle čítač, ale strop frekvence
 * (`src/server/rate-limit.ts`) a čítač rozečtených těl (`src/http/body.ts`) —
 * jsou to dvě různá místa a do 9. 9. 2026 tu obě visela pod jedním souborem.
 *
 * ## Rozpočet požadavku tu stál a nikdy nesepnul
 *
 * Do 4. 9. 2026 tu byla ještě brána `admit()` na promlčeném rozpočtu
 * (`SESSION_POLICY`: 15 s rozpočtu, 3 s minimální obsluhy). **Nezávislá revize
 * ji vyvrátila měřením:** odmítala až požadavek, který čekal přes 12 s, jenže
 * `receivedAtMs` se bralo až uvnitř handleru, takže jediný interval, který se
 * odsud dal změřit, bylo čtení těla — a to má vlastní strop
 * `BODY_DEADLINE_MS = 5 000` (`src/http/body.ts`). Brána byla o sedm vteřin
 * mimo dosah a nemohla odmítnout nikdy nikoho. Táž vada a totéž odstranění jako
 * v `/api/generate` (`7c1e12f`); zůstává čítač, který doopravdy kousne.
 */

import { randomUUID } from 'node:crypto';

import { after } from 'next/server';
import { cloudEmitter } from '../../../../server/worldstream-emitter';
import { answerReuseFor } from '../../../../server/answer-cache';

import { bodyRefusalResponse, readBody } from '../../../../http/body';
import { withRequest } from '../../../../obs/trace';
import { killState } from '../../../../server/kill-switch';
import { moderatePrompt } from '../../../../server/moderation';
import {
  callerKey,
  rateLimitCode,
  rateLimitedResponse,
  takeRateSlot,
  trustedCallerKey,
  UNIDENTIFIED_CALLER,
} from '../../../../server/rate-limit';
import { logRateLimited } from '../../../../server/public-faults';
import { chooseAuthored, emitterFor } from '../../../../worldstream/authored';
import { sessionEventStream } from './[sessionId]/events/route';
import {
  MAX_SESSIONS_PER_CALLER,
  newSessionSeed,
  openSession,
  runGeneration,
  serverGrammar,
  type SessionFault,
} from '../../../../worldstream/sessions';
import { acquireSlot, releaseSlot, slotsDetail } from '@/server/paid-slots';

/** Zmrazený protokol se čte ze souboru a `AsyncLocalStorage` chce Node. */
export const runtime = 'nodejs';

// Strop placených volání v letu žije od P44D T2 v `src/server/paid-slots.ts`
// (sdílí ho režisér PLAY); tahle trasa ho jen používá a dál vystavuje.
export {
  DOOR_CEILING,
  MAX_CONCURRENT_GENERATIONS,
  MAX_WORLD_GENERATIONS,
  acquireSlot,
  releaseSlot,
  resetConcurrency,
  slotsDetail,
  type PaidDoor,
} from '@/server/paid-slots';

/**
 * Strop utrácení je stav **procesu**, ne požadavku — a je to **táž instance**,
 * jakou drží `src/app/api/generate/route.ts`, ne jeho kopie.
 *
 * ⚠ **Do 3. 9. 2026 to byly dvě instance a nikdo si toho nevšiml.** Obě route
 * si volaly `spendCapFromEnv(process.env)` samy, každá dostala vlastní
 * `#spentUsd` a `#callsMade`, a proces tedy utratil až **dvojnásobek**
 * nastaveného stropu — každá půlka přitom svůj strop poctivě dodržela.
 * Naměřeno nezávislou revizí. Proto se sem chodí výhradně přes
 * `processSpendCap()`.
 *
 * Postavit ho uvnitř `cloudEmitter()` znamenalo nový strop na každý požadavek:
 * `#spentUsd` i `#callsMade` se pokaždé vynulovaly, takže strop nikdy nic
 * neodmítl. Naměřeno revizí 3. 9. 2026 — sdílený strop odmítl na volání #38,
 * strop na požadavek neodmítl ani po šedesáti.
 *
 * Napříč instancemi to pořád nedrží; to je `T29` a jiná vada.
 */
export { WORLDSTREAM_SPEND_CAP, cloudEmitter } from '../../../../server/worldstream-emitter';

function fail(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ requestId, error: { code, message } }, { status });
}

interface PromptRead {
  readonly ok: true;
  readonly prompt: unknown;
  /**
   * Dějství II: **svět má napsat model, sklad se ho netýká** (P15 `T14r-acttwo`).
   *
   * Je to jediný klíč navíc, který tyhle dveře přijímají, a nese **rozhodnutí,
   * ne obsah**. Klient jím říká, které dějství otevírá; co v tom světě bude,
   * píše pořád jenom model.
   */
  readonly live: boolean;
}

/**
 * Tělo je `{ prompt }`, volitelně `{ prompt, live }`. Klíč navíc je vada, ne
 * přebytek — kdyby se ignoroval, dal by se `ShapeProgram` podstrčit zvenčí.
 */
function readPrompt(text: string): PromptRead | { readonly ok: false; readonly code: string; readonly message: string } {
  let body: unknown;
  try {
    body = JSON.parse(text === '' ? 'null' : text);
  } catch {
    return { ok: false, code: 'BODY_NOT_JSON', message: 'the request body is not JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, code: 'BODY_NOT_AN_OBJECT', message: 'the request body is not a JSON object' };

  const extra = Object.keys(body).filter((key) => key !== 'prompt' && key !== 'live');
  if (extra.length > 0)
    return {
      ok: false,
      code: 'UNEXPECTED_FIELDS',
      // **Hláška jmenuje obě pole, ne jedno.** Do 9. 9. 2026 tvrdila „a prompt
      // and nothing else" i po tom, co brána `live` přijímá — klient tak četl
      // odmítnutí, které popírá pole, jež mu tytéž dveře povolují.
      message: `this endpoint takes a prompt and an optional live flag, nothing else; it will not accept ${extra.join(', ')}`,
    };

  // **Cokoli jiného než boolean je 400, ne tiché `false`.** Ticho by z překlepu
  // (`live: 'true'`) udělalo dějství I, tedy uvařený svět v odpovědi, kterou si
  // klient přečte jako svět napsaný modelem — a popisek by o tom mlčel.
  const live = (body as { live?: unknown }).live;
  if (live !== undefined && typeof live !== 'boolean')
    return {
      ok: false,
      code: 'LIVE_NOT_A_BOOLEAN',
      message: 'live is true, false, or absent; it is not text',
    };

  return { ok: true, prompt: (body as { prompt?: unknown }).prompt, live: live === true };
}

async function handleDurablePOST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, () => withServerMetrics(requestId, 'prompt', async () => {
    // **Vypínač je první brána, před čtením těla.** Vypnuté dveře nesmí stát
    // víc než jeden `readFileSync` nad souborem o pár řádcích — tělo požadavku
    // je proti tomu až 64 kB, které někdo pošle a my je nepotřebujeme.
    //
    // ⚠ **Ta věta byla od `T30-controllever` chvíli nepravdivá a je znovu
    // pravdivá.** Druhým zdrojem povelu je sdílený obchod, takže čtení umí být
    // síťový let — a jako první příkaz na neomezených dveřích to byl
    // zesilovač, kterým šlo vypálit kvótu obchodu (nález nezávislé revize
    // commitu `316a4f1`, `VERDICT: blocking`). Zavírá to okno
    // `CONTROL_CACHE_TTL_MS` v `spend-store.ts`: instance vydá nejvýš jeden
    // `GET` za sekundu, všechno ostatní je pohled do mapy. Pořadí bran proto
    // zůstává — přeřadit vypínač za strop frekvence by odchozí lety
    // neohraničilo (strop instance pouští 400 za 10 s, tedy 40 příkazů za
    // sekundu) a jen by vypnutým dveřím vzalo přednost.
    if ((await observePhaseAsync(serverPhaseObserver, 'request-kill-switch', () => killState(process.env))).sessions) {
      logRateLimited('worldstream/sessions', requestId, 'SESSIONS_DISABLED', 'kill switch: sessions');
      return fail(requestId, 503, 'SESSIONS_DISABLED', 'new worlds are switched off right now');
    }

    // Strop na frekvenci, hned za vypínačem a před čtením těla. Tyhle dveře
    // stojí navíc placená volání, takže čítač souběhu níž zůstává — frekvence
    // a souběh měří dvě různé věci a jedna druhou nenahradí.
    const identityRejection=ownerIdentityRejection(request);
    if(identityRejection)return identityRejection;
    const slot = takeRateSlot('sessions', trustedCallerKey(request) ?? callerKey(request));
    if (!slot.allowed) {
      logRateLimited(
        'worldstream/sessions',
        requestId,
        rateLimitCode(slot),
        `${String(slot.count)} in window`,
      );
      return rateLimitedResponse(requestId, slot);
    }

    let raw;
    try {
      raw = await observePhaseAsync(serverPhaseObserver, 'request-body-read', () => readBody(request));
    } catch (thrown) {
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'BODY_UNREADABLE',
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      return fail(requestId, 400, 'BODY_UNREADABLE', 'the request body could not be read');
    }
    // **Dva starší důvody si nechávají svůj pravopis.** Tyhle dveře vydávají
    // `TOO_LARGE`/`TIMEOUT` tam, kde ostatní vydávají `PAYLOAD_TOO_LARGE`
    // a `BODY_TIMEOUT`; sjednotit to je změna kontraktu, kterou tahle úloha
    // neobjednala. Nový důvod (plná fronta čtení) sdílí kód se všemi dveřmi,
    // aby nevznikl pátý pravopis.
    if (!raw.ok)
      return raw.reason === 'BUSY'
        ? bodyRefusalResponse(requestId, raw)
        : fail(
            requestId,
            raw.reason === 'TOO_LARGE' ? 413 : 408,
            raw.reason,
            raw.reason === 'TOO_LARGE'
              ? 'the request body is too large'
              : 'the request body arrived too slowly',
          );

    const read = readPrompt(raw.text);
    if (!read.ok) return fail(requestId, 400, read.code, read.message);

    const verdict = moderatePrompt(read.prompt);
    if (!verdict.ok) return fail(requestId, 400, verdict.category, verdict.detail);

    // **Zdroj světa se vybírá PŘED placenou vstupenkou** (P15 `T14r-actone`).
    //
    // ⚠ **Do 7. 9. 2026 se sloty braly první a byla to naměřená vada.** Uvařený
    // svět nestojí ani volání, ani vteřinu — je to soubor v paměti procesu —
    // a přesto se za `acquireSlot('world')` schovával spolu s živou větví.
    // Při třech běžících generacích (`MAX_WORLD_GENERATIONS`) tak čtvrtý
    // porotce dostal **503 místo okamžitého světa**, který tu celou dobu ležel.
    // Je to táž třída jako `T29-freecallcap` („volání zdarma se nesmí odmítnout
    // kvůli placenému provozu"), jen o jedny dveře vedle.
    //
    // **Slot se proto bere jedině tehdy, když poběží živá větev**, a `&&`
    // zkratuje: bez nakonfigurovaného modelu se o slot nikdo neuchází.
    // `cloudEmitter()` je levné v tom smyslu, na kterém tady záleží:
    // `upstreamConfigFromEnv` čte proměnné prostředí a **k poskytovateli se
    // odsud nikdo nepřipojuje**.
    //
    // ⚠ **Zadarmo to ale není, a do 9. 9. 2026 tu stálo, že ano** (nález
    // nezávislé revize). Vteřinové okno má jedině sdílený klíč
    // (`spend-store.ts`); `readControlFile()` dělá `readFileSync` + `statSync`
    // **při každém volání**, takže s nastaveným `WORLDSMITH_CONTROL_FILE` stojí
    // i odmítnutý požadavek dvě synchronní čtení disku.
    //
    // **Dějství I je sklad, dějství II je model** (P15 `T14r-acttwo`). Uvařený
    // svět odpoví hned a nestojí nic, takže první větu obslouží on, kdykoli ho
    // sklad má; placený slot si bere jedině věta, kterou sklad neumí. Dějství II
    // je opak: sklad se ho netýká, protože jeho celý smysl je ukázat, co napsal
    // model. Ta dvě dějství jsou proto po celý zbytek téhle route **vzájemně
    // vylučující** — `live` a `authored` nebudou nikdy pravdivé obě.
    const cloud = await cloudEmitter();
    const authored = read.live ? null : chooseAuthored(verdict.prompt);
    const live = authored === null && cloud !== null && acquireSlot('world');

    // **Dějství II relaci, na kterou nemá, vůbec neotevře.** Relace, která hned
    // spadne, ubere volajícímu jedno místo z `MAX_SESSIONS_PER_CALLER` a porotci
    // nedá nic — dějství I mu přitom pořád stojí na plátně, takže je co ztratit
    // a není co získat. Obě příčiny jsou 503, protože obě znamenají „teď ne":
    // vypnutý nebo nenakonfigurovaný model a plný strop souběhu.
    if (read.live && !live) {
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'LIVE_UNAVAILABLE',
        cloud === null ? 'no live branch is configured' : slotsDetail('world'),
      );
      return fail(
        requestId,
        503,
        'LIVE_UNAVAILABLE',
        cloud === null
          ? 'the model is not writing worlds on this instance'
          : 'too many worlds are being built right now',
      );
    }

    // **Prázdný sklad je 503, ať už je model plný, nebo vypnutý.** Není co
    // vydat, a to je „teď ne" bez ohledu na příčinu. S uvařeným světem po ruce
    // se sem nedojde: níž se emituje sklad.
    //
    // ⚠ **Dnes je tahle větev mrtvý kód a je to v pořádku.** Dostat se sem
    // znamená `authored === null`, a `chooseAuthored()` vrátí `null` jedině nad
    // **prázdným** skladem; `authored-worlds.json` drží 11 světů. Ožije tedy
    // přesně za jedné podmínky — sklad bez jediného světa (smazaný soubor,
    // neproběhlý `npm run author:worlds`).
    //
    // ⚠ **Podmínka `cloud !== null` tady stála do 9. 9. 2026 a byla to vada**
    // (`T14r-actonefault`). Prázdný sklad **a k tomu** vypnutý nebo
    // nenakonfigurovaný model 503 minul, vrátil 202 a relaci pak zabil větou
    // „the model could not be reached" — o modelu, kterého se nikdo
    // nedovolával. Porotce tak četl výpadek modelu tam, kde chybí uvařené
    // světy, a operátor nedostal ani řádek do logu.
    //
    // **Kód rozděluje příčinu, protože každá se opravuje jinde.**
    // `TOO_MANY_SESSIONS` znamená plný stroj, tedy počkej; `NO_WORLD_AVAILABLE`
    // znamená nasazení bez skladu i bez modelu, tedy pusť `npm run
    // author:worlds` nebo nastav klíč. Jedna hláška pro obojí by operátora
    // poslala čekat na uvolnění, které nikdy nepřijde.
    if (!live && authored === null) {
      const noSource = cloud === null;
      // **Odmítnutí musí být vidět v operátorském logu**, jinak se „strop nás
      // ochránil" nedá odlišit od „nikdo nepřišel". Text je konstantní
      // schválně: `logRateLimited` klíčuje `(dveře, kód)` a objem nese
      // `(occurrence N)`, takže z náporu nevyroste víc než logaritmus řádků.
      // **„on this instance" je součást pravdy:** `running` je stav modulu, takže
      // na Vercelu má vlastní čítač každá instance a globální číslo nedrží nikdo
      // — to zavře až sdílené úložiště `T29`.
      logRateLimited(
        'worldstream/sessions',
        requestId,
        noSource ? 'NO_WORLD_AVAILABLE' : 'TOO_MANY_SESSIONS',
        // **Řádek jmenuje dveře, které sloty drží.** Do `T22-doorcounters` to
        // čítač nevěděl, takže uměl říct jen „v letu je tolik, kolik smí držet
        // nový svět" — a operátor z toho nepoznal, jestli ho zavřely světy,
        // nebo preview druhé věty. Rozpad po dveřích tu odpověď nese.
        //
        // **Proměnlivý text nevyrobí povodeň.** `logRateLimited` vydá nanejvýš
        // `MAX_DETAILS_PER_WINDOW = 8` různých příčin za okno, a různých
        // podob je tu stejně nejvýš pět: `world` se přes svůj strop nedostane.
        noSource ? 'no stored worlds and no live branch is configured' : slotsDetail('world'),
      );
      return noSource
        ? fail(
            requestId,
            503,
            'NO_WORLD_AVAILABLE',
            'this instance has no stored worlds and the model is not writing them',
          )
        : fail(requestId, 503, 'TOO_MANY_SESSIONS', 'too many worlds are being built right now');
    }

    // ⚠ **Každý `return` odsud dolů musí slot vrátit, a jedině když ho drží.**
    // Do `T14r-actone` ho držela každá cesta, takže stačilo `releaseSlot`
    // bezpodmínečně; dnes ho uvařená cesta nedrží a vrátit cizí slot by
    // odečetlo z čítače, který nikdo nezvýšil.
    const grammar = serverGrammar();
    if (typeof grammar === 'string') {
      if (live) releaseSlot('world');
      logRateLimited('worldstream/sessions', requestId, 'GRAMMAR_UNREADABLE', grammar);
      return fail(requestId, 503, 'GRAMMAR_UNREADABLE', 'the frozen protocol could not be read');
    }

    const sessionId = randomUUID();
    // **Vlastník relace je klíč volajícího, a je to mez, ne diagnostika**
    // (`MAX_SESSIONS_PER_CALLER`). Bez něj by registr seskupil všechny relace
    // do jednoho kbelíku a strop 64 by šel naplnit z jedné smyčky.
    //
    // ⚠ **Je to JINÝ klíč než ten pár řádků výš, a od `T16-trustedkey` to tak
    // má být.** Kvóta bere `trustedCallerKey()` **holý**, protože tady je cizí
    // klíč zbraň: jedna relace vložená do kbelíku oběti z něj udělá největší
    // kbelík a přetečení pak sáhne po oběti (naměřeno 5 z 5, `T16-evictkill`).
    // Strop frekvence bere od `T29-freeunbounded` (6. 9. 2026) **týž klíč
    // s pádem** — `trustedCallerKey(request) ?? callerKey(request)` — takže se
    // liší jen v tom, co dělají, když důvěryhodný konec řetězu není: kvóta se
    // vypne, frekvence spadne na vstup volajícího a platí dál.
    //
    // ⚠ **Do 6. 9. 2026 tu stálo „strop frekvence bere `callerKey()`,
    // podvrhnout ho tam nic nezískává" a byl to blokující nález nezávislé
    // revize.** Podvrhnout ho získává **cizí kbelík**: první položka
    // `x-forwarded-for` je vstup volajícího, takže padesát požadavků
    // s hlavičkou oběti umlčí porotce na deset sekund. Celý rozpad je
    // v hlavičce `rate-limit.ts`; pin je `útočník s hlavičkou oběti jí na
    // nasazení požadavek NEODRAZÍ`.
    //
    // ⚠ **Bez důvěryhodného konce řetězu je kvóta VYPNUTÁ, ne přísnější.**
    // `null` → sentinel → `openSession()` dá relaci vlastní kbelík, což je
    // izolace, ne mez; celé odůvodnění je tam. **Mimo Vercel to platí vždycky**
    // — `next start`, demo z notebooku i vlastní reverse proxy. Režim „za
    // vlastní nginx" tu do 5. 9. 2026 byl a zrušil ho měřením potvrzený nález
    // (doktrína u `trustedCallerKey()`); zpátky smí jedině se zdrojem, který
    // volající nepíše. **Na Vercelu klíč je — ale jedině při `VERCEL=1`:**
    // přepínač *Automatically expose System Environment Variables* zháší
    // `VERCEL` i `VERCEL_ENV` naráz, a s vypnutým přepínačem je kvóta i tam
    // vypnutá. Tvrdit „na Vercelu klíč je" bez té podmínky je nepravda.
    // P20: explicit authenticated-proxy mode is verified above; its principal
    // also enables this quota on a single-process host without claiming Vercel.
    const owner = trustedCallerKey(request) ?? UNIDENTIFIED_CALLER;
    let stored:ReturnType<typeof openSession>;
    try{stored=openSession(sessionId,newSessionSeed(),Date.now(),owner);}
    catch(error){if(live)releaseSlot('world');throw error;}
    // **Nad vlastní kvótou se odmítá nováček, a slot se vrací.** Je to ten
    // další `return` mezi `acquireSlot('world')` a `work.finally`, o kterém
    // mluví komentář výš: bez `releaseSlot` by každé odmítnutí natrvalo ubralo
    // jeden ze tří slotů dveří `world`, tedy z toho, co má chránit.
    //
    // ⚠ **429, ne 503.** 503 by řeklo „instance je plná", což je nepravda:
    // odmítnutí se týká **jen tohohle klíče**, a od `QUOTA_ENGAGES_AT` je
    // registr navíc zaručeně aspoň z poloviny obsazený.
    //
    // ⚠ **Věta nesmí radit „zavři jedno okno", protože to nefunguje** — nález
    // sedmé nezávislé revize, `VERDICT: blocking`, změřený. Koncový bod na
    // zavření relace neexistuje; `release()` je dosažitelné jedině ze zametení
    // stárnutí a z přetečení registru, takže volající, který zavře všechny
    // karty, je zpátky v poli až po **dvou hodinách a třech požadavcích**.
    // `Retry-After` se z téhož důvodu neposílá: jediné poctivé číslo by bylo
    // „nevím", a u relace s drženým proudem je to dokonce „nikdy"
    // (`T16-idleforever`). Hláška proto říká jen stav, ne radu.
    if (stored === null) {
      if (live) releaseSlot('world');
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'TOO_MANY_SESSIONS_PER_CALLER',
        `caller already holds ${String(MAX_SESSIONS_PER_CALLER)} live sessions on this instance`,
      );
      return fail(
        requestId,
        429,
        'TOO_MANY_SESSIONS_PER_CALLER',
        'this address already holds as many live worlds as one address may hold on a busy instance',
      );
    }

    // **Živá větev jede, jen když na ni vyšel slot; jinak vydá svět sklad.**
    //
    // ⚠ **Odůvodnění, které tu stálo do 7. 9. 2026, bylo zastaralé.** Znělo
    // „živá cesta má přednost vždycky, jinak by `T14` místo modelu měřila
    // cache" — jenže `evals/worldstream/measure-create.ts` tuhle route
    // **nevolá**: mluví s poskytovatelem přímo přes `compileWithRepair`
    // a `upstreamBranch`. `grep -rn "api/worldstream/sessions" evals/` nevrací
    // nic. Měřidlo tedy pořadí zdrojů nevidí a žádný vypínač nepotřebuje.
    //
    // Vypnutý model i chybějící klíč vypadají odsud stejně (`cloudEmitter()`
    // vrátí `null`) a to je správně: kill switch `upstream` vypíná **živou**
    // větev, ne sklad. Porotci má vypnutý model nechat svět, ne prázdno.
    //
    // Sklad se hledá **v route**, ne uvnitř emitoru: odpověď musí říct, jestli
    // věta trefila uvařený svět přesně, nebo dostala ten nejbližší. Bez toho
    // by produkt tvrdil, že tenhle svět napsal model teď — a to je nepravda,
    // kterou porotce odhalí druhou větou (`T45-honestlabel`).
    // `live` a `authored` se vylučují už od výběru zdroje výš, takže tady se
    // nic nerozhoduje podruhé: co vybral sklad, to se vydá.
    const served = authored;
    const emit = live ? cloud : served === null ? null : emitterFor(served.world);
    // **Relace si pamatuje, ze kterého uvařeného světa vznikla** — jinak nemá
    // druhá věta ze skladu co vydat (`T35-actsthree4`). Uvařená změna nese
    // `stableId` z jednoho blueprintu, takže patří k jednomu světu a hledat ji
    // přes celý sklad znamená vydat cizí cíl.
    stored.authoredWorldId = served?.world.id ?? null;
    const metrics = currentServerMetrics();
    stored.generationMetrics = metrics;
    metrics?.setProvenance(live ? 'live' : 'prepared');
    const finishGeneration = metrics?.observe('background-generation');
    const generationStarted = Date.now();
    // Kód poruchy, kterým generování skončilo — pro řádek `worldstream.generation`
    // v `finally` níž.
    let endedWith: string | null = null;
    const work = (
      emit === null
        ? Promise.resolve().then(() => {
            stored.fault = 'the model could not be reached';
            stored.session.fail(stored.fault);
          })
        : runGeneration(stored, verdict.prompt, {
            legacyPlan: served !== null,
            emit,
            grammar,
            // **Cache odpovědí jen pro živou větev** (P16 T6). Sklad nic
            // nestojí, takže by „reused" nad ním byla věta bez obsahu — a
            // `savedCalls: 2` lež. Sedí ZA všemi branami výš: kill switch,
            // strop frekvence, moderace i slot rozhodly beze změny; zásah
            // jen nevyrobí volání, které by strop utrácení jinak rezervoval.
            ...(live ? answerReuseFor(process.env, verdict.prompt) : {}),
            log: (fault: SessionFault, detail: string) => {
              endedWith = fault;
              logRateLimited('worldstream/sessions', requestId, fault, detail);
            },
          })
    ).catch((thrown: unknown) => {
      // An unexpected rejection can bypass runGeneration's stored.fault path.
      // Preserve the original rejection while closing telemetry as failed;
      // the idempotent finalizer below still releases the paid slot.
      endedWith ??= 'UNEXPECTED_REJECTION';
      finishGeneration?.('failed');
      throw thrown;
    });

    // **`after()`, ne holé `void`.** Odpověď 202 musí odejít dřív, než generace
    // doběhne — to je celý smysl téhle route — ale práce za ní musí platformu
    // přežít.
    //
    // Naměřeno nezávislou revizí 3. 9. 2026 nad `4ee2b3d`: `vercel.json`
    // nasazuje serverless a instance se po odeslání odpovědi **zmrazí**, takže
    // `void work` znamená „rezervace se zapsala, vyrovnání ne". Do P15 T29 to
    // stálo jen paměť procesu a umřelo to s ním; od T29 je kniha sdílená
    // a trvalá, takže každá taková rezervace strop **natrvalo utáhne** —
    // dvacet opuštěných rezervací po 0,2585 USD vyčerpá strop 5 USD a další
    // instance začne rovnou na `CAP_EXHAUSTED`. Zotavení pak není mazání klíče
    // v úložišti, ale zvednutí `WORLDSMITH_SPEND_CAP_USD` a redeploy; je to
    // rozhodnutí o penězích a patří člověku. **Ovládacím souborem to od
    // `T30-capfloor` nejde** — ten umí strop jen přitáhnout, takže vyšší
    // `capUsd` v něm je tichý no-op.
    //
    // `after()` doběhne i tehdy, když odpověď skončí chybou, a je omezené
    // `maxDuration` routy, ne donekonečna.
    const settled = work.finally(() => {
      // **Vrací se jen držený slot.** Uvařená cesta si o žádný neřekla
      // (`T14r-actone`), takže bezpodmínečné vrácení by ubralo z čítače, který
      // nikdo nezvýšil — a po třech uvařených světech by `world` měl volných
      // slotů víc, než kolik jich vůbec má.
      if (live) releaseSlot('world');
      finishGeneration?.(stored.fault ? 'failed' : 'completed');
      reportServerMetrics(metrics);
      // **Jak generování skončilo, jedním řádkem** (P16 `T8-silentlive`).
      // Snímek metrik výš nese jen `failed`/`completed` a kód poruchy šel dosud
      // jen přes `logRateLimited`, který opakovanou příčinu v okně spolkne. Na
      // produkci se tak 15. 9. 2026 nedalo říct, jestli živý svět odmítla brána,
      // nebo jen nedorazil proud. `fault` je veřejná věta ze `SESSION_FAULTS`,
      // žádný detail brány ani text modelu.
      try {
        console.info(JSON.stringify({
          event: 'worldstream.generation',
          requestId,
          provenance: live ? 'live' : 'prepared',
          outcome: endedWith === null && stored.fault === null ? 'world' : 'failed',
          code: endedWith,
          fault: stored.fault,
          ms: Date.now() - generationStarted,
        }));
      } catch {
        /* Telemetrie nesmí změnit úklid slotu. */
      }
    });
    try {
      after(settled);
    } catch {
      // **`after()` mimo request scope vyhodí**, a to je jediná větev, kterou
      // tenhle `catch` chytá: test, který volá `POST()` přímo, a `next start`.
      // Ani na jednom z těch dvou se instance po odpovědi nezmrazí, takže tam
      // holé `void` platí dál — není to náhradní řešení, je to ta správná
      // odpověď mimo serverless. Že se práce na serverless doopravdy předává
      // platformě, pinuje lexikálně `sessions.test.ts`; uvnitř jednoho procesu
      // se ta vlastnost změřit nedá.
      void settled;
    }

    // **Proud v téže odpovědi, když si o něj klient řekne** (P16 `T8-stream404`).
    // Registr relací je paměť instance a druhý požadavek na `/events` smí na
    // Vercelu dopadnout na instanci, která relaci nezná — naměřeno 15. 9. 2026
    // jako 202 a o vteřinu později 404, porotce bez světa. Odpověď na založení
    // odchází z instance, na které generace běží, takže tuhle relaci zná vždycky.
    // Bez `accept: text/event-stream` zůstává 202 s adresami jako dosud.
    if ((request.headers.get('accept') ?? '').includes('text/event-stream'))
      return sessionEventStream(sessionId, stored, 0, request.signal, {
        'x-worldstream-session': sessionId,
        // Týž původ jako klíč `authored` v JSONu níž a ze stejného důvodu chybí, když píše model.
        ...(served === null ? {} : { 'x-worldstream-authored': served.match }),
      });

    return Response.json(
      {
        requestId,
        sessionId,
        events: `/api/worldstream/sessions/${sessionId}/events`,
        snapshot: `/api/worldstream/sessions/${sessionId}`,
        // **Chybí, když svět píše model**, a to je celý rozdíl, který má
        // porotce vidět. Klíč se posílá jen tehdy, když odpovídá sklad; co
        // s tím rozhraní udělá, patří jemu, ne téhle route.
        ...(served === null ? {} : { authored: { match: served.match } }),
      },
      { status: 202 },
    );
  }));
}

export async function POST(...args:Parameters<typeof handleDurablePOST>):Promise<Response> {
  return withSessionStorageResponse(async()=>{assertSessionStorageReady();return handleDurablePOST(...args);});
}
