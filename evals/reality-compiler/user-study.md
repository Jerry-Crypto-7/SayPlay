# T11 — uživatelské ověření

Stav: **NOT_RUN**. Zaznamenaní účastníci: **0/5**. Žádné odpovědi, pozorování ani lidské časy zatím nebyly naměřeny. `user-study.json` obsahuje prázdný formulář; P01–P05 jsou rezervované anonymní identifikátory, nikoli skuteční lidé.

## Příprava pozorovatele

Spustitelná příprava 3D používá `npm run study:reality-compiler` a proměnnou `RC_STUDY_CARD` s hodnotou A nebo B. Připraví scénu a skutečný vstupní log, pozastaví runtime a otevře okno pro účastníka. Neukládá smyšlené lidské výsledky a nevolá model. Archiv přípravy je pod `scratch/study-session/`. V obou variantách jsou technická ID visitor/sensorA/sensorB/case/countdown; karta B představuje archiv stejným schematickým objektem jako karta A. Zobrazený banner uvádí prepared a konkrétní čas intervence, fork a horizont. Čas úlohy začne až po předání připraveného okna člověku.

```powershell
$env:RC_STUDY_CARD='A' # nebo B podle předem zapsaného pořadí v user-study.json
npm run study:reality-compiler
```

Pro textovou podmínku ukaž samostatnou [kartu A](study-card-A.md) nebo [kartu B](study-card-B.md). Tento dokument se skrytou rubrikou účastník nevidí. Odpovědi zaznamenává skutečný pozorovatel do existujícího JSON; příkaz `npm run evaluate:reality-compiler` je potom vyhodnotí. Automatické ověření launcheru s `RC_STUDY_SMOKE=1` není pozorováním člověka.

Získat pět lidí, kteří projekt dosud neznají. Nedomlouvat si příznivé odpovědi a nevysvětlovat průběžně ovládání. Použít dvě různé pevné scény podle níže uvedených karet; scene A je vývojové muzeum a scene B srovnatelná varianta s 30 sekundami. Před návštěvou ověřit jejich počáteční stav a timer změnu. Jsou to připravené studijní podklady, nikoli cold modelová generace. Stejné připravené stavy a pravidla musí být dostupné i v textové kontrole. Pokud příprava 3D scény chybí, nezačínat lidský test a nic nevykazovat jako hotové pozorování.

V JSON je předem prohozené pořadí 3D a text/tabulka. Každý člověk řeší A a B, nikdy tutéž kartu dvakrát. Ve 3D použít hlavní stránku s runtime, Source a source branch comparison. U textové varianty ukázat jen odpovídající kartu s tabulkou; nikoli 3D ani skrytou rubriku. Čas stavby scény nepatří do času lidské úlohy. Zaznamenat zařízení, velikost okna a verzi aplikace do poznámek při sběru.

## Pokyn účastníkovi

„Podívej se na zdroj a proveď požadovanou změnu. Ukaž původní a změněný výsledek. Vysvětli, co pochází ze zdroje, co je tvoje experimentální změna a co je výsledek simulace. Řekni, jestli ti nějaká prostorová informace pomohla a jak.“

Pokud účastník požádá o pomoc, zaznamenat přesně žádost i poskytnutý zásah; nezapočítat takový průchod jako samostatné dokončení. Při neúspěchu zapsat `completed:false`, skutečný čas a slovní popis. Neukončený/nepozorovaný pokus zůstává null. Vysvětlení zapsat vlastními slovy účastníka, nikoli generovaným shrnutím modelu.

## Karta A — muzeum

Návštěvník musí fyzicky přijít ke stanici A, která jednorázově spustí 20sekundový timer. Ke stanici B musí dojít a aktivovat ji před vypršením; tehdy se vitrína otevře a timer zastaví. Na stejném tiku má expirace přednost. Opakované A čas neobnovuje, vzdálené kliknutí není návštěva stanice. Úspěch nebo alarm jsou konečné. Zásah: zkrať čas na 10 sekund. Porovnej stejný záznam návštěvníka, který B skutečně aktivuje 12 sekund po A.

| Událost | Čas od první aktivace A | Prostorová podmínka |
|---|---:|---|
| A aktivováno | 0 s | návštěvník sousedí s A |
| Přesun k B | následuje po A | proběhne skutečná chůze |
| B aktivováno | 12 s | návštěvník už sousedí s B |
| Pozorování | 15 s | obě větve mají stejný horizont |

## Karta B — archiv

Pracovník spustí u stanice A jednorázové 30sekundové předávací okno. Aktivace sousední stanice B před vypršením odemkne archiv a zastaví timer. Na stejném tiku vyhraje expirace; po ní se zapne upozornění a archiv zůstane zamčený. Vzdálené aktivace jsou neúčinné a A čas nerestartuje. Zásah: zkrať okno na 25 sekund. Porovnej stejný záznam pracovníka, který B skutečně aktivuje 18 sekund po A.

| Událost | Čas od první aktivace A | Prostorová podmínka |
|---|---:|---|
| A aktivováno | 0 s | pracovník sousedí s A |
| Přesun k B | následuje po A | proběhne skutečná chůze |
| B aktivováno | 18 s | pracovník už sousedí s B |
| Pozorování | 28 s | obě větve mají stejný horizont |

## Skrytá rubrika pozorovatele

A: původní vitrína otevřená bez alarmu, změněná zamčená s alarmem. B: obě větve otevřené bez upozornění; kratší okno nemusí změnit tento výsledek. Hodnotit správný následek a správné rozlišení zdrojového pravidla, intervence jako předpokladu a výsledku runtime. Textová citace sama nepotvrzuje smysl pravidla. Za konkrétní prostorový přínos uznat například správné rozpoznání nutnosti dojít do dosahu B, doložené správným řešením; obecné „vypadá to hezky“ nestačí.

Vyplnit `observer`, `observedAt`, potvrzení `newParticipant`, dvě skutečné úlohy, pořadí, čas, pomoc a vysvětlení v `user-study.json`. Přepnout stav na RECORDED až po skutečném sběru. Hodnoty null se automaticky nestanou false ani PASS. Pět úplných pozorování je nutných pro verdikt: ≥4 samostatná správná dokončení 3D s rozlišením pojmů, ≥3 konkrétní prostorové přínosy s ověřeným správným řešením. Vykázat i výsledky textové varianty; pokud vyjde lépe, uvést to. Není to statistický důkaz převahy 3D.
