const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a nad zabaleným stavem, ručně a synchronně.
 *
 * Žádný WASM hasher: ten se inicializuje asynchronně a ležel by na kritické
 * cestě k prvnímu snímku. `Math.imul` drží násobení v 32 bitech, jinak by
 * mezivýsledek utekl do doublu a hash by přestal být přenositelný.
 */
export function hashWords(words: Uint32Array): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    hash = Math.imul(hash ^ (word & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ ((word >>> 8) & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ ((word >>> 16) & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ (word >>> 24), FNV_PRIME);
  }
  return hash >>> 0;
}

export function hashHex(words: Uint32Array): string {
  return hashWords(words).toString(16).padStart(8, '0');
}
