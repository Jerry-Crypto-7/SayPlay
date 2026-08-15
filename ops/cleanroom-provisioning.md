# Provisioning clean-room kontroly na novém klonu

`scripts/cleanroom-check.mjs` čte seznam zakázaných identifikátorů ze
`scripts/cleanroom-forbidden.txt`. Ten soubor je v `.gitignore`, takže **na
čerstvém klonu neexistuje** a kontrola skončí chybou, dokud ho tam někdo
nedostane. Tenhle dokument říká jak.

## Proč to není v gitu

Seznam nese názvy tříd, metod a konstant z proprietárního ECA modulu AcmeCorp.
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

   Nesmí hlásit `POZOR`. Když hlásí, buď je seznam pořád prázdný, nebo v něm
   zůstala ta direktiva.
6. Zapni hooky, jestli to ještě nikdo na tomhle stroji neudělal:

   ```
   git config core.hooksPath .githooks
   ```

## Když seznam ještě není naplněný

Soubor se rodí s direktivou `#!unprovisioned` a bez jediného identifikátoru.
Kontrola v tom stavu **projde**, ale na každém běhu hlásí `POZOR` a říká, že
clean-room záruka je zatím **procesní, ne strojová**.

Proč direktiva a ne zástupné jméno: první verze tady měla zástupný *identifikátor*
a shodila si vlastní commit. To jméno totiž stálo ve skriptu, v tomhle dokumentu i
v testech, takže si ho skener našel jako nález a brána zablokovala všechno.
Zástupné jméno na seznamu jmen je z principu vlastní gól. Direktiva je komentář,
takže se nehledá.

Naplnit seznam může jen člověk s přístupem k ECA modulu. **Do té doby se nikde
nesmí tvrdit, že clean-room je vynucený strojově** — v přihlášce, v reportu ani
v `DISCLOSURE.md`.

Obejít se to dá: kdo seznam vyprázdní a dopíše direktivu, dostane zelenou. Je to
vědomý zápis do souboru a hlásí se při každém commitu. Proti záměru tahle brána
neobstojí tak jako tak — viz poslední odstavec.

## Co tahle kontrola neumí

Je to lexikální shoda proti seznamu jmen. **Přepsaný kód se stejnou strukturou a
jinými názvy jí projde.** Neměří podobnost obsahu a žádný „práh podobnosti"
nepočítá. Proti záměrnému obejití neobstojí; obstojí proti zapomenutému názvu ve
zkopírovaném útržku, což je to, co se opravdu stává.
