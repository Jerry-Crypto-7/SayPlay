# T2 — ověřovaný evidence kontrakt

Stav: implementováno jako interní modul `src/worldstream/evidence.ts`. Ještě není připojen k HTTP endpointům ani k UI; integrace zdrojového vstupu a atomického commitu patří T7/T8.

## Použití a důvěrová hranice
1. `createSourceSnapshot` přijme validovaný plain text a popis původu, zachová přesné UTF-8 bytes a spočítá SHA-256. Vrací neměnný snapshot; neakceptuje hash dodaný volajícím. Metadata práv jsou záznam, nikoli právní ověření.
2. `sealEvidenceDraft` ověří návrh proti `EvidenceContext` dodanému aplikací: konkrétní revize světa, skutečná surface rule/entity IDs, uložené zdroje a rodičovská větev/revize. Tyto údaje nesmějí pocházet z návrhu modelu. Systémové IR movement rules se do seznamu surface rule IDs automaticky nepřidávají.
3. Výstup nese SHA-256 kanonického sidecaru a je hluboce zmrazený. Existující WorldDoc ani význam simHash se nemění. `validateEvidenceRevision` při načtení provede kontroly znovu včetně porovnání uloženého evidenceHash.
4. `confirmed` nebo `disputed` je přípustné pouze tehdy, pokud je hash celé konkrétní revize v autoritativním seznamu `reviewedRevisionHashes`. Samotné reviewerId ani timestamp z modelové odpovědi nejsou oprávněním. Úprava obsahu zneplatní staré schválení. `evidenceDigest` pouze počítá otisk; neuděluje schválení.

Úložiště schválení, autorizace konkrétní lidské akce a atomické ověření aktuální base revision se implementují v integrační vrstvě. T2 je nenahrazuje. Hodnoty before/after zásahu musí T8 porovnat se skutečným rodičovským pravidlem; zde se ověřuje jejich typ, rozdílnost a referenční vazby.

## Přesný tvar a limity
Verze: `worldstream-evidence-v1`. Autoritativní strojový tvar exportují `sourceSnapshotSchema`, `evidenceDraftSchema` a `evidenceRevisionSchema`; tabulky původního návrhu nejsou alternativní parser.

- Jeden zdroj nejvýše 4 000 Unicode code points a 16 000 UTF-8 bytes; osamocené UTF-16 surrogate znaky se odmítají. CRLF a BOM se nenormalizují.
- Sidecar nejvýše 4 zdroje, dohromady 16 000 zdrojových bytes; 64 tvrzení, 128 bindingů, 16 referencí v jednom seznamu a 8 úryvků na sourced tvrzení.
- Locatory mají půlotevřené byte rozsahy. Řez musí být na hranicích UTF-8 znaků a přesně odpovídat excerptu.
- `interventionId: null` znamená původní tvrzení; konkrétní ID znamená změněné tvrzení. Druhá redundantní original/changed hodnota se neposílá.
- Sourced tvrzení musí mít úryvky, derived seznam existujících premis a odvození, assumed přiznaný důvod. Claim DAG nesmí obsahovat cyklus. Každé aplikačně určené surface pravidlo musí mít binding.
- Změněné tvrzení musí mít odpovídající intervention a rule binding. Nemůže si ponechat sourced status jen převzetím původního úryvku.
- Parent branch ID je samostatné neprázdné omezené označení, porovnávané s aplikačním kontextem. Existující BranchStore používá `origin` a `branch-1`; nevalidujeme je regexem pro IR rule ID.
- Povoleny jsou pouze výslovně deklarované klíče. Vlastní kód, nástroje nebo schvalovací pravomoci v payloadu neprojdou.

## Co úspěšná validace neznamená
Neznamená, že citovaný text tvrzení opravdu podporuje, že odvození je správné nebo že je model reálného světa pravdivý. Test výslovně ukazuje, že strukturálně validní, ale významově nepodložené tvrzení zůstává `unchecked`. Nevzniká automatické `readyToRun` ani automatický souhlas se spuštěním kritického předpokladu. To musí rozhodnout T7/T8/T9 podle review a uživatelského potvrzení.

## Ověření
48 testů evidence prošlo. Spolu se stávajícím blueprint schématem a muzejním oraclem prošlo 92/92 testů. Testy pokrývají přesné zdrojové bytes, hash, neplatné úryvky, Unicode limity, chybějící a duplicitní odkazy, cykly, revize, parent branch, podvržené review, explicitní zásah a source-free prompt.

```powershell
npx vitest run src/worldstream/__tests__/evidence.test.ts src/worldstream/__tests__/schema.test.ts src/sim/__tests__/museum-oracle.test.ts
npm run typecheck
```

Lokální JSON report: `scratch/evidence-regression-results.json`. Žádné živé modelové volání ani browserové měření nebyly součástí T2. Funkčnost interního kontraktu se nevydává za hotovou uživatelskou funkci.
