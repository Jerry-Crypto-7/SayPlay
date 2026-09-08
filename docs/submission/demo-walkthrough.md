# Lokální demo — průvodce předáním

1. Spusť `npm run demo:subscription`; používej otevřené řízené Chromium a panel Build from a source.
2. Ukaž původ fiktivního podkladu a jeho text. Spusť skutečnou generaci. Čekání nezaměňuj za připravenou scénu; dva vývojové modelové časy byly 85,5 a 93,6 s.
3. Po přijetí aktivuj senzor A návštěvníkem, použij moveTo k approachB a aktivuj B po příchodu, před vypršením původních 20 s. Pro rozdíl větví musí B nastat po 10 s od A.
4. Otevři Why? a vyber pravidlo, které se skutečně spustilo. Ukaž jeho citaci a stav unchecked. Citace sama není sémantické schválení.
5. V Experiment with a future timer vyber pravidlo spouštějící countdown, změň dobu na 200 tiků, fork 0 a horizont po aktivaci B. Potvrď zdůvodněný experiment. Zkontroluj původní odemčení bez alarmu a změněnou zamčenou vitrínu s alarmem.
6. Ukaž stejný vstupní log a horizont obou větví, nezměněný původní zdroj a odlišný experimentální předpoklad. Návrat k originálu není serverový rollback.
7. Pro odmítnutí použij budoucí fork mimo dostupný záznam; ověř, že přijatý svět zůstane stejný. Nevyvozuj z této jedné kontroly podporu libovolné editace.

Automatizovaný viditelný vývojový průchod:

```powershell
$env:RC_DEMO_GUIDED='1'
npm run demo:subscription
Remove-Item Env:RC_DEMO_GUIDED
```

Marker `GUIDED_DEMO_VERIFIED` znamená úspěšné vývojové browserové kontroly. Není výsledkem testu člověka ani holdoutu. Archivy všech pokusů jsou pod `scratch/subscription-demo/`.

## Scénář krátkého videa

0–15 s: vlastní zdroj, fikce a deklarovaný rozsah. 15–35 s: spuštění generace; při střihu výslovně uvést „waiting shortened“ a skutečný čas konkrétního záznamu. 35–65 s: pohyb, aktivace a Why? 65–100 s: timer experiment a obě větve. 100–120 s: odmítnutí, známé limity a cesta k reprodukci.

Finální video dosud není natočené. Tento scénář ani screenshot se nesmějí vydávat za `video/final.mp4`. Záložní připravený průchod musí být označen prepared; neprokazuje čerstvou generaci.
