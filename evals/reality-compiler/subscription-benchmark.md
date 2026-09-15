# T11 — benchmark přes vlastní předplatné

Spuštění po existujícím produkčním buildu a přihlášení oficiálního Codex CLI ve validovaném WSL2:

```powershell
$env:RC_SUBSCRIPTION_AUTHORIZED='1'
npm run measure:reality-compiler-subscription
```

Launcher spouští vlastní server na localhost:3117 a sekvenční Chromium. Používá stejný source handler a skutečný runtime jako produkt; bridge obsluhuje jen zdrojový endpoint a ostatní API požadavky odmítá. Žádný API fallback, nový API klíč ani USD rozpočet nejsou pro tento režim potřebné.

Uzamčený holdout obsahuje 10 scénářů × 3 opakování. Suite, úlohy, upřesnění a oracle se během sběru nemění; oracle není součástí modelového vstupu. Proti prvnímu autentizačnímu selhání byl opraven parser stavové zprávy CLI. Model, source prompt a oracle se podle výsledků neladily. V launcherech je model převzat ze stejné společné konstanty EMISSION_MODEL.

Výstup je [subscription-report.md](subscription-report.md), archiv obsahuje run.json, environment.json, journal.jsonl, subscription.jsonl a šablonu ručního review. Uchovávají se i neúspěšné nebo neprovedené páry. Dřívější neúplné archivy da0ea707-9662-4110-8b35-4366c5f959f5 a f768e40f-1424-45c0-a68f-0ddd003ecd8d se nemažou ani nevydávají za úplnou sérii. Nová hlavní série má ID 0143dcc9-ea30-4519-ada3-b47ff02bdf5b.

## Účtování a hranice měření

Navazující lidské hodnocení má [konkrétní postup](semantic-review.md), včetně vyplnění nekritických citací a vyhodnocení pracovní kopie bez změny původního archivu.

- Limit 60 je počet logických pokusů přes CLI transport, nikoli tvrzení o počtu všech interních HTTP požadavků CLI. Wrapper sám modelová volání neopakuje. Interní fronta, síťové pokusy a výpočet poskytovatele nejsou samostatně pozorovatelné.
- Raw usage v subscription.jsonl zachovává poskytovaná pole včetně cache a reasoning tokenů. Souhrn runneru používá deklarované input_tokens/output_tokens; neznámé významy dodatečných polí se nesčítají jako další placené tokeny.
- USD je null, cenová metoda subscription-no-unit-tariff a cenová brána NOT_RUN. Nepoužívá se historický API tarif ani tvrzení o bezplatném předplatném.
- Preflight failure před call-start v subscription.jsonl není zahájená inference, přesto má odpovídající transportní pokus v hlavním journalu. Limit/failure/unknown usage zastaví další volání; zbytek plánovaných párů zůstává NOT_RUN. Běh má dvouhodinový limit.
- Časy zahrnují lokální CLI/transport a interakci podle endpointu runneru. Cold zde znamená nové generování bez vlastní prepared/cache odpovědi, nikoli vyprázdněnou cache poskytovatele nebo serverless cold start.
- Měřilo se na vlastním počítači souběžně s vývojovými kontrolami a dalšími aplikacemi. Není to výkon izolovaného produkčního hardwaru. Automaticky vložená předem stanovená upřesnění nejsou lidské usability časy.
- Připravené studijní karty používají řízené browserové hodiny pro přesný vstupní log. Tento živý benchmark je nepoužívá. Sémantické review, vizuální použitelnost a pět lidí zůstávají samostatným skutečným důkazem.

API režim `measure:reality-compiler-cold` zůstává samostatný a vyžaduje svůj existující provider a USD limit. Jeho starý nulový report není výsledek tohoto subscription běhu.
