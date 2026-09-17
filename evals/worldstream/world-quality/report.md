# P20 — průběžná přejímka hybridní verze

17. 9. 2026, stav 19:10. **G-R/G-L FAIL; ostatní produktové brány neuzavřené.** Finální verzovaná živá série ještě běží. Žádná lidská nebo externí evidence se nenahrazuje unit testem.

Aktuální implementační stav a přesné artefakty jsou v `PROJECT-STATUS.md` a jediném plánu P20. Historická baseline ani uzamčený protokol se nepřepisují.

| Brána | Dostupný důkaz | Co chybí |
|---|---|---|
| G-V/G-W | T04 ruční reference, archivní/živé snímky; první nová série30/30 | finální galerie a slepé lidské hodnocení |
| G-A4 | [10/10 skutečných modelových návrhů nad fixtures](../../../plans/P20/a4-live-v2-20260917-1756/report.md), replay p95 258,166 ms; [celá skutečná živá browser cesta](../../../plans/P20/live-browser-v3-20260917-1825/README.md) | 5 cizích lidí; není to deset nově generovaných světů ani jedna přesně shodná verze všech experimentů |
| G-R/G-L | [Původní frozen30/30](../../../plans/P20/t18-hybrid-20260917-1624/final-report.md):11certified,87calls,intentp95120,077s; [offline current replay](../../../plans/P20/t18-original-current-replay-20260917/report.md)11→11. G-R/G-L FAIL. | finální v2běh, browser composition/live percentily; GLB cold/reload není cold/warm model |
| G-P | technické rozpočty GLB/reference na RTX 3090 | cílový notebook 1080p, CPU/GPU/frame a obě viewports |
| G-E | allowlist GLB a testovaný importní profil | dva nové přijatelné importované/generované objekty |
| G-D | lokální produkční build, [restart/reconnect](../../../plans/P20/session-restart-20260917/README.md), [konkrétní host/cena](../../../ops/host/cost-estimate.md), [skutečné živé video90s](../../../videos/worldstream-a4/README.md) | autorizovaný hosting/hosted CLI, čistý veřejný browser, registrace, veřejný repozitář a monitoring |

Pro studii je připraven `study-cards.md`. Automatické pixelové nebo projekční kontroly jsou diagnostika. Zelený test experimentu znamená, že je uložen výsledek, nikoli že generace splnila zadání.

## Verzování a hranice

[Progresivní skutečný browser1905](../../../plans/P20/early-preview-live-v2-20260917-1905/README.md): vlastní neinteraktivní náhled78,988s, interaktivní239,6575s, žádný fallback; jedno pozorování a žádný G-L PASS. Lidský [offline workflow](study-cards.md) má10testů a prázdná šablona správně dává INVALID/0odpovědí; připravený nástroj nenahrazuje studii.

Původní T18 používal zdroj zmrazený16:24; finální samostatný v2 běh zdroj18:03. Novější runtime/comparison/UI/progressive změny mají vlastní cílené testy a skutečná browser měření. Offline přepočet uložených modelových odpovědí není nová generace. Souběžné modelové experimenty nejsou izolovaný benchmark, čas transportu obsahuje CLI/čekání. Historické reporty a raw emise se nepřepisují.

Nový GLB [download/decode cold/reload profil](../../../plans/P20/asset-cache-profile.md) a [dvě viewports](../../../plans/P20/t15-two-futures.md) jsou na dostupné RTX3090. Starší fixní raw GPU soubor přepsal opakovaný test; [přesný záznam omezení](../../../plans/P20/a4/artifact-history.md), žádná rekonstrukce původního raw z čísel reportu. Nové browser artefakty používají samostatné výstupní adresáře.

[Submission kontrola](../../../plans/P20/submission-check-1856.log):4/8PASS, repository404, chybějící potvrzení registrace/monitoring a disclosure mismatch indexu. Licence pracovního stromu7/7PASS je jiné tvrzení. Lokální video a popis jsou ověřené; nic z P20 nebylo v této session publikováno.
