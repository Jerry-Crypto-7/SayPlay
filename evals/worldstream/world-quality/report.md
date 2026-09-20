# P20 — průběžná přejímka hybridní verze

17. 9. 2026. **G-R/G-L FAIL; ostatní produktové brány neuzavřené.** Finální verzovaná živá série je **uzavřená na 18 z 30 vět**, ne dokončená. Žádná lidská nebo externí evidence se nenahrazuje unit testem.

## Obě živé série, uzavřené na tom, co existuje

Strojová čísla jsou v `results.json` a tenhle oddíl je nesmí přepsat. Per-case odpovědi leží v `plans/P20/t18-hybrid-*/`, které jsou gitignorované — `results.json` je proto citovatelný záznam, ne odvození, které čistý klon přepočítá.

| | původní série (16:24) | finální v2 (18:03) |
|---|---:|---:|
| dokončených vět | **30 / 30** | **18 / 30** |
| nedotčených vět | 0 | 12 |
| certifikovaných blueprintů | 11 | **6** |
| volání modelu | 87 | 51 |
| intent p95 | 120 077 ms | 114 186 ms |
| dokončení generace p95 | 437 221 ms | 429 678 ms |

Rozdělení chyb (`LAYOUT_INVALID` / `BLUEPRINT_INVALID` / `WORLD_REJECTED` / `REFERENCE_BROKEN` / výpadek):

- původní série: 10 / 4 / 3 / 2 / 0 — dohromady 19 odmítnutí z 30.
- v2: 7 / 1 / 2 / 1 / 1 — dohromady 12 neúspěchů z 18 dokončených.

V obou sériích je **největší jedinou příčinou `LAYOUT_INVALID`** — víc než polovina odmítnutí. Není to rovnoměrně rozprostřená chyba modelu, ale jedno místo kontraktu rozvržení.

**Proč série skončila na 18 větách:** běh v2 se zastavil na výpadku transportu a měřidlo živé volání samo neopakuje (`stopReason: transport-failure-no-automatic-retry`), takže dvanáct z třiceti vět se nikdy nezkusilo. Série se uzavírá na osmnácti případech, které existují. **Nikde se nesmí psát jako 30/30**, a ani se dvěma sériemi dohromady se čísla nesčítají — jsou to dva běhy nad různě zmrazenými zdroji.

Stav bran je v `results.json` u každé brány se svým důvodem: `G-R` a `G-L` **FAIL**, ostatních šest `PENDING_` s pojmenovaným chybějícím vstupem (lidé, cílový hardware, skutečné assety, externí hosting).

Aktuální implementační stav a přesné artefakty jsou v `PROJECT-STATUS.md` a jediném plánu P20. Historická baseline ani uzamčený protokol se nepřepisují.

| Brána | Dostupný důkaz | Co chybí |
|---|---|---|
| G-V/G-W | T04 ruční reference, archivní/živé snímky; původní série 30/30, finální v2 uzavřená na 18/30 | finální galerie a slepé lidské hodnocení |
| G-A4 | [10/10 skutečných modelových návrhů nad fixtures](../../../plans/P20/a4-live-v2-20260917-1756/report.md), replay p95 258,166 ms; [celá skutečná živá browser cesta](../../../plans/P20/live-browser-v3-20260917-1825/README.md) | 5 cizích lidí; není to deset nově generovaných světů ani jedna přesně shodná verze všech experimentů |
| G-R/G-L | [Původní frozen30/30](../../../plans/P20/t18-hybrid-20260917-1624/final-report.md):11certified,87calls,intentp95120,077s; [offline current replay](../../../plans/P20/t18-original-current-replay-20260917/report.md)11→11. Finální v2 uzavřená na 18/30: 6certified, 51calls, intentp95114,186s. G-R/G-L FAIL. | browser composition/live percentily; GLB cold/reload není cold/warm model |
| G-P | technické rozpočty GLB/reference na RTX 3090 | cílový notebook 1080p, CPU/GPU/frame a obě viewports |
| G-E | allowlist GLB a testovaný importní profil | dva nové přijatelné importované/generované objekty |
| G-D | lokální produkční build, [restart/reconnect](../../../plans/P20/session-restart-20260917/README.md), [konkrétní host/cena](../../../ops/host/cost-estimate.md), [skutečné živé video90s](../../../videos/worldstream-a4/README.md) | autorizovaný hosting/hosted CLI, čistý veřejný browser, registrace, veřejný repozitář a monitoring |

Pro studii je připraven `study-cards.md`. Automatické pixelové nebo projekční kontroly jsou diagnostika. Zelený test experimentu znamená, že je uložen výsledek, nikoli že generace splnila zadání.

## Verzování a hranice

[Progresivní skutečný browser1905](../../../plans/P20/early-preview-live-v2-20260917-1905/README.md): vlastní neinteraktivní náhled78,988s, interaktivní239,6575s, žádný fallback; jedno pozorování a žádný G-L PASS. Lidský [offline workflow](study-cards.md) má10testů a prázdná šablona správně dává INVALID/0odpovědí; připravený nástroj nenahrazuje studii.

Původní T18 používal zdroj zmrazený16:24; finální samostatný v2 běh zdroj18:03. Novější runtime/comparison/UI/progressive změny mají vlastní cílené testy a skutečná browser měření. Offline přepočet uložených modelových odpovědí není nová generace. Souběžné modelové experimenty nejsou izolovaný benchmark, čas transportu obsahuje CLI/čekání. Historické reporty a raw emise se nepřepisují.

Nový GLB [download/decode cold/reload profil](../../../plans/P20/asset-cache-profile.md) a [dvě viewports](../../../plans/P20/t15-two-futures.md) jsou na dostupné RTX3090. Starší fixní raw GPU soubor přepsal opakovaný test; [přesný záznam omezení](../../../plans/P20/a4/artifact-history.md), žádná rekonstrukce původního raw z čísel reportu. Nové browser artefakty používají samostatné výstupní adresáře.

[Submission kontrola](../../../plans/P20/submission-check-1856.log):4/8PASS, repository404, chybějící potvrzení registrace/monitoring a disclosure mismatch indexu. Licence pracovního stromu7/7PASS je jiné tvrzení. Lokální video a popis jsou ověřené; nic z P20 nebylo v této session publikováno.
