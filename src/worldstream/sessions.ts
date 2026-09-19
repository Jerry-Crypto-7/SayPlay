import { observePhase, observePhaseAsync } from '../model/phase-observer';
import { serverPhaseObserver } from '../server/worldstream-metrics';
import type { createServerMetrics } from '../server/worldstream-metrics';
/**
 * **Serverová polovina relace: kdo si ji pamatuje a kdo ji naplní** (P13 T16).
 *
 * Route jsou tři (§21) a všechny tři mluví o **téže** relaci: POST ji založí,
 * SSE proud ji čte, snapshot ji vydá celou. Musí ji proto najít někdo čtvrtý —
 * tenhle modul. Kdyby si ji držela route, která ji založila, ostatní dvě by
 * ji nenašly; sdílený modul je jediný tvar, u kterého se nemusí spoléhat na
 * to, jak bundler poskládá route do chunků.
 *
 * ## ⚠ Registr žije v paměti procesu, a nasazení to pozná
 *
 * Je to **tatáž vada, kterou má `src/server/spend-cap.ts`** a kterou P13 vlna 7
 * (T29, T30) opravuje persistencí: na Vercelu je každý požadavek klidně jiná
 * instance, takže POST na instanci A a proud na instanci B se nepotkají a
 * klient dostane 404. Nikde se proto netvrdí, že relace přežije nasazení —
 * přežije **proces**, a to je všechno. Do vlny 7 je to vědomý dluh, ne
 * nedopatření, a je zapsaný tady, ne jen v plánu.
 *
 * ## Registr má strop, a ten strop nic nezastavuje
 *
 * Relace zakládá **kdokoli s adresou**, takže neomezená mapa je únik paměti
 * dosažitelný zvenčí. Strop je proto na tom, co registr **drží**, ne na tom,
 * kolik jich smí vzniknout: nová relace vždycky projde a nejstarší dokončená
 * vypadne. Odmítat nové relace kvůli počtu by z hlídání paměti udělalo
 * odmítnutí služby.
 *
 * ## Jediná výjimka: vlastní kvóta volajícího
 *
 * „Nová relace vždycky projde" platí proti stropu registru, ne proti kvótě
 * klíče. Na **obsazeném** registru (`QUOTA_ENGAGES_AT` a výš) se nad
 * `MAX_SESSIONS_PER_CALLER` **odmítne nováček** (`putSession` vrátí `false`,
 * route z toho udělá 429) — a je to jediné místo v modulu, kde někdo nedostane
 * relaci kvůli počtu. Důvod je změřený a je u té konstanty: uklidit místo toho
 * cizí relaci znamená dát volajícímu páku na cizí svět, kdežto odmítnutí ho
 * stojí jeho vlastní požadavek.
 *
 * Ta podmínka „na obsazeném registru" je taky změřená, ne opatrnost: klíč je
 * odchozí adresa, takže ho sdílí celá kancelář, a odmítat devátého člověka
 * ve chvíli, kdy je volných 56 slotů z 64, je daň za NATku, ne ochrana slotu.
 */

import { frozenGrammar } from '@/model/client';
import type { Grammar } from '@/model/prompt';
import { buildIntentRequest, readPlannerEmission } from '@/model/worldstream-intent';
import { MAX_PENDING_CHANGES, type PendingChange, type RejectedAt } from '@/model/worldstream-refine';
import { compileWithRepair, type BlueprintEmitter } from '@/model/worldstream-repair';
import { UNIDENTIFIED_CALLER } from '@/server/rate-limit';
import { SpendRefusalError } from '@/server/spend-cap';
import type { WorldstreamBlueprint } from './schema';
import { createSession, type GenerationSession } from './session';
import { shareWorld } from './snapshot-store';
import { proposeSourceScenario, type SourceScenarioResult } from '../model/source-scenario';
import { cloudEmitter } from '../server/worldstream-emitter';
import { createEvidenceProject } from './evidence-commit';
import { sealSimHash, simHashOf, type WorldDoc } from '@/ir/worlddoc';
import {openOrdinarySessionStore,SessionStoreError} from '@/server/session-store';
import {createSessionPersistence} from '@/server/session-persistence';
import {buildIntentPreview} from '@/scene/intent-preview';
import {buildMassingPreview,WORD_MASSING_NOTICE} from '@/scene/massing-preview';
import {wordMassing} from '@/scene/word-massing';
import type { AnswerCache, CachedAnswer } from '@/server/answer-cache';
import type { PlannerEmission } from '@/model/worldstream-intent';
import type { BlueprintOutcome } from '@/model/worldstream-repair';

// Source projects have a single authoritative snapshot, separate from the
// legacy blueprint workflow. T9 reads this complete world/evidence pair.
const evidenceProjects = new WeakMap<StoredSession, ReturnType<typeof createEvidenceProject>>();
function evidenceProject(stored: StoredSession) {
  let project = evidenceProjects.get(stored);
  if (!project) { project = createEvidenceProject(); evidenceProjects.set(stored, project); }
  return project;
}
export function getSessionProject(stored: StoredSession) {
  return evidenceProjects.get(stored)?.getSnapshot() ?? null;
}
export function commitSessionProject(stored: StoredSession, input: unknown) {
  return evidenceProject(stored).commitInitial(input);
}
export function commitSessionIntervention(stored: StoredSession, input: unknown,
  runtime: Parameters<ReturnType<typeof createEvidenceProject>['commitIntervention']>[1]) {
  return evidenceProject(stored).commitIntervention(input, runtime);
}

/** T7: pouze návrh. Přijetí světa a evidence do relace je transakce T8. */
export async function runSourceProposal(
  source: unknown,
  worldRevision: string,
  deps?: Pick<GenerationDeps, 'emit' | 'grammar'>,
  supplement?: string,
): Promise<SourceScenarioResult> {
  const grammar = deps?.grammar ?? serverGrammar();
  if (typeof grammar === 'string') return { kind: 'rejected', code: 'BAD_REQUEST' };
  return proposeSourceScenario({ source, supplement, worldRevision, grammar, observePhase: serverPhaseObserver,
    emit: deps?.emit ?? (async (request) => {
      // Provider configuration and reservation happen only after input validation.
      const emit = await cloudEmitter();
      if (!emit) throw new Error('MODEL_UNAVAILABLE');
      return emit(request);
    }),
  });
}

/**
 * Kolik relací registr drží. Jedna relace je desítky rámců a jeden blueprint,
 * tedy jednotky až desítky kilobajtů; 64 je řádově víc, než kolik jich porotce
 * na jednom procesu otevře, a řádově pod čímkoli, co by procesu vadilo.
 */
export const MAX_LIVE_SESSIONS = 64;

/**
 * Kolik z těch 64 slotů smí držet **jeden klíč volajícího** — a nad tou mezí
 * padá **nováček**, nikdy cizí relace.
 *
 * ⚠ **Bez téhle meze je strop registru páka, kterou se zvenčí zavírají cizí
 * relace** — nález páté nezávislé revize 4. 9. 2026, `VERDICT: blocking`,
 * potvrzený sondou. Třetí kolo `evict()` řadilo přes celý registr, takže
 * útočníkovi stačilo založit 65 relací a ke každé si otevřít vlastní proud:
 * kolo „nejdřív nesledované" pak nenašlo nic a kolo „nejdéle stojící první"
 * obětovalo relaci porotce, protože ta jediná měla `moved` staré. Naměřeno:
 * 1 sledovaná oběť + 64 útočníkových → padla **jen** ta oběť.
 *
 * Osm z 64 znamená, že plný registr potřebuje nejmíň osm různých klíčů, a že
 * jeden klíč nikdy nedrží víc než osminu. Osm současně otevřených světů
 * z jednoho prohlížeče je řádově víc, než kdo otevře.
 *
 * ## ⚠ Devátá relace se ODMÍTNE. Do 4. 9. 2026 uklízela, a to byla horší vada
 *
 * První podoba kvóty uvolnila nad kvótou **nejstarší relaci toho kbelíku**.
 * Šestá nezávislá revize (`VERDICT: blocking`, obojí naměřeno přes skutečný
 * route handler) ukázala, že tím vznikl **levnější útok, než jaký kvóta
 * zavírala**:
 *
 * 1. **Kbelík si vybíral volající, takže to byl zaměřovač, ne ochrana.**
 *    `callerKey()` čte `x-forwarded-for`, tedy hodnotu, kterou píše volající.
 *    Útočník napsal na svých osm POSTů `x-forwarded-for: <IP oběti>`, tím své
 *    relace vložil do kbelíku oběti, a devátý požadavek uvolnil nejstaršího
 *    člena toho kbelíku — oběť. **Naměřeno: 8 POSTů → oběť `RELEASED`,
 *    `live = 8`.** Osm požadavků místo 65 požadavků a 65 proudů, a registr
 *    nemusel být ani zdaleka plný.
 *
 *    ✅ **Od `T16-trustedkey` se kvóta klíčuje jinou funkcí a tenhle bod je
 *    minulý čas — tam, kde důvěryhodný konec řetězu existuje.** Route posílá
 *    `trustedCallerKey(request)`, a ta má **jediný zdroj: hlavičku
 *    `x-vercel-forwarded-for` při `VERCEL=1`**. Žádný druhý tu není a XFF
 *    mezi ně nepatří ani v pevné hloubce proxy — do cizího kbelíku se tedy
 *    hlavičkou nedostane nic.
 *    Tvrdí to kladně route test `podvržená hlavička se do kbelíku oběti vůbec
 *    nedostane`. ⚠ **Mimo Vercel je klíč VŽDYCKY `null`** → sentinel →
 *    kbelík na relaci, tedy **kvóta vypnutá**; stará páka se tam vrací v plné
 *    síle (`T16-cookieowner`). Netýká se to jen `next start` a dema
 *    z notebooku, ale i vlastní reverse proxy: režim s hloubkou řetězu
 *    (`WORLDSMITH_TRUSTED_PROXY_HOPS`) od `e72f9b3` **neexistuje**, protože
 *    počítání pozice v hlavičce nedokáže odlišit, co připsala proxy, od toho,
 *    co si napsal volající. Demo proto pouštět jedině na Vercelu.
 *
 *    ⛔ **A `VERCEL=1` si mimo Vercel nedopisuj** — je to přesně ta ruka,
 *    kterou by člověk kvótu „zapnul" za vlastní nginx, a je to **horší než
 *    vypnutá kvóta**: `x-vercel-forwarded-for` tam nikdo nepřepisuje, takže
 *    se z ní stane hlavička od volajícího a vrátí se celá páka z doby před
 *    `f493ce5` (napiš adresu oběti, naplň jí kbelík, staň se tím největším,
 *    po kterém přetečení sáhne). Zapsané je to i v `.env.example`.
 * 2. **Sdílený kbelík byl nová plocha na odepření služby počestným.** Bez
 *    proxy hlaviček vrací `callerKey()` sentinel, takže do jednoho kbelíku
 *    spadli všichni a strop registru klesl ze 64 na 8 pro celou instanci.
 *    Naměřeno: 12 návštěvníků → `live = 8`. Zavírá to `openSession()` níž.
 *
 * **Odmítnutí ten obchod obrací:** stojí volajícího jeho vlastní požadavek,
 * kdežto uklizení stálo cizího člověka jeho živý svět. Osm POSTů s cizí IP
 * proto dnes zavře akorát zakládání nových světů té IP.
 *
 * ⚠ **Neplatí ale, že cizí běžící svět je tím v bezpečí – tady předchozí
 * znění lhalo a osmá nezávislá revize to naměřila.** Pravidlo „největší
 * kbelík" zůstává zaměřovač, jen se míří jinak: útočník vloží do kbelíku
 * oběti **jednu** relaci s její IP a sám si ji sleduje. Kbelík oběti má tím
 * dva členy proti jednomu u ostatních, je největší, a protože jsou obě jeho
 * relace sledované, vybere se z něj `podleStání[0]` – nejstarší `moved`,
 * tedy relace oběti. **Naměřila to osmá nezávislá revize sondou přes route:
 * nad jednorázově naplněným registrem padl cílený porotce za 2 POSTy
 * a 1 proud, 5 z 5.** V repu drží mechanismus modulový test `nad plným
 * registrem jedna podvržená relace zavře oběti svět` – ten jde přes
 * `openSession()`, ne přes POSTy, takže pinuje **tvar útoku, ne ta čísla**.
 *
 * ⚠ **Plný registr je předpoklad, ne cena, kterou platí útočník.** Registr
 * drží hodinu provozu, ne souběžné uživatele, takže na demo dni ho naplní
 * porotci sami a útok pak stojí ty dva požadavky. Když si ho útočník plní
 * sám, fillery **nepotřebují proud** – stačí 63 holých POSTů. Jediná část
 * ceny, která drží: fillery musí doopravdy uspět, protože relaci ve fázi
 * `failed` sebere druhé kolo `evict()` dřív než oběť.
 *
 * ✅ **Od `T16-trustedkey` (4. 9. 2026) je vložení relace do cizího kbelíku
 * na route úrovni nedosažitelné, protože kvótu klíčuje `trustedCallerKey()`.**
 * Modulový test výš pinuje dál **tvar** útoku a je zelený dál — jde přes
 * `openSession()` s vlastníkem předaným rovnou, tedy obchází hlavičky.
 * ⚠ **Zavřené to je jedině na Vercelu, a jedině při `VERCEL=1`.** Jiný
 * důvěryhodný konec řetězu dnes neexistuje — režim s hloubkou proxy zrušil
 * `e72f9b3`, a `4041c57` zúžil strážce z „`VERCEL` je definované" na rovnost,
 * protože `VERCEL=0` tu větev zapínalo místo aby ji vypnulo. Kde klíč není,
 * je kvóta vypnutá a tvar útoku platí v plné síle (`T16-cookieowner`).
 *
 * ⚠ **Není to zamítnutá alternativa „plný registr odmítá nové relace".** Ta
 * byla zamítnuta vědomě (útočník by držel 64 proudů a hodinu by nezaložil svět
 * nikdo) a platí dál: strop **registru** pořád uklízí, ne odmítá. Odmítá se
 * jedině volající nad **vlastní** kvótou.
 *
 * ⚠ **Vlastní hodinu staré relace volajícího nezamknou** — `putSession()`
 * zametá stárnutí dřív, než kbelík spočítá. Bez toho pořadí by osm relací,
 * které tentýž průchod zrovna pouští, vracelo 429 na devátou.
 *
 * ⚠ **Kvóta se zapíná až od `QUOTA_ENGAGES_AT`, a je to oprava, ne úleva.**
 * Sedmá nezávislá revize naměřila, že odmítání na prázdné instanci dopadá na
 * sdílené odchozí adresy — devět porotců za jednou NATkou je jeden klíč.
 * Odůvodnění je celé u té konstanty.
 *
 * ⚠ **Odmítnutí se nedá zrušit zavřením okna a hláška to nesmí slibovat.**
 * `release()` je dosažitelné jedině ze zametení a z přetečení registru;
 * koncový bod „zavři mi relaci" neexistuje. Naměřeno sedmou revizí: volající
 * na kvótě, který zavře všechny karty, je zpátky v poli až po **dvou** hodinách
 * a třech požadavcích, protože jedno zametení se spotřebuje na překlopení
 * `watched` a hodina se rozeběhne až tím druhým. Dokud takový koncový bod
 * nevznikne, smí 429 říct jen to, **co platí** — ne radu, která neplatí.
 *
 * ⚠ **Co to NEZAVÍRÁ, a je to vědomé — přepsáno 5. 9. 2026, `T16-keydoctrine`.**
 * Věta „klíč jde pořád podvrhnout, osm požadavků s IP oběti naplní její
 * kbelík" **platí dál, jen ne o kvótě** — a rozdíl je podstatný, protože
 * první podoba téhle věty ho zamlčela a nezávislá revize to naměřila.
 * O **kvótu** volající přišel: od `f493ce5` ji klíčuje `trustedCallerKey()`
 * a do cizího kbelíku se hlavičkou nedostane nic.
 *
 * ⛔ **Zablokovat oběti zakládání světů ale jde dál, jinou mezí.** Strop
 * frekvence klíčuje `callerKey()`, tedy **první** položku `x-forwarded-for`,
 * kterou píše volající — a route si slot bere **dřív** než kvótu. Útočník,
 * který drží 5 požadavků za sekundu s hlavičkou `x-forwarded-for: <IP oběti>`,
 * odrazí obětin vlastní požadavek na **429**, a to na všech sedmerých dveřích.
 * **Naměřeno nezávislou revizí spuštěním.** Je to vědomá cena: klíč stropu
 * frekvence se podvrhnout **smí**, protože podvrh tam vrací útočníka nanejvýš
 * tam, kde by byl bez meze, a rozeznatelnější klíč mimo Vercel neexistuje.
 * ⛔ **Neplatí ale, že „cizí relaci to nezavře, jen odmítne novou" — tak to
 * tu stálo do 5. 9. 2026 a třetí nezávislá revize to naměřila jinak.** Týchž
 * 5 požadavků za sekundu s hlavičkou oběti kousne i `POST …/<relace>/changes`
 * a `…/commit`, protože `changes/route.ts` si slot bere **před** dohledáním
 * relace: útočník tedy nepotřebuje ani platné `sessionId`, ani tělo, ani
 * vlastní relaci. Obětin **běžící** svět tím sice nezmizí, ale po dobu okna
 * jí neprojde druhá věta ani commit, tedy hlavní funkce produktu.
 * **Naměřeno přes skutečný handler `createChange()`: 50 podvržených
 * požadavků → oběť 429.** Držet to stojí ~20 req/s na čtvery dveře dohromady,
 * což je pořád pod stropem instance (40 req/s), takže se to samo nezastaví.
 * Celý rozdíl mezi touhle cenou a klíčem kvóty je v tabulce v hlavičce
 * `rate-limit.ts`.
 *
 * **Pin té ceny je route test** „útočník s hlavičkou oběti jí přes tyhle dveře
 * odrazí požadavek na 429" (`src/app/api/worldstream/__tests__/sessions.test.ts`).
 * Plní okno přes skutečný handler s `VERCEL=1`, takže zčervená, jakmile si
 * route odvodí klíč frekvence z něčeho, do čeho volající nemluví. ⚠ Modulový
 * test v `rate-limit.test.ts` tuhle práci **nedělá** — volá `callerKey()`
 * napřímo a mutaci route přežije; naměřeno 5. 9. 2026.
 *
 * Nad kvótou zbývají dvě cesty, obě s vlastní úlohou:
 * **mimo Vercel** je klíč `null` a kvóta vypnutá (`T16-cookieowner`), a
 * **jediná IPv6 /64** dá jednomu volajícímu 64 různých klíčů, čímž srovná
 * kbelíky na jedničku a strop registru vybírá zase starým pořadím
 * (`T16-addrshape`). Až obě zavřou, přepíše se tenhle odstavec znovu.
 *
 * ⚠ **A jak dlouho ten blok trvá: dokud běží proces, ne hodinu — ale jen nad
 * prahem** (`T16-idleforever`, změřeno 4. 9. 2026 v +1 h, +24 h i +30 dní,
 * meze doměřila nezávislá revize téhož dne). `idleFor()` obnovuje `since` při
 * každém zametení, dokud `watchers > 0`, a `GET /events` žádné ověření nemá,
 * takže oběti kbelík nezestárne. **Osm podvržených POSTů samo o sobě ale
 * neblokuje nikoho** — pod `QUOTA_ENGAGES_AT` kvóta vůbec neodmítá. Skutečná
 * cena útoku je **držet registr na prahu**, tedy dalších ~32 živých relací
 * se sledovaným proudem; až nad ním těch osm něco zavře. **Shora to má mez
 * taky:** nad 64 relacemi je kbelík oběti ten **největší**, takže
 * `nejdražšíKbelík()` sáhne po podvržené relaci a kbelík se každým přetečením
 * o jednu ztenčí. Blok tedy platí v pásmu **32–64** obsazených slotů, ne všude.
 * Drží to na fázi `world`: proud nad `failed` si `events/route.ts` zavře sám
 * na koncovém rámci, kdežto `advance('complete')` nemá v provozu volajícího,
 * takže **úspěšná generace končí ve `world` a její proud zůstává otevřený.**
 * Zbytek tvrdí kladně test `osm podvržených relací s drženým proudem drží
 * oběti kbelík plný i po třiceti dnech` — práh si podkládá `naPráh()`, a je to
 * část útoku, ne kulisa testu.
 *
 * ⚠ **Tuhle páku stárnutím nespravíš — ale kvótu samu drží od 6. 9. 2026
 * právě stárnutí, a tenhle odstavec se dvakrát přepsal, tak ať se ta cesta
 * neopisuje potřetí.**
 *
 * (a) **Vyjmout `complete`/`failed` z `callerHolds()` je ZAMÍTNUTÉ, a je to
 * druhé zamítnutí téže cesty — nezkoušet ji znovu.** Poprvé (4. 9. 2026)
 * padla na tom, že bez `.env` skončila každá relace `failed` ještě před
 * dalším POSTem: `callerHolds()` vracel nulu a čtyři route testy červenaly.
 * Předpoklad zrušila `T46-routewire` (sklad uvařených světů, každá věta
 * dostane aspoň nejbližší), tak se to 6. 9. udělalo — a **nezávislá revize
 * téhož dne to vrátila, protože ten sklad se konzultuje jedině bez klíče**
 * (`sessions/route.ts`: `cloud === null ? chooseAuthored(…) : null`).
 * S klíčem stačí vyčerpat strop utrácení nebo počkat na výpadek
 * poskytovatele a relace je zase `failed` do milisekund. **Naměřeno: jeden
 * klíč otevřel 500 z 500 relací a zabral všech 64 slotů.** Fázový přeskok
 * tedy kvótu nevypnul jen na dnešní sadě — vypnul ji na nasazení.
 *
 * ✅ **Co to nahradilo: doběhlá relace se počítá dál, jen stárne minutou**
 * (`TERMINAL_SESSION_MS`) místo hodiny. Odmítnutí kvótou tím přestává být
 * trvalé, což byl celý `T16-idleforever`, a vypnout kvótu to nedovolí,
 * protože osm padlých relací se pořád počítá jako osm. Naměřená cena
 * přepnutí: **jediný test**, ten z `34e66df`, a přepsal se s odůvodněním.
 *
 * ⚠ **Tuhle páku (podvržený klíč nad prahem) to pořád netrefuje, a to se
 * nezměnilo:** drží na fázi `world`, ne na doběhlé. Zavírá ji klíč
 * z důvěryhodného konce řetězu (`T16-trustedkey`), ne čtvrté kolo stárnutí.
 *
 * (b) Nechat stárnout i **sledované** relace položí pinnutou vlastnost
 * „otevřený proud drží relaci naživu i tři hodiny" — tedy přesně toho
 * porotce, kvůli kterému ta vlastnost vznikla. **Zamítnuté to zůstává, a je
 * to jiná věc než minuta na doběhlou relaci:** ta doběhlou nikdo nesleduje,
 * proud si `events/route.ts` zavře sám na koncovém rámci.
 *
 * ✅ **Ten klíč přistál 4. 9. 2026 a je to `trustedCallerKey()`, ne opravený
 * `callerKey()`.** Plán předepisoval opravit tu původní funkci; **změřeno
 * předem, že to položí 8 testů, a čtyři z nich pinují opravu dřívějšího
 * blokujícího nálezu** — strop frekvence by bez rozeznatelného klíče spadl
 * zpátky na „strop na dveře", tedy 5,1 req/s zavře dveře všem. Rozdělily se
 * proto podle toho, co podvržený klíč způsobí: u frekvence nic (vrací
 * útočníka tam, kde by byl bez meze), u kvóty všechno. Celá tabulka je
 * v hlavičce `trustedCallerKey()` v `src/server/rate-limit.ts`.
 *
 * ⚠ **Přeřazení tuhle třídu nezavře a příští kolo to nemá zkoušet.** Obrátit
 * třetí kolo na LIFO (nejnovější sledovaná padá první) vypadá jako oprava —
 * útočníkovy čerstvé relace by platily samy. Jenže útočník, který svých 64
 * relací založí **před** porotcem, tím pořadí obrátí ve svůj prospěch a padá
 * zase porotce, protože je nejnovější. Každý pevný směr řazení má konec, na
 * který se dá postavit; proto kvóta, ne jiné pořadí.
 */
export const MAX_SESSIONS_PER_CALLER = 8;

/**
 * Od jaké obsazenosti registru kvóta vůbec **začne odmítat**.
 *
 * ⚠ **Nález sedmé nezávislé revize 4. 9. 2026, `VERDICT: blocking`, změřený.**
 * Kvóta bez tohohle prahu odmítala i tam, kde o žádný slot nikdo nesoupeřil,
 * a dopadalo to na populaci, kterou si tenhle soubor jmenuje sám: **devět
 * porotců za jednou firemní NATkou** má jeden `callerKey`, takže devátý dostal
 * 429 na instanci, kde bylo volných 56 slotů z 64. Věta „odmítnutí stojí
 * volajícího jeho vlastní požadavek" je pravdivá jedině tehdy, když je klíč
 * jeho — u sdílené odchozí adresy stojí devátého člověka celý svět.
 *
 * **Kvóta je mez na soupeření o slot, ne daň za sdílenou adresu.** Dokud je
 * registr z poloviny prázdný, nikdo se o nic nepere a odmítat není proč.
 * Nad prahem už ano, a tam platí `MAX_SESSIONS_PER_CALLER` beze změny.
 *
 * ⚠ **Co to volnější pravidlo NEROZBÍJÍ, a je to spočítané, ne odhadnuté.**
 * Jeden klíč se pod prahem dostane nejvýš na `QUOTA_ENGAGES_AT` relací, tedy
 * na polovinu registru — víc mu strop kvóty nedovolí, protože ta se od prahu
 * zapne. Registr proto **jedním klíčem naplnit nejde** a to je jediná
 * vlastnost, na které stojí ochrana proti páce: třetí kolo `evictOverCap()`
 * bere oběť z **největšího** kbelíku, a kbelík o 32 relacích je vždycky větší
 * než porotcův o jedné. **Pinuje to `sessions.test.ts` na skutečném čísle:
 * jeden klíč se na jinak prázdném registru dostane nejvýš na 32 relací.**
 * (Dřív tu stálo „1 sledovaná oběť + útočník na jednom klíči → registr
 * přeteče"; takový scénář je s prahem **nemožný** a ten test nikdy
 * neexistoval. Osmá nezávislá revize, `VERDICT: blocking`.)
 *
 * ⚠ **Půlka problém sdílené adresy zmenšuje, neodstraňuje ho – změřeno,
 * a předchozí znění tvrdilo opak.** Na prázdném registru projde devět
 * porotců za jednou NATkou všech devět. Na registru přesně na prahu projde
 * **8 z 9** a devátý dostane 429 ve chvíli, kdy je **24 slotů volných**:
 * kvóta se soudí podle obsazenosti, ne podle toho, kolik zbývá. Situace
 * „odmítnut, a přitom volno" tedy vyrobit jde a na obsazeném registru
 * NATka o slot platí. Je to vědomá cena za to, že jeden klíč nesmí registr
 * naplnit; vázat práh na volné sloty by tu daň posunulo, ne zrušilo.
 */
export const QUOTA_ENGAGES_AT = MAX_LIVE_SESSIONS / 2;

export interface StoredSession {
  recovery?:{readonly kind:'restored'|'interrupted';readonly pendingChanges:'invalidated';readonly sourceProjects:'not-restored'};
  readonly session: GenerationSession;
  /**
   * Klíč volajícího, který relaci založil.
   *
   * ⚠ **Od `T16-trustedkey` je to `trustedCallerKey()`, ne `callerKey()`** —
   * konec řetězu, do kterého volající nemluví. Ty dvě funkce se schválně
   * liší; proč, stojí u té druhé v `src/server/rate-limit.ts`.
   *
   * **Vlastnictví bydlí tady, ne ve třetí mapě.** `live` a `watched` jsou dvě
   * mapy a druhá už jednou stála za nálezem o neuklizeném stavu; třetí by
   * potřebovala vlastní úklidovou cestu. Takhle vlastnictví umírá s relací
   * v `live.delete()` a není co zapomenout.
   *
   * ⚠ **Sentinel `UNIDENTIFIED_CALLER` se sem nikdy nedostane** —
   * `openSession()` ho překládá na `sessionId`, tedy na vlastní kbelík.
   * Kdyby se sem dostal, byl by z kvóty strop 8 na celý proces.
   */
  readonly owner: string;
  /** Autoritativní blueprint pro reconnect (§21). `null`, dokud nevznikl. */
  blueprint: WorldstreamBlueprint | null;
  /** Separately validated visuals only; never an accepted simulation. */
  visualPreview?: import('./schema').VisualPreview | null;
  /** Request-local diagnostics survive reconnect, never enter blueprint/hash/replay. */
  generationMetrics?: ReturnType<typeof createServerMetrics>;
  /** One server-owned A4 origin. Never restored from client JSON or across process restarts. */
  comparisonOrigin?: { readonly original: WorldDoc; readonly acceptedSimHash: string;
    readonly acceptedSimRevision: number; readonly stableId: string } | null;
  /**
   * Id uvařeného světa, ze kterého tahle relace vznikla, nebo `null`, když ji
   * napsal model (`T35-actsthree4`).
   *
   * **Bez tohohle řádku nemá druhá věta ze skladu co vydat.** Uvařená změna
   * nese `stableId` z jednoho konkrétního blueprintu, takže se dá nabídnout
   * jedině tomu světu, nad kterým ji model napsal; hledat ji přes celý sklad
   * znamená vydat cizí `stableId` a nechat `readRefineEmission()` odpověď
   * odmítnout. Vlastnictví bydlí tady ze stejného důvodu jako `owner` — umře
   * s relací a není co uklízet.
   *
   * Ven **nejde**: snapshot relace vydává původ jako `exact`/`nearest`
   * (`T45-honestlabel`), ne jako klíč do skladu. Id uvařeného světa je vnitřní
   * jméno a porotce z něj nemá co rozhodnout.
   */
  authoredWorldId: string | null;
  /** Proč to skončilo, **veřejnou** větou. `null`, dokud to neskončilo. */
  fault: string | null;
  /**
   * Adresa hotového světa ve sdíleném registru (`snapshot-store.ts`), nebo
   * `null`, dokud svět nevznikl. Snapshot relace ji vydává ven, aby ji měl kdo
   * předat dál — sdílení je lidský akt a bez adresy ho nikdo neudělá.
   */
  sharedWorld: string | null;
  /**
   * Previewy druhé věty čekající na commit (T22, §21).
   *
   * Bydlí tady ze stejného důvodu jako celý tenhle modul: preview zakládá jedna
   * route a commituje ho druhá, takže si ho ani jedna z nich nesmí držet sama.
   * Životnost je životnost relace — vypadne-li relace z registru, vypadnou
   * s ní i její previewy a nezůstane po nich mapa, kterou nikdo neuklidí.
   */
  readonly changes: Map<string, PendingChange>;
  /**
   * Svět vznikl z uložené odpovědi modelu na tutéž větu (P16 T6), nebo
   * `null`/chybí, když ho model psal teď. Snapshot relace to vydává ven a
   * rámec `blueprint.ready` to nese taky — porotce má vědět, že se nečekalo
   * na model, protože jinak by čas do světa vypadal jako výkon modelu.
   * Relace obnovená z disku to nenese: o svém původu už nic neví.
   */
  reused?: ReusedAnswer | null;
}

/** Co relace ví o zásahu cache. `savedCalls` jsou obě přeskočená volání: plánovač a kompilátor. */
export interface ReusedAnswer {
  readonly at: string;
  readonly savedCalls: number;
}

const host=globalThis as typeof globalThis & {__worldstreamOrdinarySessions?:Map<string,StoredSession>;__worldstreamSessionDisk?:{
  path:string;adapter:ReturnType<typeof createSessionPersistence>|null;failed:boolean;exit?:()=>void}};
const live = host.__worldstreamOrdinarySessions??(host.__worldstreamOrdinarySessions=new Map<string,StoredSession>());
/** Explicit host wiring; absent env preserves the in-memory default. */
export function assertSessionStorageReady():void {
  const path=process.env.WORLDSMITH_SESSION_STORE_FILE,existing=host.__worldstreamSessionDisk;
  if(existing) {
    if(existing.failed||existing.path!==path)throw new SessionStoreError();
    existing.adapter?.healthy();return;
  }
  if(path===undefined)return;
  const state:{path:string;adapter:ReturnType<typeof createSessionPersistence>|null;failed:boolean;exit?:()=>void}={path,adapter:null,failed:false};host.__worldstreamSessionDisk=state;
  try {
    if(process.env.WORLDSMITH_OWNER_IDENTITY!=='trusted-proxy'||process.env.VERCEL!==undefined)throw new SessionStoreError();
    const store=openOrdinarySessionStore(path);
    try{state.adapter=createSessionPersistence(live,store);}catch(error){store.close();throw error;}
    for(const [id,stored] of live)idleFor(id,stored,Date.now());
    state.exit=()=>{try{state.adapter?.close();}catch{/* A failed exit never steals another owner's lock. */}};
    process.once('exit',state.exit);
  }catch{state.failed=true;throw new SessionStoreError();}
}
/** Test lifecycle seam: simulates a stopped process without deleting the disk checkpoint. */
export function resetSessionStorageForTests():void {
  const exit=host.__worldstreamSessionDisk?.exit;if(exit)process.removeListener('exit',exit);
  host.__worldstreamSessionDisk?.adapter?.close();delete host.__worldstreamSessionDisk;live.clear();watched.clear();
}
function flushSessionStorage():void {host.__worldstreamSessionDisk?.adapter?.flush();}

/** Return to the original rules as a NEW accepted revision; appearance is unchanged. */
export function restoreComparisonOrigin(stored: StoredSession, expected: { simRevision: number; lookRevision: number; simHash: string }) {
  const blueprint = stored.blueprint;
  const origin = stored.comparisonOrigin;
  const reject = (code: string, detail: string) => ({ ok: false as const, code, detail });
  if (!blueprint || !origin) return reject('NO_COMPARISON', 'There is no accepted comparison to return from.');
  const current = blueprint.world;
  if (current.simRevision !== expected.simRevision || current.lookRevision !== expected.lookRevision || current.simHash !== expected.simHash
    || current.simHash !== origin.acceptedSimHash || current.simRevision !== origin.acceptedSimRevision)
    return reject('STALE_REVISION', 'The world changed after this comparison.');
  if (current.simRevision >= Number.MAX_SAFE_INTEGER || origin.original.simHash !== simHashOf(origin.original))
    return reject('INVALID_ORIGIN', 'The original simulation cannot be restored.');
  const world = sealSimHash({ ...current, sim: structuredClone(origin.original.sim), simRevision: current.simRevision + 1 });
  const next = { ...blueprint, world };
  // All validation precedes this synchronous write. No revision is rolled back.
  stored.blueprint = next;
  stored.comparisonOrigin = null;
  stored.changes.clear();
  stored.session.events.append('patch.committed', { stableId: origin.stableId, applied: ['sim'],
    changedLeaves: ['/sim/rules'], revisions: { sim: { before: current.simRevision, after: world.simRevision },
      look: { before: current.lookRevision, after: world.lookRevision } }, representation: null,
    comparisonRestored: true }, origin.stableId);
  return { ok: true as const, blueprint: next };
}

/**
 * Jak dlouho smí relace stát bez jediného nového rámce, než ji registr pustí.
 *
 * **Bez téhle meze strop `MAX_LIVE_SESSIONS` nedrží nic** — nález nezávislé
 * revize 2. 9. 2026. `evict()` uměl uvolnit jen fáze `complete` a `failed`,
 * jenže úspěšná generace končí ve fázi `world` a `session.complete` dnes
 * neemituje nikdo. Jediná relace, kterou registr uměl uvolnit, byla ta
 * **neúspěšná**, takže na nasazení, kde relace začnou uspívat, roste mapa bez
 * konce. V dnešní sadě to nevidět: bez `.env` skončí každá relace `failed`
 * a uklidí se.
 *
 * ⚠ **Řešení je stárnutí, ne přejmenování fáze.** Relace ve `world` je právem
 * otevřená: prohlížeč teprve mele tvary a hlásí je zpátky (T18), takže proud
 * musí zůstat živý a `session.complete` patří až za poslední tvar.
 *
 * Hodina je řádově víc, než trvá nejpomalejší meshing, a řádově míň, než jak
 * dlouho by kdokoli nechal otevřené okno, do kterého se dívá.
 */
export const IDLE_SESSION_MS = 60 * 60 * 1000;

/**
 * Jak dlouho smí v registru stát relace, která **už nikam nejde** — tedy
 * `complete` nebo `failed`.
 *
 * **Bez téhle kratší meze je kvóta volajícího vypnutelná zvenčí** — nález
 * nezávislé revize 6. 9. 2026, CONFIRMED spuštěním. Do té chvíle se doběhlé
 * relace z `callerHolds()` prostě vyjímaly, což stálo na předpokladu, že
 * relace dojde do fáze `world`. **Ten předpoklad platí jen bez klíče.**
 * Uvařený sklad se konzultuje jedině tehdy, když model nakonfigurovaný není
 * (`sessions/route.ts`: `cloud === null ? chooseAuthored(…) : null`), takže
 * na nasazení **s klíčem** stačí vyčerpat strop utrácení nebo počkat na
 * výpadek poskytovatele: `reserve()` odmítne ještě před sítí, relace je
 * `failed` do milisekund, `callerHolds()` vrací nulu a
 * `MAX_SESSIONS_PER_CALLER` neodmítne nikoho. **Naměřeno revizí: jeden klíč
 * otevřel 500 z 500 relací a zabral všech 64 slotů**; nad prahem měl dostat
 * osm. Spustit to jde bez účtu — strop je sdílený a trvalý, takže ho vyčerpá
 * řádově deset POSTů.
 *
 * ⚠ **Fáze se proto počítají zase všechny a kvótu uvolňuje ČAS, ne fáze.**
 * Minuta je řádově míň než hodina, po kterou smí stát relace živá, a řádově
 * víc, než co porotce potřebuje na přečtení chybové hlášky — snímek relace
 * mizí až za ní. Odmítnutí kvótou tím přestává být trvalé
 * (`T16-idleforever`), aniž by šla kvóta vypnout (`T16-quotaselfengage`).
 *
 * ⚠ **Nesahat na to zkrácením `IDLE_SESSION_MS`.** Ta hodina drží relaci ve
 * fázi `world`, tedy tu, do které se porotce dívá; zkrátit ji znamená zavřít
 * mu svět pod rukama.
 */
export const TERMINAL_SESSION_MS = 60 * 1000;

/**
 * Kdy naposledy se relaci pohnul proud — **vlastní čtení registru**, ne značka
 * v logu.
 *
 * Log rámce časem razítkuje (`at`), ale to razítko je podle `events.ts`
 * výslovně observační a nesmí nic řídit. Registr si proto vede vlastní
 * záznam: číslo posledního rámce a čas, kdy ho poprvé viděl stát. Pohnulo-li
 * se číslo, relace žije; nepohnulo-li se hodinu, je to okno, které někdo
 * zavřel, aniž by to kdo řekl.
 */
interface IdleWatch {
  /** Číslo posledního rámce, které registr u téhle relace viděl. */
  readonly sequence: number;
  /**
   * Kdy registr naposledy viděl to číslo **se hnout** — řadicí klíč třetího
   * kola, oddělený od hodiny stárnutí (`T16-agesignal`).
   *
   * Do 4. 9. 2026 řadilo třetí kolo podle `since`, jenže to se sledované
   * relaci obnovuje při každém zametení. V registru samých sledovaných relací
   * proto byly všechny klíče stejné, stabilní řazení spadlo na pořadí vzniku
   * a obětí byla relace #0 — vybraná proto, že vznikla první, ne proto, že
   * stojí nejdéle. Doktrína u `evict()` přitom tvrdila to druhé.
   */
  readonly moved: number;
  /** Odkdy relaci běží hodina stárnutí. */
  readonly since: number;
  /**
   * Měla ta relace při **minulém** pohledu diváka?
   *
   * ⚠ Bez téhle jediné vlajky se hodina nepočítá od odchodu diváka, ale od
   * posledního cizího POSTu — nález nezávislé revize 4. 9. 2026,
   * `VERDICT: blocking`. Sledované relaci se `since` obnovuje při každém
   * zametení, takže když divák odejde, `else` větev porovnává proti razítku,
   * které postavil někdo úplně jiný. Naměřeno: relace založená v T0, jediný
   * POST v T0+1 ms, divák drží proud 61 minut a spojení mu spadne (proxy,
   * uspaný notebook, reload — SSE padá běžně, proto existuje tep); první cizí
   * POST o vteřinu později ji uvolní, ačkoli registr nikde netlačí na strop.
   * Hodina proto začíná běžet na přechodu 1 → 0, ne dřív.
   */
  readonly watched: boolean;
}

const watched = new Map<string, IdleWatch>();

/**
 * Uvolní relaci **a řekne to jejímu proudu**.
 *
 * ⚠ **To druhé je celá pointa, a chybělo to.** Nález nezávislé revize
 * 3. 9. 2026, `VERDICT: blocking`: smazat relaci ze dvou map paměť neuvolní.
 * Otevřený SSE proud (`sessions/[sessionId]/events/route.ts`) si drží odběr
 * logu a patnáctivteřinový časovač, a ten časovač je kořen, ze kterého vede
 * řetěz na celý `StoredSession` — blueprint, mesh cache i previewy. Vlastní
 * úklid route spouští jedině odchod klienta. **Naměřeno:** 65 POSTů s otevřeným
 * `/events` u každého → registr hlásí 64, proces drží 65 relací a 65 běžících
 * časovačů, a klient první relace dostává tep dál, zatímco všechny ostatní
 * dveře na tutéž relaci odpovídají 404.
 *
 * Dokud uvolňovaly jen `complete` a `failed`, nebylo to vidět: takový proud se
 * zavře sám, protože terminální rámec zavolá `finish()`. Třetí kolo stropu je
 * první cesta, která pustí relaci, jež do koncové fáze **nikdy nedojde**.
 *
 * Řešení proto tou cestou jde: relace se **ukončí** dřív, než zmizí z mapy.
 * `fail()` zapíše `session.failed`, odběratel ho dostane synchronně, uvidí
 * koncovou fázi a zavolá `finish()` — tedy `clearInterval` i odhlášení. Klient
 * se současně dozví **proč**, místo aby dostával tep do prázdna. Na relaci,
 * která už koncová je, je `fail()` bez účinku, takže dvoje dveře nevadí.
 */
function release(sessionId: string): void {
  const stored = live.get(sessionId);
  if (stored !== undefined && stored.fault === null) {
    stored.fault = SESSION_FAULTS.SESSION_RELEASED;
    stored.session.fail(SESSION_FAULTS.SESSION_RELEASED);
  }
  live.delete(sessionId);
  stored?.session.events.beforePublish(null);
  flushSessionStorage();
  // **Previewy se pouštějí, ne jen odkazují** (`T22-previewleak`). Že visí na
  // `StoredSession`, stačí jen tehdy, když ten objekt nikdo jiný nedrží — a
  // route druhé věty ho drží přes celé volání modelu (`T16-changeafterrelease`).
  // Osm plánů včetně `ShapeProgram` je pak řetěz, který přežije uvolnění.
  if (stored !== undefined) stored.changes.clear();
  watched.delete(sessionId);
}

/**
 * Stojí ta relace tak dlouho, že už se na ni nikdo nedívá?
 *
 * **Dva signály života, otevřený proud je ten první.** ⚠ Nález nezávislé
 * revize 4. 9. 2026, `VERDICT: blocking`: samotné `sequence` tuhle otázku
 * zodpovědět neumí. Po `world.ready` ho v provozu **nehne nic** — meshování
 * běží v prohlížeči a žádná route mu rámec nevrací (`session.queue()` nemá
 * mimo testy volajícího), tep SSE se píše rovnou do proudu a do logu nejde.
 * Číslo tedy zamrzne pár vteřin po založení úplně každé relaci a hodina se
 * počítá od té chvíle. Jeden porotce, jedna věta, hodinu otevřená karta —
 * a další POST kohokoli jiného mu tu relaci uklidí pod rukama, i když
 * registr nikde netlačí na strop.
 *
 * Otevřený odběr logu je proti tomu přímý důkaz, že na druhé straně někdo
 * je: `sessions/[sessionId]/events/route.ts` ho drží přesně tak dlouho, jak
 * dlouho drží spojení, a pouští ho, jakmile klient odejde. Relace s divákem
 * proto stárnout nezačne; `sequence` zůstává jako druhý signál pro relace,
 * které nikdo nesleduje a přesto se v nich něco děje.
 *
 * ⚠ **Strop tím obejít nejde.** Tohle je jen první kolo `evict()`. Když se
 * registr přeplní samými sledovanými relacemi, třetí kolo je pustí stejně —
 * proto se `watched` obnovuje i tady, aby se v tom pořadí sledovaná relace
 * řadila za tu, kterou nikdo nedrží, místo před ni.
 */
function idleFor(sessionId: string, stored: StoredSession, now: number): boolean {
  const { sequence, watchers } = stored.session.events;
  const seen = watched.get(sessionId);
  // `seen.watched` je čtvrtý důvod k obnovení: relace, kterou minule ještě
  // někdo držel, teprve teď osiřela a hodina jí začíná **tady**.
  if (seen === undefined || seen.sequence !== sequence || watchers > 0 || seen.watched) {
    const moved = seen === undefined || seen.sequence !== sequence ? now : seen.moved;
    watched.set(sessionId, { sequence, moved, since: now, watched: watchers > 0 });
    return false;
  }
  // **Doběhlá relace stárne minutou, ne hodinou** (`TERMINAL_SESSION_MS`).
  // Hodina patří relaci, do které se někdo dívá; relace, která už nikam
  // nejde, drží jen slot a kbelík svého volajícího.
  const phase = stored.session.phase;
  const mez = phase === 'complete' || phase === 'failed' ? TERMINAL_SESSION_MS : IDLE_SESSION_MS;
  return now - seen.since >= mez;
}

/**
 * **První kolo úklidu:** relace, které nikdo nesleduje a hodinu se v nich nic
 * nestalo, ať jsou v jakékoli fázi. **Stárnutí je na divákovi a na pohybu
 * proudu, ne na fázi** — relace s otevřeným proudem nebo s přibývajícími rámci
 * se tohle kolo nedotkne, i kdyby běžela den (`idleFor` výš).
 *
 * Kola jsou tři a jdou od nejlevnější ztráty. Druhé a třetí jsou
 * v `evictOverCap()` níž, protože se spouštějí až nad plným registrem:
 *
 * 2. Nad stropem: nejstarší **dokončené**, tedy `complete` a `failed`.
 * 3. Pořád nad stropem: ty, které **stojí nejdéle**, bez ohledu na fázi.
 *
 * Zametá se při zakládání nové relace, tedy tehdy, když registr roste. Když
 * nikdo nezakládá, nic neroste a není co zametat.
 */
function sweepIdle(now: number): void {
  for (const [id, stored] of live) if (idleFor(id, stored, now)) release(id);
}

/**
 * Kola 2 a 3: co uvolnit, když registr **přeteče** svůj strop.
 *
 * Oddělené od prvního kola, protože se spouštějí v jinou chvíli. Stárnutí musí
 * proběhnout **před** kvótou volajícího (jinak by osm jeho vlastních hodinu
 * stojících relací vracelo 429 na devátou), kdežto strop registru rozhoduje až
 * nad relací, která už v mapě je.
 *
 * ⚠ **Třetí kolo je změna doktríny a je vynucená měřením.** Do 3. 9. 2026 tu
 * stálo, že běžící relace se nevyhodí ani jako nejstarší, protože „utnout proud
 * někomu, kdo se dívá, je horší než o jednu relaci nad strop". Nezávislá revize
 * ukázala, že „o jednu" byla nepravda: se stárnutím na hodinu a bez třetího
 * kola zní mez **„příchody za hodinu"**, ne `MAX_LIVE_SESSIONS`. Dvě stě
 * požadavků v jedné hodině — tedy den, na který se tenhle produkt chystá —
 * drží dvě stě relací a strop 64 nedělá nic. Neomezená mapa dosažitelná zvenčí
 * je přesně to, proti čemu strop je.
 *
 * Obětuje se proto ta, která stojí nejdéle: `watched.moved` je čas, kdy registr
 * naposledy viděl proud té relace **hnout se**, takže relace, do které se
 * právě píše, je v tom pořadí poslední. První kolo `watched` přepíše pro
 * všechny, takže se řadí nad čerstvými čísly, ne nad zbytky.
 *
 * ⚠ **`keep` je ta právě založená relace a nesmí padnout za oběť vlastnímu
 * zametení.** Bez téhle výjimky se obě kola obrátí proti ní: divák si proud
 * otevírá až **po** odpovědi na POST, takže v okamžiku zametení je nová
 * relace jediná nesledovaná v registru — a v registru samých sledovaných relací
 * by tedy byla vždycky jedinou obětí. Nikdo by pak nezaložil svět, dokud by se
 * 64 lidí dívalo. „Nová relace vždycky projde" je doktrína registru z hlavičky
 * souboru a proti stropu registru platí bez výjimky; jediné, co nováčka odmítá,
 * je jeho **vlastní** kvóta o kus níž.
 */
function evictOverCap(keep: string): void {
  if (live.size <= MAX_LIVE_SESSIONS) return;
  for (const [id, stored] of live) {
    if (live.size <= MAX_LIVE_SESSIONS) return;
    const phase = stored.session.phase;
    if (id !== keep && (phase === 'complete' || phase === 'failed')) release(id);
  }

  if (live.size <= MAX_LIVE_SESSIONS) return;
  // **Oběť se hledá v největším kbelíku, ne přes celý registr.** Pátá nezávislá
  // revize 4. 9. 2026 naměřila, že řazení přes celý registr je páka, kterou
  // zvenčí zavřeš cizí relaci: útočník si svých 65 relací **sám sleduje**,
  // takže kolo „nejdřív nesledované" nenajde nic a nejstarší `moved` má
  // relace porotce. Uvnitř kbelíku pořadí zůstává, protože tam je správné.
  while (live.size > MAX_LIVE_SESSIONS) {
    const oběť = nejdražšíKbelík(keep);
    if (oběť === undefined) return;
    release(oběť);
  }
}

/**
 * Kdo zaplatí, když je registr plný: **relace z klíče, který jich drží nejvíc**.
 *
 * Uvnitř toho kbelíku platí staré pořadí — nejdřív ta, na kterou se nikdo
 * nedívá, a mezi nimi ta, které se nejdéle nehnul proud. Obojí je správně:
 * nesledovaná relace je levnější ztráta a `moved` říká, jak dlouho stojí.
 *
 * ⚠ **Na shodě velikostí to spadne zpátky na staré pořadí, a je to napsané
 * schválně.** Útočník, který si vymyslí 64 hlaviček po jedné relaci, srovná
 * kbelíky na jedničku a vybírá se zase přes celý registr. Cena útoku tím
 * stoupla o „měň hlavičku", ne o řád — celý rozpad i zamítnutá alternativa
 * jsou u `MAX_SESSIONS_PER_CALLER`.
 *
 * ⚠ **Klíč není člověk, a dvě kola revize tu tuhle záměnu našla dvakrát.**
 * Dřív tady stálo „jeden klíč cizí relaci nezavře nikdy"; to je pravda
 * jedině při čtení „cizí = jiný klíč". Cizímu **člověku** svět zavřít jde:
 * stačí mu do kbelíku podvrhnout jednu relaci s jeho IP a nad plným
 * registrem sáhne tahle funkce po něm (`T16-evictkill`; pinuje to test
 * `nad plným registrem jedna podvržená relace zavře oběti svět`). Drží jen
 * tolik: kbelík, který si útočník nepodvrhne, zůstane vůči němu nedotčený.
 */
function nejdražšíKbelík(keep: string): string | undefined {
  const kandidáti = [...live.keys()].filter((id) => id !== keep);
  if (kandidáti.length === 0) return undefined;

  const velikosti = new Map<string, number>();
  for (const id of kandidáti) {
    const owner = live.get(id)?.owner ?? '';
    velikosti.set(owner, (velikosti.get(owner) ?? 0) + 1);
  }
  const největší = Math.max(...velikosti.values());

  const podleStání = kandidáti
    .filter((id) => velikosti.get(live.get(id)?.owner ?? '') === největší)
    .sort((a, b) => (watched.get(a)?.moved ?? 0) - (watched.get(b)?.moved ?? 0));

  // **Sledovaná relace je poslední oběť, ne nedotknutelná.** Kdyby ji divák
  // vyjímal, byl by to pohodlnější způsob, jak registr přeplnit — stačilo by
  // u každé relace držet jeden proud. Strop platí absolutně; mění se jen
  // pořadí, ve kterém se platí.
  return podleStání.find((id) => live.get(id)?.session.events.watchers === 0) ?? podleStání[0];
}

/** Kolik relací ten klíč právě drží. */
function callerHolds(owner: string): number {
  let held = 0;
  for (const stored of live.values()) if (stored.owner === owner) held += 1;
  return held;
}

/**
 * Zapíše relaci do registru, nebo řekne `false`, že se **nevejde do kvóty**
 * svého volajícího.
 *
 * `false` je jediná odpověď „ne" celého modulu a je to odmítnutí **nováčka**,
 * ne úklid cizí relace; proč zrovna takhle, stojí u `MAX_SESSIONS_PER_CALLER`.
 * Volající to musí přečíst — relace, na kterou vrátí `false`, v registru není
 * a ostatní dveře na ni odpoví 404.
 *
 * Pořadí uvnitř je celé odůvodněné a nedá se prohodit:
 * 1. **Stárnutí**, ještě před kvótou — jinak by volajícího zamklo osm jeho
 *    vlastních relací, které tenhle průchod zrovna pouští.
 * 2. **Kvóta klíče**, před zápisem — odmítá se, takže se nemá co zapisovat.
 * 3. **Strop registru**, až nad zapsanou relací a s ní jako `keep`.
 *
 * `now` je vstřícnost k testům: hodinu nejde odčekat a `Date.now()` se posunout
 * nedá. Provoz ho nepředává.
 */
export function putSession(stored: StoredSession, now: number = Date.now()): boolean {
  assertSessionStorageReady();
  sweepIdle(now);
  if (live.size >= QUOTA_ENGAGES_AT && callerHolds(stored.owner) >= MAX_SESSIONS_PER_CALLER)
    return false;

  const sessionId = stored.session.sessionId;
  // Durable admission never creates a transient 65-record checkpoint or
  // evicts an accepted other owner's record just to accept a new request.
  if(host.__worldstreamSessionDisk&&live.size>=MAX_LIVE_SESSIONS&&!live.has(sessionId))throw new SessionStoreError();
  live.set(sessionId, stored);
  // **Hodina stárnutí začíná nováčkovi běžet tady, ne až při příštím zametení.**
  // `idleFor` na neznámé relaci jen založí záznam a vrátí `false`; kdyby se
  // nezaložil, zůstala by relace mimo `watched` až do dalšího POSTu a
  // `watchedSessionCount()` by nesouhlasil s `live`.
  idleFor(sessionId, stored, now);
  evictOverCap(sessionId);
  host.__worldstreamSessionDisk?.adapter?.bind(stored);
  flushSessionStorage();
  return true;
}

export function getSession(sessionId: string): StoredSession | null {
  assertSessionStorageReady();
  return live.get(sessionId) ?? null;
}

/** Jen pro testy: registr je proces-globální a testy se jinak ovlivňují. */
export function clearSessions(): void {
  live.clear();
  watched.clear();
}

export function liveSessionCount(): number {
  return live.size;
}

/**
 * Kolik relací registr **hlídá na stárnutí**. Jen pro testy.
 *
 * Existuje proto, že `watched` je druhá mapa vedle `live` a druhá mapa je druhé
 * místo, kde může vzniknout přesně ten únik, který `T16-evictworld` zavírá —
 * jen o patro níž a bez jediného viditelného následku. Mutační kontrola
 * 3. 9. 2026 to potvrdila: vynechaný úklid `watched` nezabil ani jeden test.
 */
export function watchedSessionCount(): number {
  return watched.size;
}

/**
 * Uloží preview a udrží jich nejvýš `MAX_PENDING_CHANGES`.
 *
 * Strop je na tom, co se **drží**, ne na tom, kolik se jich smí založit — táž
 * úvaha jako u `evict()` o pár řádků výš. Odmítat nový preview kvůli počtu by
 * z hlídání paměti udělalo odmítnutí služby, a to zrovna u dveří, kterými
 * porotce mění svět.
 */
export function putChange(stored: StoredSession, change: PendingChange): void {
  stored.changes.set(change.changeId, change);
  // Pořadí `Map` je pořadí vložení, takže první je nejstarší.
  for (const oldest of stored.changes.keys()) {
    if (stored.changes.size <= MAX_PENDING_CHANGES) break;
    stored.changes.delete(oldest);
  }
}

/**
 * Podívá se na preview, **aniž ho spotřebuje**.
 *
 * Je to první půlka commitu: route potřebuje plán, aby ho měla proti čemu
 * ověřit, ale spotřebovat ho smí teprve tehdy, když se svět opravdu změní
 * (`takeChange` níž). Do 4. 9. 2026 tenhle rozdíl neexistoval a stálo to
 * jedno placené volání modelu za každé odmítnutí — viz `T22-takeearly`.
 */
export function peekChange(stored: StoredSession, changeId: string): PendingChange | null {
  return stored.changes.get(changeId) ?? null;
}

/**
 * Orazítkuje preview prohraným commitem (`T22-rejectreplay`).
 *
 * Preview se odmítnutím **nespotřebuje** (`takeChange` níž), takže v mapě leží
 * dál a dá se poslat znovu. Razítko je jediné, co o něm pak ještě není známo:
 * nad kterým světem prohrálo. Commit route z něj pozná, jestli je druhý pokus
 * pořád tentýž případ, nebo už rozhodnutí o jiném světě.
 *
 * `Map.set` na existující klíč **nemění pořadí vložení**, takže razítko
 * neposune preview na konec fronty a strop `MAX_PENDING_CHANGES` dál vyhazuje
 * doopravdy nejstarší.
 */
export function markRejected(stored: StoredSession, changeId: string, at: RejectedAt): void {
  const change = stored.changes.get(changeId);
  if (change === undefined) return;
  stored.changes.set(changeId, { ...change, rejectedAt: at });
}

/**
 * Vyzvedne preview **a zároveň ho spotřebuje**.
 *
 * Jedno preview je jeden commit: kdyby šlo commitnout dvakrát, druhý pokus by
 * proběhl proti revizi, kterou zvedl ten první — tedy přesně ten zastaralý
 * commit, který §9.8 zakazuje. Bránu na revize to nenahrazuje, jen jí ubírá
 * jediný případ, u kterého by musela hádat, co se stalo dřív.
 *
 * ⚠ **Volá se až na certifikované cestě, ne při vyzvednutí plánu.** Ta úvaha
 * výš platí jen pro commit, který **prošel**: odmítnutý commit revizi nezvedl
 * a do světa nezapsal ani bajt, takže spotřebovat mu preview znamená jen to,
 * že porotce zaplatí druhé volání modelu za tutéž větu (`T22-takeearly`).
 */
export function takeChange(stored: StoredSession, changeId: string): PendingChange | null {
  const change = stored.changes.get(changeId) ?? null;
  if (change !== null) stored.changes.delete(changeId);
  return change;
}

/* ------------------------------------------------------------------ *
 * Generace.
 * ------------------------------------------------------------------ */

/**
 * Proč generace skončila bez světa — **veřejným slovníkem**.
 *
 * Detail poskytovatele ven nejde nikdy. `fetch` píše do svých hlášek celou
 * adresu koncového bodu a ta umí nést i pověření (`?key=`, `https://user:heslo@…`);
 * naměřilo to review 31. 8. 2026 nad měřidlem T14, kde tatáž věta došla až do
 * commitnutého reportu. Ven jde tedy kód a věta bez čísel a cest, do logu
 * operátora všechno ostatní.
 */
export const SESSION_FAULTS = {
  PLANNER_REJECTED: 'the sentence could not be turned into a plan',
  BLUEPRINT_REJECTED: 'the model could not write a world that holds together',
  MODEL_UNAVAILABLE: 'the model could not be reached',
  /**
   * **Strop odmítl a k poskytovateli se nikdo nepřipojoval** (P15 `T29`).
   *
   * Vlastní věta, ne `MODEL_UNAVAILABLE`, a je to celý smysl toho rozdělení:
   * nedokonfigurovaná kniha stropu (`STORE_UNCONFIGURED`), vyčerpaný rozpočet
   * i rozbitý ovládací soubor končí odmítnutím **před** voláním, takže
   * „the model could not be reached" o nich tvrdí nepravdu a vinu posílá
   * k poskytovateli, který o žádosti neví.
   *
   * **Jedna věta pro všechny příčiny odmítnutí, ne věta na příčinu.** Kolik
   * rozpočtu zbývá a jestli tohle nasazení má sdílené úložiště, jsou stavy
   * serveru; ven jde jen to, že se nevolalo. Rozpad dostane operátor logem
   * (`SpendRefusalError.message` nese `<reason>: <detail>`).
   */
  SPEND_CAP_BLOCKED: 'this deployment is not making model calls right now; nothing was sent',
  BAD_REQUEST: 'the request was built wrong before the model saw it',
  /**
   * Registr relaci pustil, aby se vešly novější (`release()` výš).
   *
   * Není to selhání generace a věta to tak neříká: svět, který vznikl, je
   * pořád ve sdíleném registru pod svou adresou. Skončila jen **relace**.
   * Fáze je přesto `failed`, protože jiná koncová fáze s důvodem neexistuje —
   * a koncová být musí, jinak se proud nedozví, že má skončit.
   */
  SESSION_RELEASED: 'the session was closed to make room for newer ones',
} as const;

export type SessionFault = keyof typeof SESSION_FAULTS;

export interface GenerationDeps {
  /** Only archived fixture callers may opt out of the current planner contract. */
  readonly legacyPlan?: boolean;
  /** Model. Jedno volání, jeden požadavek — strop řeší volající. */
  readonly emit: BlueprintEmitter;
  readonly grammar: Grammar;
  /** Kam se zapisuje to, co ven nesmí. */
  readonly log?: (fault: SessionFault, detail: string) => void;
  /**
   * Cache odpovědí a klíč téhle věty (P16 T6). Chybí-li, model se volá vždy.
   * Klíč počítá volající, protože jen on zná model a úsilí — `emit` je
   * odsud neprůhledná funkce.
   */
  readonly answers?: { readonly cache: AnswerCache; readonly key: string };
}

/** Grammar ze zmrazeného protokolu, nebo věta, proč nejde přečíst. */
export function serverGrammar(): Grammar | string {
  const read = frozenGrammar();
  return read.ok ? read.value : `${read.reason}: ${read.detail}`;
}

/**
 * Věta → záměr → blueprint → commit hrubého světa.
 *
 * **Meshing tu není a nebude** (§21: „meshing nemá route"). Server dojde
 * k blueprintu a tím je hrubý svět hotový — `world.ready` je proto vydané
 * dřív, než kterýkoli tvar existuje, a přesně to po něm chce AC úlohy.
 * Tvary si prohlížeč mele sám a hlásí je do téže relace (T18).
 *
 * Funkce **nevyhazuje**. Běží na pozadí za odpovědí 202, takže odmítnutý slib
 * by skončil jako `unhandledRejection` a relace by zůstala navždy v `accepted`.
 * Každá cesta ven proto končí buď `world.ready`, nebo `session.failed`.
 */
/**
 * Vyhozená hodnota → která z obou vět o nedostupnosti platí.
 *
 * Ptá se `instanceof`, ne na text: `message` odmítnutí je pro operátora a je
 * v něm detail, který se mění. Kontrakt nad řetězcem by se rozpadl beze slova
 * a `tsc` by o tom nevěděl.
 */
function unreachableFault(thrown: unknown): 'SPEND_CAP_BLOCKED' | 'MODEL_UNAVAILABLE' {
  return thrown instanceof SpendRefusalError ? 'SPEND_CAP_BLOCKED' : 'MODEL_UNAVAILABLE';
}

export async function runGeneration(
  stored: StoredSession,
  prompt: string,
  deps: GenerationDeps,
): Promise<void> {
  const { session } = stored;
  const report = deps.log ?? (() => undefined);

  function stop(fault: SessionFault, detail: string): void {
    report(fault, detail);
    stored.fault = SESSION_FAULTS[fault];
    session.fail(SESSION_FAULTS[fault]);
  }

  // **Hmoty ze slov věty jdou do proudu ještě před prvním voláním modelu**
  // (P21 T4). Plánovač odpovídá desítky vteřin a porotce do té doby neviděl
  // nic; tohle je synchronní — žádný `await` nad ním — takže rámec stojí
  // v logu dřív, než klient vůbec otevře proud. Nese vlastní značku
  // (`WORD_MASSING_NOTICE`), a náhled plánovače níž ho do téhož slotu
  // `visual.preview` **nahradí celý**: ze slov nepřežije jediná identita.
  // `null` je věta bez známého podstatného jména; pak se nevydá nic.
  const guessed = wordMassing(prompt, { sessionSeed: session.sessionSeed });
  const rough = guessed === null ? null
    : observePhase(serverPhaseObserver, 'word-massing-preview',
      () => buildMassingPreview(guessed, { sessionSeed: session.sessionSeed, notice: WORD_MASSING_NOTICE }));
  if (rough?.ok) {
    stored.visualPreview = rough.preview;
    session.events.append('visual.preview', { preview: rough.preview, attempt: 0 });
  }

  // **Uložená odpověď na tutéž větu se soudí celá DŘÍV, než se vydá první
  // rámec** (P16 T6). Kdyby se replay rozpadl až u kompilátoru, relace by už
  // stála ve fázi `intent` a živý pokus by neměl kam couvnout — žebřík je
  // monotónní. Zásah proto znamená: obě uložené odpovědi prošly dnešními
  // branami nad seedem téhle relace, a model se nevolá vůbec.
  const replay = deps.answers === undefined ? null
    : await observePhaseAsync(serverPhaseObserver, 'answer-cache-replay', () => replayAnswers(deps.answers!, deps, session.sessionSeed));
  // Co model napsal, kvůli zápisu do cache: první odpověď je plánovač,
  // poslední je kompilátor — a poslední je ta přijatá, protože
  // `compileWithRepair` končí hned na kole, které prošlo.
  const written: unknown[] = [];
  const emit: BlueprintEmitter = async (request) => {
    const answer = await deps.emit(request);
    written.push(answer);
    return answer;
  };

  let plan: PlannerEmission;
  if (replay !== null) plan = replay.plan;
  else {
    let read;
    try {
      const answer = await observePhaseAsync(serverPhaseObserver, 'intent-emitter', () => emit(buildIntentRequest(prompt)));
      read = observePhase(serverPhaseObserver, 'intent-validation', () => readPlannerEmission(answer, { prompt, requireSceneSpec: deps.legacyPlan !== true }));
    } catch (thrown) {
      stop(unreachableFault(thrown), thrown instanceof Error ? thrown.message : String(thrown));
      return;
    }
    if (!read.ok) {
      stop('PLANNER_REJECTED', `${read.reason}: ${read.detail}`);
      return;
    }
    plan = read.value;
  }

  session.advance('intent', {
    setting: plan.intent.setting,
    spatialThesis: plan.intent.spatialThesis,
    heroObjects: plan.intent.heroObjects,
    unsupported: plan.intent.unsupported,
    ...(plan.sceneSpec ? { sceneSpec: plan.sceneSpec } : {}),
  });

  // This is derived from this request's validated identities and relations,
  // never a prepared scene or an accepted runtime. Unsupported plans skip it.
  if (deps.legacyPlan !== true && session.phase === 'intent') {
    const early = observePhase(serverPhaseObserver, 'intent-layout-preview',
      () => buildIntentPreview(plan, { sessionSeed: session.sessionSeed }));
    // **Odmítnutí přísného náhledu nesmí znamenat prázdnou obrazovku.**
    // Naměřeno nad osmnácti plány série T18: tímhle profilem projde jeden
    // (`intent-preview.ts`). Zbylých sedmnáct porotců do příchodu blueprintu
    // nevidělo nic — proto sem jde hrubý hmotový model, který relace nečte
    // a nemá tedy co odmítnout. Že je hrubý, nese sám náhled
    // (`MASSING_PREVIEW_NOTICE`), ne tenhle rámec: přes snapshot §21 jde
    // jedině `visualPreview`, takže pole na payloadu by reconnect nepřežilo.
    const rough = early.ok ? null : observePhase(serverPhaseObserver, 'intent-massing-preview',
      () => buildMassingPreview(plan, { sessionSeed: session.sessionSeed }));
    const preview = early.ok ? early.preview : rough?.ok ? rough.preview : null;
    if (preview) {
      stored.visualPreview = preview;
      session.events.append('visual.preview', { preview, attempt: 0 });
    }
  }

  // Zásah už zkompilovaný blueprint nese; jinak se platí za kompilátor teď.
  const outcome = replay?.outcome ?? await compileWithRepair({
    observePhase: serverPhaseObserver,
    plan,
    grammar: deps.grammar,
    sessionSeed: session.sessionSeed,
    emit,
    onVisualPreview: (preview, attempt) => {
      if (session.phase !== 'intent') return;
      stored.visualPreview = preview;
      session.events.append('visual.preview', { preview, attempt });
    },
  });

  if (outcome.kind !== 'compiled') {
    const detail =
      outcome.kind === 'unavailable' || outcome.kind === 'invalidInput'
        ? outcome.detail
        : `${outcome.fault.reason}: ${outcome.fault.detail}`;
    stop(
      outcome.kind === 'unavailable'
        ? unreachableFault(outcome.cause)
        : outcome.kind === 'invalidInput'
          ? 'BAD_REQUEST'
          : 'BLUEPRINT_REJECTED',
      detail,
    );
    return;
  }

  const blueprint = outcome.result.value;
  stored.visualPreview = null;
  stored.blueprint = blueprint;

  // **Do cache jde jedině dvojice, která právě prošla oběma branami.** Zásah
  // se nepřepisuje (má tytéž odpovědi) a neúspěch sem nedojde vůbec — každá
  // cesta ven výš končí `stop()`. Zápis nikdy nevyhazuje (`answer-cache.ts`).
  if (replay === null && deps.answers !== undefined)
    await deps.answers.cache.write(deps.answers.key, { sentence: prompt, planner: written[0], compiler: written[written.length - 1] });
  stored.reused = replay === null ? null : { at: new Date().toISOString(), savedCalls: 2 };

  // **Blueprint jde celý jedním rámcem, `world.ready` je pak jen povel.**
  // Klient, který se připojí až po něm, si ho vezme ze snapshotu (§21) — proto
  // je autoritativní snapshot, ne rámec, a proto se blueprint neposílá dvakrát.
  // Zásah cache jede v témž rámci: klient ho čte s blueprintem, ne o rámec
  // později, a nepotřebuje kvůli němu snapshot.
  session.advance('blueprint', { blueprint, rounds: outcome.rounds.length, ...(stored.reused ? { reused: stored.reused } : {}) });
  session.registerBlueprint(blueprint);
  // **Hotový svět dostane adresu, která přežije relaci** (T30, §22.4). Relace
  // je živá věc — vypadne z registru, skončí s procesem, stojí slot. Sdílený
  // svět je záznam, který se dá číst i ve chvíli, kdy je model vypnutý.
  //
  // Adresu spočítá server z obsahu, takže ji jako první zná jedině prohlížeč
  // téhle relace; §24 („běžná relace se automaticky nestává galerií") je tím
  // splněné rozdílem mezi *adresovatelný* a *vypsaný* — výpis neexistuje.
  stored.sharedWorld = shareWorld(blueprint, Date.now());

  session.advance('world', {
    title: blueprint.title,
    objects: blueprint.objects.length,
    shapes: blueprint.shapes.length,
  });
}

/**
 * Uložené odpovědi na tutéž větu, prohnané dnešními branami — nebo `null`.
 *
 * `null` je jeden případ se třemi příčinami a všechny znamenají „jeď živě":
 * klíč v cache není, záznam je poškozený (to už přeložila cache sama), nebo
 * uložená odpověď branou dnešního buildu neprojde. Ten třetí případ je
 * skutečný, ne teoretický: `PROMPT_VERSION` se hne s promptem, validace
 * blueprintu se hýbe i bez něj. Miss tu stojí jedno zaplacené volání navíc;
 * zásah, který by porotci vydal `BLUEPRINT_REJECTED` nad větou, která včera
 * fungovala, by stál důvěru.
 *
 * Kompilátor běží s `maxRounds: 1` a emitorem, který vrací uložené kolo:
 * opravné kolo by bylo placené volání a tady se neplatí nic.
 *
 * **Plán se soudí proti uložené větě, ne proti `prompt` téhle relace.**
 * Klíč větu normalizuje, ale `readSceneSpec` chce `requested` citaci jako
 * doslovný substring — proti nové větě by `A Table` / `a table` prošlo
 * klíčem a padlo tady, tedy dvě zaplacená volání pod cache, která tvrdí,
 * že šetří (revize nad `7a3808f`). Model odpovídal na uloženou větu.
 */
async function replayAnswers(
  answers: NonNullable<GenerationDeps['answers']>,
  deps: GenerationDeps,
  sessionSeed: number,
): Promise<{ readonly plan: PlannerEmission; readonly outcome: Extract<BlueprintOutcome, { kind: 'compiled' }> } | null> {
  const cached: CachedAnswer | null = await answers.cache.read(answers.key);
  if (cached === null) return null;
  const read = readPlannerEmission(cached.planner, { prompt: cached.sentence, requireSceneSpec: deps.legacyPlan !== true });
  if (!read.ok) return null;
  const outcome = await compileWithRepair({
    plan: read.value,
    grammar: deps.grammar,
    sessionSeed,
    emit: () => Promise.resolve(cached.compiler),
    maxRounds: 1,
  });
  return outcome.kind === 'compiled' ? { plan: read.value, outcome } : null;
}

/**
 * Relace se `sessionSeed`, které píše **systém**.
 *
 * `blueprintSchema` chce kladné 32bitové celé číslo, aby se v Node a
 * v prohlížeči nezaokrouhlilo jinak. `Math.random` tu **není na replay cestě**
 * — semínko je vstup relace, ne krok simulace; jakmile vznikne, je konstantní
 * a celý zbytek světa je z něj deterministický.
 */
export function newSessionSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 2_147_483_647);
}

/**
 * Založí relaci a zapíše ji do registru — nebo vrátí `null`, když je volající
 * nad svou kvótou (`MAX_SESSIONS_PER_CALLER`).
 *
 * `null` je jediná cesta, kterou tenhle modul někoho odmítne, a route z něj
 * dělá 429. Relace v tom případě **nevznikne**: nic se nezapsalo, nikomu
 * cizímu se nic nezavřelo.
 */
export function openSession(
  sessionId: string,
  sessionSeed: number,
  now: number = Date.now(),
  /**
   * Klíč volajícího. **Výchozí hodnota je `sessionId`, tedy vlastní kbelík.**
   *
   * Nepřipsat vlastníka znamená „tuhle relaci neumím nikomu přiřadit", a
   * seskupit neurčené relace do jednoho kbelíku by z toho kbelíku udělalo
   * jedinou kvótu pro všechny. Vlastní kbelík je proto konzervativní čtení,
   * ne vypnutá kvóta.
   *
   * Provoz sem posílá `trustedCallerKey(request) ?? UNIDENTIFIED_CALLER`
   * (`sessions/route.ts`), **ne `callerKey(request)`** — to je klíč stropu
   * frekvence a do kvóty nepatří; proč se ty dvě funkce liší, stojí u nich
   * v `src/server/rate-limit.ts`. Pinuje to route test; výchozí hodnotu má
   * jedině sada, která relaci zakládá přímo.
   */
  owner: string = sessionId,
): StoredSession | null {
  const stored: StoredSession = {
    session: createSession({ sessionId, sessionSeed }),
    // ⚠ **Nerozeznaný volající dostane vlastní kbelík, ne společný** — druhý
    // blokující nález šesté nezávislé revize 4. 9. 2026. Bez proxy hlaviček
    // (`next start`, demo z notebooku, prostý reverse proxy) vrací `callerKey()`
    // sentinel **všem**, takže jeden kbelík byl celá instance a strop registru
    // klesl ze 64 na 8. Naměřeno přes skutečnou route: 12 návštěvníků →
    // `live = 8`. Na Vercelu totéž na sdílené odchozí IP: devět porotců za
    // jednou firemní NATkou.
    //
    // **V jednom kbelíku není koho od koho izolovat**, takže tam kvóta
    // nekupuje nic a zbývá jediná mez, která tam něco znamená — strop registru.
    // Je to táž úvaha a týž sentinel jako u stropu souběžných čtení těla
    // v `src/http/body.ts`, jen tam vede na vlastní číslo a tady na „bez kvóty".
    //
    // ⚠ **Řekni to nahlas, protože to zní jinak, než to je** — nález sedmé
    // nezávislé revize, `VERDICT: blocking`. Kbelík na `sessionId` znamená
    // jeden kbelík na **relaci**, ne na volajícího, takže na nasazení bez
    // proxy hlaviček je `MAX_SESSIONS_PER_CALLER` **vypnutá úplně** a jeden
    // volající tam smí držet všech 64 slotů. Sonda revize to naměřila přesně
    // tak. Nikde — v commitu, v reportu ani v přihlášce — se proto nesmí psát,
    // že „nerozeznaný volající dostane svůj kbelík" ve smyslu meze; dostane
    // ho ve smyslu **izolace**, a mez tam nedrží žádná kromě stropu registru.
    // Vercel obě hlavičky posílá, takže na nasazené cestě kvóta platí; týká se
    // to `next start`, dema z notebooku a prosté reverse proxy.
    owner: owner === UNIDENTIFIED_CALLER ? sessionId : owner,
    blueprint: null,
    authoredWorldId: null,
    fault: null,
    sharedWorld: null,
    reused: null,
    changes: new Map(),
  };
  return putSession(stored, now) ? stored : null;
}
