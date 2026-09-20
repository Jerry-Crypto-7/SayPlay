import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CreateCase } from '../lock.mjs';

export const qualityRoot = fileURLToPath(new URL('./', import.meta.url));
export const frozenFiles = ['protocol.json', 'development.json', 'holdout.json', 'a4-cases.json'] as const;

export function verifyQualityCorpus(root = qualityRoot): void {
  const lock = JSON.parse(readFileSync(join(root, 'MANIFEST.lock'), 'utf8')) as { files: Record<string, string> };
  for (const file of frozenFiles) {
    const digest = createHash('sha256').update(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    if (lock.files[file] !== digest) throw new Error(`P20 frozen corpus changed: ${file}; version and reason required`);
  }
}

export function readQualityCases(part: 'development' | 'holdout' | 'all'): CreateCase[] {
  verifyQualityCorpus();
  const read = (name: string) => JSON.parse(readFileSync(`${qualityRoot}${name}.json`, 'utf8')) as CreateCase[];
  return part === 'all' ? [...read('development'), ...read('holdout')] : read(part);
}
