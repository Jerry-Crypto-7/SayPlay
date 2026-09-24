/** Slova názvu souboru modelu – sdílí výběr (`select.mjs`) a tagy katalogu (`promote.mjs`). */
import path from 'node:path';

/** Složky, které nesou formát nebo balík, ne význam modelu. */
const FORMAT_DIRS = /^(models?|assets?|addons?|gl(tf|b)( format)?|obj|fbx|gltf format|glb format|kaykit.*|export|individual characters|all together)$/i;
/** Slova v id balíku, která nic nezařazují. */
const PACK_NOISE = new Set(['kenney', 'kaykit', 'quaternius', 'kit', 'bits', 'pack', 'ultimate', 'animated', 'mega', 'megakit', 'remastered', 'mini', 'cute', 'toon', 'game']);

/** Slova složek nad souborem modelu (bez složek formátu), např. `Blob/glTF/x.gltf` → `['blob']`. */
export function folderTokensOf(file) {
  return file.replaceAll('\\', '/').split('/').slice(0, -1).filter((dir) => !FORMAT_DIRS.test(dir))
    .flatMap((dir) => dir.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_\-.]+/)).filter((token) => token.length > 1);
}

/** Slova id balíku bez autora a výplně, např. `quaternius-ultimate-food` → `['food']`. */
export const packTokensOf = (pack) => pack.split('-').filter((token) => !PACK_NOISE.has(token) && token.length > 1);

export function modelTokensOf(file) {
  const base = path.posix.basename(file.replaceAll('\\', '/')).replace(/(\.gltf)?\.(glb|gltf)$/i, '');
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !/^\d+$/.test(token));
}
