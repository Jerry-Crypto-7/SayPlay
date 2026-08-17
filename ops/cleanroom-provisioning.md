# Provisioning clean-room kontroly na novém klonu

`scripts/cleanroom-check.mjs` čte seznam zakázaných identifikátorů ze
`scripts/cleanroom-forbidden.txt`. Ten soubor je v `.gitignore`, takže **na
čerstvém klonu neexistuje** a kontrola skončí chybou, dokud ho tam někdo
nedostane. Tenhle dokument říká jak.

## Proč to není v gitu

Seznam nese názvy tříd, metod a konstant z proprietárního modulu třetí strany.
Repozitář je podle `RULES.md` §2 povinně veřejný. Commitnout seznam by znamenalo
zveřejnit přesně to, čemu má bránit — stejný důvod a stejná přísnost jako u
`SECURITY-FINDINGS.md`.

## Proč kontrola při jeho absenci selže, místo aby se přeskočila

Kontrola, která bez seznamu tiše projde, je horší než žádná: v logu vypadá jako
splněná brána. Chybějící i prázdný seznam jsou proto **selhání** (`exit 1`).
Následek je záměrný a je potřeba ho znát dopředu:

- **Na čerstvém klonu neprojde `pre-commit`, dokud seznam nedodáš.**
- **V CI neprojde nikdy**, pokud se seznam nedostane do běhu jako secret. CI
  runner klon nemá a mít nemá.

## Postup na novém stroji

1. Získej seznam z bezpečného kanálu — správce hesel nebo šifrovaná příloha.
   **Nikdy ne přes chat, issue tracker, PR komentář ani schránku sdíleného stroje.**
2. Ulož ho jako `scripts/cleanroom-forbidden.txt` v kořeni repozitáře.
3. Ověř, že je ignorovaný, dřív než uděláš první commit:

   ```
   git check-ignore -v scripts/cleanroom-forbidden.txt
   ```

   Musí vypsat řádek z `.gitignore`. Když nevypíše nic, **necommituj** a oprav
   `.gitignore` první.
4. Smaž ze seznamu řádek `#!unprovisioned` — ten říká, že seznam ještě nikdo
   nenaplnil, a dokud tam je, kontrola to hlásí na každém běhu.
5. Ověř, že kontrola běží a hlídá skutečná jména:

   ```
   node scripts/cleanroom-check.mjs
   ```

   Nesmí hlásit `POZOR` ani `FAIL`. Když hlásí, buď je seznam pořád prázdný,
   nebo v něm zůstala ta direktiva.
6. Zapni hooky, jestli to ještě nikdo na tomhle stroji neudělal:

   ```
   git config core.hooksPath .githooks
   ```

## Když seznam ještě není naplněný

Soubor se rodí s direktivou `#!unprovisioned` a bez jediného identifikátoru.
Kontrola v tom stavu **selže** (`exit 1`) a řekne, že clean-room záruka je zatím
**procesní, ne strojová**.

**Commit ale zastavený není, a je potřeba vědět proč.** `.githooks/pre-commit`
si prominutí nastavuje sám, jen pro tenhle jeden běh:

```
CLEANROOM_ALLOW_UNPROVISIONED=1 node scripts/cleanroom-check.mjs || status=1
```

| Kde | Prominutí | Výsledek nad nenaplněným seznamem |
|---|---|---|
| `git commit` (hook) | ano, nastavuje si ho hook | `POZOR` na každém commitu, commit projde |
| `npm run gate:cleanroom` | ne | `FAIL`, `exit 1` |
| CI | ne | `FAIL`, `exit 1` |

**Proč zrovna na commitu, kde je brána nejblíž chybě.** Původní znění tady
hooku prominutí zakazovalo, s odůvodněním, že by obejití přestalo být vědomé.
Naměřená alternativa je ale horší: nenaplněný seznam je
stav, ve kterém tenhle repozitář bude, dokud k ECA modulu někdo nedostane
přístup, takže by na každém commitu selhávala brána, se kterou se nedá nic
udělat. Jediná rutinní cesta dál je `git commit --no-verify` — a ta vypne **obě**
brány, tedy i licenční, která hlídá věc, se kterou udělat něco jde. Prominutí je
proto **užší než to obejití, které by si člověk vzal místo něj**: platí na jednu
bránu, na jeden běh, a je vidět jako banner v každém commitu.

Zdůvodnění u té řádky je v `.githooks/pre-commit`, dosah prominutí drží testy
v `scripts/__tests__/pre-commit-hook.test.ts` (licenční brána proměnnou
nedostane).

**Proč to nestačilo přiznat.** Do 15. 8. 2026 tenhle stav skončil nulou a vypsal
jen `POZOR`. Nula je nula: hook nad ní pustil dál cokoli a výstup u toho hlásil
počet prohledaných souborů, takže log vypadal jako práce brány, která nehlídala
nic. Přiznat se k prázdné bráně není totéž co ji mít.

Proč direktiva a ne zástupné jméno: první verze tady měla zástupný *identifikátor*
a shodila si vlastní commit. To jméno totiž stálo ve skriptu, v tomhle dokumentu i
v testech, takže si ho skener našel jako nález a brána zablokovala všechno.
Zástupné jméno na seznamu jmen je z principu vlastní gól. Direktiva je komentář,
takže se nehledá.

Naplnit seznam může jen člověk s přístupem k ECA modulu. **Do té doby se nikde
nesmí tvrdit, že clean-room je vynucený strojově** — v přihlášce, v reportu ani
v `DISCLOSURE.md`.

Obejít se to dá: kdo seznam vyprázdní, dopíše direktivu a nastaví tu proměnnou,
dostane zelenou. Je to vědomý zápis do souboru plus vědomý příkaz a hlásí se při
každém commitu. Proti záměru tahle brána neobstojí tak jako tak — viz poslední
odstavec.

## Vendorovaný kód v registru: `"manual": true`

Tohle pole píše **člověk** a `--sync` ho nikdy nedoplní, proto je popsané tady a
ne jen v kódu.

`disclosure.json` má třídu `library` odvozenou z `package-lock.json` — `--sync`
ji celou přegeneruje. **Zkopírovaný nebo vendorovaný kód v lockfilu není**, takže
odvodit se nedá a `--sync` ho z registru mazal, přestože je to jediná třída
závislosti, která je zároveň licenčně riziková a pro lockfile neviditelná.

Záznam, který má přežít, dostane příznak:

```json
{
  "name": "vendorovany-eca-runner",
  "kind": "library",
  "manual": true,
  "source": "zkopírováno do src/vendor/, v package-lock.json není",
  "authorOrProvider": "Někdo Jiný",
  "license": "GPL-3.0-only",
  "requiredNotices": ["plný text GPL-3.0 v src/vendor/LICENSE"],
  "attribution": "© 2020 Někdo Jiný"
}
```

Co příznak dělá a co nedělá:

- **`--sync` ho nechá být** a `DISCLOSURE.md` ho pořád jmenuje.
- **Kontrola 3 ho nepočítá** mezi položky, které v lockfilu chybí.
- **Nic neumlčí.** Licence pořád prochází whitelistem — `GPL-3.0-only` výš je
  nález kontroly 2 a musí ho někdo posoudit, příznak s tím nehne.
- **Na balíčku, který lockfile odvozuje, je to rozpor a kontrola 3 selže.** Jinak
  by šlo příznakem zmrazit skutečnou závislost: `--sync` by ji přestal přepisovat
  a její licence by se tiše přestala aktualizovat.

## Co tahle kontrola neumí

Je to lexikální shoda proti seznamu jmen. **Přepsaný kód se stejnou strukturou a
jinými názvy jí projde.** Neměří podobnost obsahu a žádný „práh podobnosti"
nepočítá. Proti záměrnému obejití neobstojí; obstojí proti zapomenutému názvu ve
zkopírovaném útržku, což je to, co se opravdu stává.
