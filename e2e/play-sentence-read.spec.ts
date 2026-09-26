import { createServer, type Server } from 'node:http';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * P29B T6: panel „From your sentence“ říká pravdu o tom, kdo větu přečetl.
 * Návrh ze čtení lokálním modelem píše „read by a local AI model“, návrh ze
 * slov dál „from the keywords“ – a ani jeden se nevydává za hru od AI.
 *
 * Server musí běžet s `PLAY_READER=on PLAY_READER_ENDPOINT=http://127.0.0.1:8799`
 * (čtečka je jinak vypnutá, T3). Místo modelu odpovídá stub níž: větu
 * s „penguin“ přečte, na ostatní vrátí 500 a draft pak čte klíčová slova.
 */

const READER_PORT = 8799;
const READING = {
  control: 'runner',
  verbs: [{ word: 'slide', class: 'runner' }],
  hero: 'penguin',
  roles: [{ noun: 'fish', kind: 'collectible', count: 6 }],
  setting: 'an ice floe',
  mood: null,
  numbers: { seconds: null, counts: [] },
};

let reader: Server;

test.beforeAll(async () => {
  reader = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const user = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages.find((message) => message.role === 'user')?.content ?? '';
      if (!/penguin/i.test(user)) return void response.writeHead(500).end();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(READING) } }] }));
    });
  });
  await new Promise<void>((resolve) => reader.listen(READER_PORT, '127.0.0.1', resolve));
});

test.afterAll(() => new Promise<void>((resolve) => reader.close(() => resolve())));

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test('a draft read by the local model says so', async ({ page, request }) => {
  await page.goto(await publish(request, 'A penguin slides across the ice grabbing fish'));
  const read = page.getByTestId('play-read');
  await expect(read).toHaveAttribute('data-read-by', 'model');
  await expect(read).toHaveAttribute('data-authorship', 'draft');
  await expect(page.getByTestId('play-read-toggle')).toContainText('Instant draft read by a local AI model from');
  await expect(page.getByTestId('play-read-toggle')).not.toContainText('keywords');
});

test('a draft from the keywords keeps saying keywords', async ({ page, request }) => {
  await page.goto(await publish(request, 'A corgi runs through a park grabbing sausages'));
  const read = page.getByTestId('play-read');
  await expect(read).toHaveAttribute('data-read-by', 'keywords');
  await expect(page.getByTestId('play-read-toggle')).toContainText('Instant draft from the keywords in');
  await expect(page.getByTestId('play-read-toggle')).not.toContainText('AI model');
});
