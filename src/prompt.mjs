import fs from 'node:fs';
import readline from 'node:readline/promises';

let rl = null;
// Liest Antworten von der Tastatur, auch wenn stdin umgeleitet ist
function open() {
  if (rl) return rl;
  let input = process.stdin;
  if (!process.stdin.isTTY) {
    try { input = fs.createReadStream('/dev/tty'); } catch { input = process.stdin; }
  }
  rl = readline.createInterface({ input, output: process.stdout });
  return rl;
}

export async function ask(question, fallback = '') {
  const answer = (await open().question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return answer || fallback;
}

export async function confirm(question, yes = false) {
  if (yes) return true;
  const a = (await ask(`${question} (j/n)`, 'n')).toLowerCase();
  return a === 'j' || a === 'ja' || a === 'y';
}

export async function choose(question, options, fallback) {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const a = await ask('Auswahl (Nummern, mit Komma)', fallback);
  return a.split(',').map((s) => options[Number(s.trim()) - 1]).filter(Boolean).map((o) => o.value);
}

export function close() { rl?.close(); rl = null; }
