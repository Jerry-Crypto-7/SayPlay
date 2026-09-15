# Lokální demo — průvodce předáním

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
