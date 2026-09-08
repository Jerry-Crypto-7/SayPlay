# T13 — předání lokální varianty, 8. 9. 2026

**Předávaný rozsah: vlastní lokální Reality Compiler demo explicitně úplných krátkých procedur přes předplatné Codexu. Soutěžní přihláška ani veřejný release nejsou dokončené.** Rozhodnutí T12 je [ZÚŽIT](decision.md), lidský signál zůstává INCONCLUSIVE; chybějící evidence není převedena na PASS.

## Kontrola všech položek plánu předání

| Položka | Stav a konkrétní evidence |
|---|---|
| Veřejná URL v čistém browseru | MISSING. Lokální localhost a řízené Chromium nejsou veřejná URL. Síťové kontroly nebyly provedeny. |
| Aktuální submission manifest | Aktualizován `docs/submission/submission.json`: lokální launcher, aktuální evaly; chybějící veřejné URL a video mají `TODO: MISSING`, které stávající gate odmítá. Uvedená repository URL nebyla nezávisle ověřena. |
| README s rozsahem a spuštěním | Doplněn `README.md`: předpoklady, příkazy, port 3116, pouze řízené okno, 2 000 znaků, 12 volání, časový limit, ztráta projektu po reloadu a přiznaná latence. |
| Krátké video aktuálního buildu | MISSING: `video/final.mp4`. Konkrétní průchod a scénář jsou v `docs/submission/demo-walkthrough.md`; scénář a screenshot nejsou video. |
| Disclosure a práva k podkladu | Manifest aktualizován podle skutečného použití oficiálního CLI; vlastní fiktivní zdroje a 25 dalších souborů implementačních testů registrovány. Právní ověření podmínek pro veřejné nasazení pomocí osobního předplatného zůstává MISSING. |
| Eval s identitou kódu a neúspěchy | `subscription-report.md` odkazuje na konkrétní archiv s HEAD, dirty stavem, uzamčenou sadou, modelovými requesty, všemi pokusy, usage a stop reason. Semantické a lidské review je samostatné. Změny nejsou commitnuté; HEAD sám neidentifikuje pracovní diff. |
| Provozní evidence | Lokální timeout a call limit mají cílené testy; samostatné spuštění launcheru ověřuje start vlastního serveru. Veřejná dostupnost, monitoring, alerty, restart hostingu a období soutěžního provozu: MISSING / NOT_RUN. |
| Registrace, způsobilost, výjimky | MISSING: potvrzení autora. Offline submission gate našla nevyplněnou registrační kategorii a identitu v historii commitů. Historie se nepřepisuje a nic se neodesílá. |

## Reprodukovatelné předání

1. Z aktuálního pracovního stromu provést instalaci a build podle README; neopisovat credential soubory. WSL2 runtime a sandbox se na jiném stroji ověřují znovu, cesta ke CLI je nyní specifická pro tento počítač.
2. `npm run demo:subscription` otevře vlastní demo. [Průvodce](../../docs/submission/demo-walkthrough.md) určuje skutečný vstup a intervenci. Vlastní podklad lze vložit v deklarovaném rozsahu.
3. `npm run measure:reality-compiler-subscription` po explicitním přepínači autorizace spouští označený lokální holdout. Bez API fallbacku; nejvýše 60 sekvenčních call attempts a dvě hodiny. Selhání nebo neznámá usage ukončí další volání a ponechá všechny plánované páry.
4. `npm run study:reality-compiler` připraví kartu A/B podle protokolu. Jsou to připravené stavy, nikoli generace. Skutečný pozorovatel zaznamenává odpovědi; launcher je nevymýšlí.
5. Před veřejným vydáním doplnit chybějící artefakty a ověření a znovu spustit plnou submission kontrolu proti skutečné veřejné variantě. Lokální předplatné se samo nezmění na sdílený veřejný backend.

## Kontroly a dohledatelnost

Počáteční offline kontrola `scratch/t13-submission-check.log` skončila nenulově: video, registrace, 26 disclosure nálezů a identita v historii. Síťové kontroly SKIP. Ověřené položky disclosure byly doplněny; následný výstup je `scratch/t13-submission-check-final.log`. Výsledky kontrol a finální naměřené počty jsou shrnuty v aktuálním stavu projektu a subscription reportu. Offline kontrola nikdy nepotvrzuje veřejné odevzdání.

Následný skener potvrdil disclosure PASS ve svém rozsahu. Běžel během úprav dokumentů a u popisu zachytil i tehdy chybějící soubor a starší formát kategorie; tyto soubory byly následně doplněny. Trvalý rozpor zůstává: stará brána vyžaduje doslovnou garanci z historického DESIGN-BOOK.md §6. Aktuální pilot ji nepřebírá jako neověřený slib. Před skutečným soutěžním release je potřeba sladit tento historický kontrakt s vybraným produktem; samotný starý checker není potvrzením aktuální pilotní hypotézy.

T13 připravuje konkrétní handoff a výslovný seznam mezer. Neautorizuje publikování, odeslání přihlášky, změnu účtu ani přepis historie.

## Konečné ověření lokálního předání

Konečná série 0143dcc9-ea30-4519-ada3-b47ff02bdf5b dokončila 30/30 párů, 36/36 CLI volání, bez timeoutu a bez stop reason. Invarianty, očekávané rozdíly větví a zachování stavu při odmítnutí prošly ve všech 30 párech. H06–H08 ve všech třech opakováních nevyžádaly upřesnění: 9 doložených selhání z 15 problematických párů, brána FAIL. Zbývajících šest vyžádalo upřesnění, správnost jeho obsahu čeká na lidské review. Vytvoření: medián 126,22 s / p95 180,43 s (FAIL proti 30/60 s); změna: medián 2,42 s / p95 3,73 s (PASS proti p95 8 s).

Prošlo 63 cílených unit testů, TypeScript, dvě připravené browserové studie A/B a dokončení živého benchmarku. Dokončení měřicího testu není PASS všech kvalitativních bran. License gate v scratch/t13-license-final.log: všech 7 kontrol PASS v rozsahu 609 indexovaných cest. Cílená kontrola aktuálních dokumentů je v handoff-document-check.json. Screenshoty přípravy nejsou doloženy; vizuální review ani pět skutečných lidí tím nejsou nahrazeni. Veřejný submission gate zůstává neuzavřený z důvodů výše.
