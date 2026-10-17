/**
 * Zátěžová zkouška fronty režiséra (P53 T4) nesmí zavolat placený model:
 * `cleanEnv` klíče modelu jen vynechá a `next start` by je doplnil z `.env*`
 * v kořeni (revize fáze 2). Se souborem `.env*` se proto server nespustí.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { envFilesIn, startServer } from '../load/director-burst.mjs';

function rootWith(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'p53-burst-root-'));
  for (const name of files) writeFileSync(join(root, name), 'WORLDSMITH_FALLBACK_ENDPOINT=openai:https://api.openai.com\n');
  return root;
}

describe('director burst – no paid model through .env files', () => {
  it('names every .env file next would load and skips .env.example', () => {
    expect(envFilesIn(rootWith('.env.example', 'package.json'))).toEqual([]);
    expect(envFilesIn(rootWith('.env', '.env.local', '.env.production', '.env.example')).sort()).toEqual(['.env', '.env.local', '.env.production']);
  });

  it('refuses to start next when the root has a .env file', async () => {
    const root = rootWith('.env.production.local');
    await expect(startServer({ port: 1, upstream: 'http://127.0.0.1:1/v1', slots: 2, root })).rejects.toThrow(/refusing to start: \.env\.production\.local/);
  });
});
