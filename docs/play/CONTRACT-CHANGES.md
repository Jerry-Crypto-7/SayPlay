# Nálezy nad kontraktem PLAY (P23)

Kontrakt (`src/play/contracts.ts`) plány nemění. Co který plán potřebuje jinak, zapíše sem;
sloučí se jednou, až budou všechny tři vrstvy hotové.

## P23-C

- **`CompiledGame.compilerVersion` rozšířit na `string`.** Dnes je typované jako
  `typeof GAME_COMPILER_VERSION` (`'play-compiler-v1'`), takže dvojník kompilátoru
  (`src/app/api/play/_compiler.ts`) svou verzi `'stub-authored-v1'` vydává přes přetypování
  na jednom místě. `GameVersion.compilerVersion` už `string` je; `CompiledGame` by měl
  být stejně široký, aby dvojník i budoucí druhá verze kompilátoru prošly bez castu.
- **`gameVersionId` dává 8 hex znaků (FNV-1a 32 bitů z `canonicalHash`).** Veřejné id
  hry s 2^32 hodnotami je na hraně kolize už u desítek tisíc her; obálka (`_errors.ts`)
  proto přijímá `/^[a-f0-9]{8,64}$/`, aby delší hash prošel bez změny. Doporučení: v
  kontraktu spočítat `versionId` přes SHA-256 (`node:crypto` je na serveru, kde se
  pečetí, k dispozici) a nechat `canonicalHash` jen pro `specHash`/`worldHash`.
