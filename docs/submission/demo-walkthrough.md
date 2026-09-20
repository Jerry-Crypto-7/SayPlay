# Lokální demo — aktuální P20 předání

Stav 17. 9. 2026: hotový místní [90sekundový živý A4 záznam](../../videos/worldstream-a4/worldstream-a4-live.mp4), [původ a kontrola](../../videos/worldstream-a4/README.md). Veřejné odevzdání, veřejný provoz ani lidské přijetí se tím neprohlašují za dokončené.

1. Spusť produkční build (`npm run build`, `npm run start`) v prostředí s již autorizovaným a nakonfigurovaným modelovým transportem a spend controls. Samotný start aplikace živou službu nekonfiguruje. Nepoužívej starý subscription postup níže jako aktuální návod na přihlášení.
2. Na hlavní stránce nech **Generate my world** a zadej vlastní scénu. Pro zaznamenanou ukázku bylo zadání: `A small reading room with one glass aquarium, two seated people facing the aquarium, and a computer terminal that switches on a signal light.` Žádný ruční náhradní svět ani automatický prepared fallback.
3. Vyčkej na přijatý ovladatelný svět. Prozatímní layout či vizuální preview jsou označené a neinteraktivní. Chybu generace zachovej jako chybu, ne jako úspěšný preview. V zaznamenaném jednom běhu trvala generace 258,445 s; není to p95 ani splněný cíl latence.
4. Vyber skutečnou dostupnou akci terminálu, proveď ji a použij **Before my last action**. Pokud nový svět vhodnou akci neposkytuje, tento scénář na něj nepřenášej pomocí fixture nebo vloženého pravidla.
5. Navrhni změnu pouze existující akce: `Change the computer terminal so its activate action switches the existing signalOn signal off instead of on. Change only that one action; preserve all other rules and objects.` Ověř skutečný název signálu a cíle daného světa. Přečti náhled, při nejednoznačnosti zvol nabídnutý cíl, poté potvrď.
6. Porovnej obě budoucnosti ve stejném čase a ze stejné kamery. Desktop ukazuje oba pohledy, mobil je přepíná. Zaznamenaná ukázka má obě větve `won`, ale světlo vlevo svítí a vpravo je zhasnuté. Commit je `comparison-only`, `certificate:null`; nejde o nové vítězné osvědčení změněné větve.
7. Volba návratu k původním pravidlům přijme novou revizi a umožní další návrh bez regenerace geometrie. Reload stránky neobnoví lokální návštěvnickou historii.

Celá následná A4 cesta v jediném záznamu trvala 8,555 s. [Raw video, požadavky, výsledky a snímky](../../plans/P20/live-browser-v3-20260917-1825/README.md) jsou automatizovaný produkční browser průchod, nikoli lidská studie. Při natáčení běžely i další práce; čas není izolovaný benchmark.

**Prepared demo** lze zvolit výslovně pro místní ukázku bez živé generace. Označení původu zůstává viditelné i u přesné shody. Omezené authored změny nejsou důkazem obecné editace; odmítnutí je platný výsledek. Reference `/dev/reference-scenes` slouží ke kalibraci rendereru.

Podrobnosti: [aktuální runbook](../demo/judge-runbook.md), [stav projektu](../../PROJECT-STATUS.md).

---

<details>
<summary>Historický source/timer walkthrough z 10. 9. — neaktuální provozní návod</summary>

Níže zachované údaje o dispatcheru, chybějícím videu a tehdejších omezeních platí pouze pro tehdejší verzi. Nenahrazují současný postup výše.

# Lokální demo — průvodce předáním

**P20 aktualizace 17. 9. 2026:** aktuální produktový průchod je v [judge runbooku](../demo/judge-runbook.md). Hlavní stránka podporuje nečasovačovou změnu a dva současné synchronní pohledy. Produkční fixture test není živá modelová generace ani lidská studie. Nový živý hybridní blueprint a veškerá odmítnutí se archivují v `plans/P20`; viz [stav](../../PROJECT-STATUS.md). Níže je historický source/timer postup z 10. 9., nikoli aktuální přejímací scénář P20. Finální video zůstává MISSING.

Aktuálně 10. 9. 2026: `npm run demo:subscription` odmítá před loginem/spawn chybou `SUBSCRIPTION_PRODUCTION_NOT_VALIDATED`. Následující scénář je připravený postup pro budoucí validovaný dispatcher, nikoli dnes ověřená živá cesta. Credential-free CLI metadata, authored OS fixture a připravené browserové průchody nedokládají autentizovanou inferenci. Finální živé video zůstává MISSING; [stav předání](../../evals/reality-compiler/submission-readiness.md) rozlišuje konkrétní důkazy.

1. Spusť `npm run demo:subscription`; používej otevřené řízené Chromium a panel Build from a source.
2. Ukaž původ fiktivního podkladu a jeho text. Spusť skutečnou generaci. Čekání nezaměňuj za připravenou scénu; historická série měla medián vytvoření 126,22 s a p95 180,43 s. Čas konkrétního nového záznamu odečti z jeho journalu.
3. Před přijetím zkontroluj všech sedm skupin parametrů: trigger a počáteční stav, dosah, dobu a jednotky timeru, expiraci, reset/opakování a pořadí souběhu. Chybějící či konfliktní podmínku doplň v samostatném uživatelském doplnění a znovu vygeneruj návrh; potvrzení starého návrhu se zneplatní. Potvrzení je lidský krok, ne automatická sémantická certifikace. Až poté spusť scénář.
4. Po přijetí aktivuj senzor A návštěvníkem, použij moveTo k approachB a aktivuj B po příchodu, před vypršením původních 20 s. Pro rozdíl větví musí B nastat po 10 s od A.
5. Otevři Why? a vyber pravidlo, které se skutečně spustilo. Ukaž jeho citaci a stav unchecked. Odliš původní zdroj, uživatelské doplnění a experimentální zásah; citace sama není sémantické schválení.
6. V Experiment with a future timer vyber pravidlo spouštějící countdown, změň dobu na 200 tiků, fork 0 a horizont po aktivaci B. Potvrď zdůvodněný experiment. Zkontroluj původní odemčení bez alarmu a změněnou zamčenou vitrínu s alarmem.
7. Ukaž stejný vstupní log a horizont obou větví, nezměněný původní zdroj a odlišný experimentální předpoklad. Návrat k originálu není serverový rollback.
8. Pro odmítnutí použij budoucí fork mimo dostupný záznam; ověř, že přijatý svět zůstane stejný. Volitelně předveď Save/Restore obou větví v tomto browseru. Nevyvozuj z této kontroly podporu libovolné editace ani přenos ordinary session přes restart serveru.

Automatizovaný viditelný vývojový průchod:

```powershell
$env:RC_DEMO_GUIDED='1'
npm run demo:subscription
Remove-Item Env:RC_DEMO_GUIDED
```

Průvodce čeká na skutečné ruční potvrzení parametrů. Marker `GUIDED_DEMO_VERIFIED` znamená úspěšné vývojové browserové kontroly. Není výsledkem testu člověka ani holdoutu. Archivy všech pokusů jsou pod `scratch/subscription-demo/`.

## Scénář krátkého videa

0–15 s: vlastní zdroj, fikce a deklarovaný rozsah. 15–35 s: spuštění generace; při střihu výslovně uvést „waiting shortened“ a skutečný čas konkrétního záznamu. 35–50 s: lidská kontrola a potvrzení parametrů, oddělené od latence modelu. 50–80 s: pohyb, aktivace a Why? 80–110 s: timer experiment a obě větve. 110–130 s: odmítnutí, známé limity a cesta k reprodukci.

Finální video dosud není natočené. Tento scénář ani screenshot se nesmějí vydávat za `video/final.mp4`. Záložní připravený průchod musí být označen prepared; neprokazuje čerstvou generaci.

Připravený záznam skutečného UI je nyní dostupný v [prepared-walkthrough.mp4](../../video/prepared-walkthrough.mp4): 45,32 s bez střihu, trvale označený scripted/virtual clock/0 model calls. [Manifest a evidence](../../evals/reality-compiler/prepared-video.md) oddělují tento technický průchod od živé generace a lidské studie.

</details>
