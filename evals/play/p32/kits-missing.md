# Sady, které nejdou stáhnout headless (P32C T3)

Stav 30. 9. 2026. Hrdinové a nepřátelé devíti vět, pro které T2 našel jen statický model: tučňák, kočka, pes, lední medvěd, duch a robot se stáhli z kenney.nl (`scripts/assets/rigged/sources.json`, sady `kenney-cube-pets`, `kenney-graveyard-kit`, `kenney-blocky-characters`). Zbývají dva:

| Postava | Sada, licence | Odkud stáhnout | Kam uložit |
|---|---|---|---|
| Kuchař (chef) | Quaternius Ultimate Animated Character Pack, CC0 1.0 ([text](https://creativecommons.org/publicdomain/zero/1.0/)), stránka https://quaternius.com/packs/ultimatedanimatedcharacter.html | Google Drive https://drive.google.com/drive/folders/1sNi1AfenfPRrvRt5yfaj5QMMd6KKcUJ5 → složka `glTF/`, soubor `Chef_Male.gltf` (případně `Chef_Female.gltf`, `Chef_Hat.gltf`) i se soubory, na které odkazuje | `D:/caches/p32-kits/quaternius-uacp/glTF/` |
| Žralok (shark) | Quaternius Animated Fish Pack, CC0 1.0 ([text](https://creativecommons.org/publicdomain/zero/1.0/)) | itch.io stránka autora https://quaternius.itch.io/lowpoly-animated-fish → „Fish Pack Animated by Quaternius.zip“ (zadarmo, „No thanks, just take me to the downloads“); totéž na Drive https://drive.google.com/drive/folders/1SvlOveJJjmhSn-FgCRyojc1T5QHjjGkF | zip rozbalit do `D:/caches/p32-kits/quaternius-fish/` (soubor `FBX/Shark.fbx`) |

Proč ne headless:
- **Kuchař:** soubory jsou jen na Google Drive; každé stažení 30. 9. vrátilo stránku „Quota exceeded“. Výpis složky jde bez přihlášení, stažení ne. Kenney ani KayKit kuchaře nemají.
- **Žralok:** stažení z itch.io jde přes proklik; hlavně je sada jen v FBX s jediným klipem `Armature|Swim` a potrubí čte glTF. Po stažení je potřeba převod FBX → GLB (Blender: File › Import › FBX, pak Export › glTF 2.0 Binary do `D:/caches/p32-kits/quaternius-fish/Shark.glb`). Jiný CC0 animovaný žralok v glTF od původního autora se nenašel; Gobkit Free Animal Pack je vyloučený, jeho stránka uvádí generativní AI.

Po stažení (HALT v plánu P32C, pak znovu T3–T5): v `scripts/assets/rigged/sources.json` přepnout `quaternius-uacp` a `quaternius-fish` z `kind: "skip"` na zdroj čtený z cache, doplnit postavy do `P32_CHARACTERS` v `scripts/assets/rigged/build.mjs` (jména klipů přečíst ze souboru) a spustit `fetch.mjs` a `build.mjs`.

Robot: „firefighter robot“ jako hotový CC0 model neexistuje; použitý je šedý robot s červenými pruhy `character-g` z Kenney Blocky Characters. Lepší sadu klipů (skok, smrt, 14 klipů) má RobotExpressive od Tomáse Laulhého (CC0), ale jediný glTF je převod Dona McCurdyho v repozitáři three.js, ne vydání autora, proto se nepoužil.
