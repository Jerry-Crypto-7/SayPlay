/**
 * Čekání na dlouhý běh bez popředního `sleep`: skončí, jakmile soubor obsahuje
 * hledaný text, nebo po `--max` sekundách. Vypíše posledních `--tail` řádků.
 *
 *   node training/p30/wait.mjs <soubor> [--until exit=] [--max 540] [--tail 5]
 */

import { existsSync, readFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const until = arg('until', 'exit=');
const maxMs = Number(arg('max', '540')) * 1000;
const tail = Number(arg('tail', '5'));

const started = Date.now();
const text = () => (existsSync(file) ? readFileSync(file, 'utf8') : '');
while (!text().includes(until) && Date.now() - started < maxMs) await new Promise((done) => setTimeout(done, 10_000));
const lines = text().split('\n').filter((line) => line.trim() !== '' && !/Warning|trace-warnings|Reparsing|eliminate this|deprecated parameters/.test(line));
console.log(`${text().includes(until) ? 'done' : 'waiting'} after ${String(Math.round((Date.now() - started) / 1000))} s`);
console.log(lines.slice(-tail).join('\n'));
