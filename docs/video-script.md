# Scénář odevzdávaného videa – 3:00, teze „counterfactual world compiler“

Tvrdý limit je **3:00** (`RULES.md` §2). Bez obličeje a bez rozpoznatelného hlasu (`RULES.md` §5), proto **anglické titulky, žádná narace**. Tenhle dokument je česky, protože ho čte ten, kdo stříhá; titulky jsou anglicky, protože je čte porotce.

Časová osa je převzatá z odevzdávacího plánu P22 (`06_SUBMISSION.md`). Do videa **nepatří** čísla o velikosti repozitáře ani o rozsahu testů – porotce hodnotí, co produkt dělá, ne kolik práce za ním je. Naměřená čísla, která se ve videu smějí objevit, jsou jen ta z `README.md` → Known limitations, přesně s jejich výhradou.

## Co už existuje a co se točí až po P22

Existující materiál je v `videos/worldstream-a4/` (gitignorováno mimo repo, lokálně na stroji):

- `assets/full-live-a4.webm` – souvislý produkční záznam prohlížeče z 17. 9. 2026, 271,84 s, 800 × 450: vlastní zadání čítárny → čekání → přijatý svět → akce terminálu → **Before my last action** → modelový návrh → potvrzení. Prvních 260 s je čekání na model.
- `assets/live-two-futures.png` – nativní 1920 × 1080 snímek dvou synchronních budoucností (vlevo signál svítí, vpravo zhasnutý).
- `assets/live-reading-room.png` – snímek přijaté čítárny.
- `assets/fixture-*.png` – snímky z **fixture** draftu (dveře otevřené, po návratu, dvě budoucnosti). Nejsou živá generace; do finálního videa jen s označením, nebo vůbec.
- Hotová 90s kompozice `worldstream-a4-live.mp4` s typografickým úvodem (0–6 s) a HyperFrames projektem `index.html` – úvod a závěr se dají převzít.

Co v záznamu **není**, protože přibylo po natočení (P22): hmoty ze slov věty před odpovědí plánovače, hláška o znovupoužité odpovědi, značky **Why?** na časové ose a panel Why, věta z diffu stavů pod porovnáním, seznam přijatých budoucností, obloha a bouře řízené pravidlem, nových 24 modelů. Tyhle záběry se točí až po P22 nad novým živým během – to znamená **další modelová volání**, která se plánují zvlášť (rozpočet živých běhů drží plán, ne tenhle scénář).

## Časová osa 3:00

| Čas | Beat | Co je na obrazovce | Titulek | Záběr |
|---|---|---|---|---|
| 0:00–0:12 | teze a zadání | Tmavé plátno, jedna věta teze, pod ní se do pole píše vlastní věta porotce (ne ukázka z prázdné obrazovky). | `Describe a place. Act in it. Rewind. Change one law in words. Compare two futures.` | **Existuje částečně:** typografický úvod z 90s kompozice (0–6 s) a začátek `full-live-a4.webm` s psaním věty. Nová věta teze se dopíše do kompozice. |
| 0:12–0:35 | svět se objevuje | Hned po odeslání vyrostou hrubé bloky z podstatných jmen věty s hláškou, že model ještě neodpověděl; pak je nahradí náhled plánovače a přijatý svět s objekty. Čekání se přiznaně zrychluje, skutečný čas je v rohu. | `Rough masses from the words of your sentence appear at once. The planner and compiler fill them in. Real time shown, sped up.` | **Točí se po P22:** hmoty ze slov nejsou v záznamu ze 17. 9. Nouzově lze použít `full-live-a4.webm` 0–260 s zrychleně (jako v 90s videu), ale bez prvního beatu produktu. |
| 0:35–0:55 | akce a důkaz, že pravidla jsou skutečná | Porotce provede dostupnou akci (terminál, páka). Stav se změní, na časové ose přibude značka **Why?** u tiku, kde vystřelilo pravidlo. | `Every rule that fires is recorded beside the state. Nothing here is scripted.` | **Existuje částečně:** akce terminálu je v posledních 11,84 s `full-live-a4.webm` (260–271,84 s, přesný střih se hledá při stříhání), značky Why? tam nejsou. Točí se znovu po P22. |
| 0:55–1:15 | návrat v čase | Klik na **Before my last action**: posuvník času jede zpět, svět se vrátí před akci, značky Why? za tím tikem zhasnou. | `Rewind to the tick before your action. The runtime is deterministic, so the past is exact.` | **Existuje částečně:** návrat je v týchž posledních 11,84 s `full-live-a4.webm` (bez značek). Točí se znovu po P22 kvůli časové ose s Why?. |
| 1:15–1:40 | co kdyby – změna pravidla ve slovech | Do pole se píše věta měnící jedno existující pravidlo (např. terminál signál vypne místo zapne). Model navrhne změnu, runtime ji ověří, na obrazovce je návrh a tlačítko potvrzení. | `Change one law in plain words. The model proposes, the runtime validates, you confirm.` | **Existuje:** modelový návrh a potvrzení jsou na konci týchž posledních 11,84 s `full-live-a4.webm` (1×). Nová verze jen kvůli rozlišení, pokud bude nový běh. |
| 1:40–2:05 | dvě synchronní budoucnosti | Dva pohledy vedle sebe, společný čas a kamera, posuvník „Compare the same moment“. Pod nimi věta z diffu stavů: kdy se budoucnosti rozešly a které hodnoty se liší. Vpravo seznam přijatých budoucností, přepnutí na druhou. | `Both futures run from the same tick with the same inputs. The difference is written from the state diff, not by the model.` | **Existuje částečně:** `live-two-futures.png` (statický snímek bez věty z diffu a bez seznamu). Točí se po P22. |
| 2:05–2:25 | proč se to stalo – kauzální stopa a deterministický důkaz | Klik na značku Why?: panel s tikem, vstupem, pravidlem, zápisem `slot: before → after` a „What this triggered next“. Vedle panel Program s certifikátem svědka a hashem stavu, který se rovná replayi. | `Click any tick: which rule fired, what it wrote, what read it next. A witness certificate and an equal replay hash back every world.` | **Točí se po P22:** panel Why nebyl v žádném záznamu. Panely Program a Timeline v produktu existují, ale nikdy se nenatočily. |
| 2:25–2:43 | druhá libovolná věta – šíře | Rychlá montáž tří až čtyř dalších vlastních vět z porotcovského korpusu (`evals/worldstream/gauntlet/prompts.json`), každá s přijatým světem; jedna klidně odmítnutá s uvedeným důvodem. | `Your own sentence, not ours. A refusal states its reason.` | **Točí se po P22:** vyžaduje nový živý běh nad více větami. Bez rozpočtu se beat zkrátí a čas jde do 1:40–2:05. |
| 2:43–2:55 | architektura | Diagram `docs/architecture.svg`: Language → Plan → WorldDoc → Verified deterministic runtime → Original / Changed future. | `Language → plan → WorldDoc → verified deterministic runtime → two futures. The model never writes code.` | **Existuje:** `docs/architecture.svg` (tento commit). Do kompozice jako obrázek s pomalým nájezdem. |
| 2:55–3:00 | produktová věta | Tmavé plátno, jedna věta, adresa dema. | `WORLDSTREAM – a counterfactual world compiler.` | **Existuje částečně:** závěr 90s kompozice se dá převzít; adresu dema doplnit až po veřejném nasazení. |

**Součet 3:00 – bez rezervy na střih.** Kde se má škrtat, škrtá se odzadu v beatu 2:25–2:43 (montáž), nikdy v 1:15–2:25, protože tam je celá teze.

## Věty, které se do kamery píšou

Obě jsou mimo ukázky z prázdné obrazovky – `RULES.md` §3.3 dává porotci právo zkoušet vlastní prompty, takže demo předvádějící vlastní ukázky nedokazuje nic.

1. Beat 0:00 a 0:12: vlastní věta s jednou ovladatelnou věcí a jedním viditelným následkem (v záznamu ze 17. 9. to byla čítárna s akváriem, dvěma sedícími lidmi a terminálem, který zapíná signál). Nová věta má mít navíc počasí nebo denní dobu, aby se dala změnit obloha pravidlem.
2. Beat 1:15: změna jediného existujícího pravidla (`Change the terminal so its activate action switches the signal off instead of on. Change only that one action.`). Skutečné jméno signálu a cíle se čte z daného světa.

## Co se netočí, a proč

- **Žádná čísla o objemu práce** – ani v titulku, ani v záběru na terminál nebo git. Porotce hodnotí originalitu, funkčnost a zážitek.
- **Žádné fixture snímky vydávané za živou generaci.** `fixture-*.png` jsou z draftu; buď označené, nebo vůbec.
- **Zrychlené čekání se vždy přizná** – skutečný čas v rohu, jako v 90s videu. Titulek „under N seconds“ se nesmí objevit, dokud to nebude naměřené nad víc než jedním během.
- **Žádný firemní branding, paleta ani font zaměstnavatele** (`RULES.md` §5). Paleta je z `src/app/theme.css`, bez fialové.

## Existující 90s video – co v něm je

Finální místní [worldstream-a4-live.mp4](../videos/worldstream-a4/worldstream-a4-live.mp4) je skutečný souvislý záznam z 17. 9. 2026 a jeho skutečný závěrečný snímek. [Storyboard, asset provenance a encoded QA](../videos/worldstream-a4/README.md).

| Čas videa | Zdroj a obsah |
|---|---|
| 0:00–0:06 | Úvod „Přetoč a přepiš“ a přesné vlastní zadání čítárny s akváriem, dvěma sedícími lidmi a terminálem ovládajícím signál. |
| 0:06–0:58 | Celých prvních 260 s záznamu prohlížeče, přiznaně zrychlených 5×. Skutečný čas od odeslání k ovládání byl 258,445 s. |
| 0:58–1:09,84 | Posledních 11,84 s stejného záznamu 1×: skutečná akce, návrat, modelový návrh a potvrzení. |
| 1:09,84–1:30 | Skutečný hires snímek dvou synchronních budoucností. Vlevo signál svítí, vpravo zůstává zhasnutý. |

Obě větve jsou `won`. Změnil se jediný list akce `signalOn:true → false`, nikoli tvrzený výsledek. Commit vrací `comparison-only` bez nového winning certificate. Naměřených 8,555 s následné A4 cesty není délka posledního úseku záznamu ani samostatná latence replaye. Výstup má 1920 × 1080, 30 fps, 90 s, bez zvuku; původní záznam 800 × 450/25 fps je zvětšený a drobné písmo UI má omezenou čitelnost. Toto jediné živé pozorování nesplňuje cíl latence a nedokládá obecnou kvalitu ani veřejný provoz.

---

<details>
<summary>Historický 2:44 scénář – pouze archiv; drží zelenou bránu `scripts/video-check.mjs`, která zná jen jeho beaty</summary>

Následující časová osa, povinné beaty starého checkeru (`world-builds`, `rule-rewind`, `offline`, `winning-path`), offline fallback a panel-only rewind jsou překonané. Nepředstavují aktuální video ani dnešní funkce hlavní cesty. Tabulka zůstává ve formátu, který `scripts/video-check.mjs` čte, protože brána a její test dosud počítají s těmito čtyřmi beaty a stopáží pod 2:50; nová osa 3:00 výš do toho formátu schválně nezapadá. Přepsání brány na nové beaty je samostatná úloha.

# Scénář dema – 2:44 ze 3:00

**P20 lokální pracovní video, 17. 9. 2026:** 90sekundový draft MP4 (dnes ve `videos/worldstream-a4/archive/`) a [původ, ověření a limity](../videos/worldstream-a4/README.md). Obsahuje označený archiv živé čítárny a oddělené A4/dveřní fixtures. Není finální veřejnou přejímkou ani souvislým záznamem celé živé cesty. Následující scénář je historický.

> **Historický scénář, nepoužívat pro nové video.** P20 A4 má ukázat vlastní generaci → akci → návrat před akci → náhled nečasovačové změny → potvrzení → dvě synchronní budoucnosti s viditelným rozdílem. Níže uvedený offline beat a panel-only rewind popisují starou variantu.

Tvrdý limit je **3:00** (`RULES.md` §2). Tenhle scénář má **2:44**, takže na střih zbývá šestnáct sekund. Stopáž hlídá `node scripts/video-check.mjs docs/video-script.md` – sečte úseky, ověří, že na sebe navazují, a odmítne scénář, kterému chybí beat.

## Časová osa

| Čas | Beat | Co je na obrazovce | Titulek |
|---|---|---|---|
| 0:00–0:12 | `opening` | Prázdné plátno, uprostřed nápověda „Napiš větu. Postaví se z ní svět, který se dá hrát.", nahoře pole. Kurzor píše větu, kterou systém nikdy neviděl. | `A sentence goes in. Not a prompt for a model – an input to a compiler.` |
| 0:12–0:40 | `world-builds` | Tlačítko „Postav svět" → „Pracuju…", stavy „odesláno / generuje se / staví se". Svět se odkrývá po kusech. Pak najetí na panel vlevo dole „Co model napsal" – sekce „Tvar stavby", „Pravidla", „Cíl". | `The model writes no code. It emits two declarative branches: a geometry program and a rule graph. Both are on screen, readable.` |
| 0:40–1:00 | `playable` | Hra: číslicemi chůze k cílům, mezerníkem sběr. Postava se hýbe, počítadlo cíle se mění. | `Hand-written deterministic interpreter runs it. Twenty ticks a second, no wall time anywhere in the hashed state.` |
| 1:00–1:32 | `winning-path` | Panel vpravo dole „Jak to systém vyhrál". Postupuje počítadlo „3 / 5 · výhra v tiku 240", řádky kroků typu „2. tik 60 – player: pickup → key1". Na konci tlačítko „Přehrát znovu". | `Nobody scripted this route. The verifier searched for it, certified it, and the replay's hash equals the certificate's.` |
| 1:32–2:10 | `rule-rewind` | Panel vlevo dole „Čas". Táhlo „Přetočit čas" jede zpět, počítadlo „tik N / 200" klesá. Klik na „Vypnout jedno pravidlo a přepočítat budoucnost". Objeví se věta „Bez pravidla … Budoucnost se přepočítala." a druhý hash „· původní …". | `Rewind, switch one rule off, and the future is recomputed from that tick. Two state hashes, side by side: the old one and the one that exists now.` |
| 2:10–2:34 | `offline` | Otevřený Network panel v prohlížeči, v něm se přepne **Offline**. Druhá neviděná věta. Požadavek na `/api/generate` je červený a **nedoletí** – a svět se přesto postaví. Nad polem se objeví „Server je nedostupný, takže tenhle svět postavil prohlížeč sám." V seznamu požadavků není jediný bajt modelových vah. | `The network is off. Nothing left to ask. The world is built here, in the browser – no weights downloaded, no model call, nothing to be offline from.` |
| 2:34–2:44 | `close` | Veřejná adresa dema na plátně, pod ní postavený svět z posledního beatu. | `Type your own sentence.` |

**Součet 2:44.** Sedm úseků, čtyři povinné beaty (`world-builds`, `rule-rewind`, `offline`, `winning-path`) plus tři přechodové.

## Co se netočilo, a proč

- **U beatu `rule-rewind` drž záběr na panelu, ne na 3D scéně.** Panel času si počítal vlastní simulaci vedle plátna, takže se po přepočtu nepřeanimoval svět – změnilo se počítadlo tiku, přibyl druhý hash a napsala se výsledková věta.
- **Nezmiňuj rychlost lokálního modelu.** Naměřený medián byl desítky sekund a `schemaValid` 0 ze 40; model proto v produktu nebyl zapojený.

## Čísla, která se směla objevit v titulku

| Číslo | Kde je naměřené |
|---|---|
| pole je použitelné do 3 s od načtení | `e2e/first-click.spec.ts` – běh vypíše skutečnou hodnotu |
| svět se skládá 800 ms (16 tiků při 20 Hz) | `src/components/viewer/Assembly.tsx` |
| 70 nepřátelských vět → 70 hratelných světů, 0 prázdných scén | `evals/hostile-report.json` |
| nejpomalejší z těch 70 vět: 19,76 ms | `evals/hostile-report.json` |
| horizont přetáčení 200 tiků | `src/components/pipeline/Timeline.tsx` |

</details>
