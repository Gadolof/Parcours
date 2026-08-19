/* Suites de bout en bout — Chromium pilote l'application réelle.
   `npm test` (tests du noyau) ne dépend de rien ; celles-ci ont besoin de
   playwright-core et d'un Chromium : `npm run test:browser`. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { serve } from './serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SUITES = ['jalon1.mjs', 'layout.mjs', 'offline.mjs', 'assets.mjs', 'jalon3.mjs'];

const { server, port } = await serve(ROOT);
const BASE = `http://127.0.0.1:${port}/index.html`;
console.log(`Dépôt servi sur http://127.0.0.1:${port}`);

let failures = 0, total = 0;
for (const suite of SUITES) {
  const { default: run } = await import(`./${suite}`);
  try {
    const r = await run(BASE);
    failures += r.failures;
    total += r.total;
  } catch (e) {
    console.error(`  FAIL  ${suite} a levé une exception :`, e.message);
    failures++; total++;
  }
}

server.close();
console.log(`\n${total - failures}/${total} vérifications passées`);
process.exit(failures ? 1 : 0);
