# Nálezy nad kontraktem PLAY (P23)

Kontrakt (`src/play/contracts.ts`) plány nemění. Co který plán potřebuje jinak, zapíše sem;
sloučí se jednou, až budou všechny tři vrstvy hotové.

## P23-C

- **`CompiledGame.compilerVersion` rozšířit na `string`.** Dnes je typované jako
  `typeof GAME_COMPILER_VERSION` (`'play-compiler-v1'`), takže dvojník kompilátoru
  (`src/app/api/play/_compiler.ts`) svou verzi `'stub-authored-v1'` vydává přes přetypování
  na jednom místě. `GameVersion.compilerVersion` už `string` je; `CompiledGame` by měl
  být stejně široký, aby dvojník i budoucí druhá verze kompilátoru prošly bez castu.
