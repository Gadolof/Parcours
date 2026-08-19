import { chromium } from 'playwright-core';

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome'
].filter(Boolean);

export async function launch() {
  const { existsSync } = await import('node:fs');
  const executablePath = CHROMIUM_CANDIDATES.find(p => existsSync(p));
  return chromium.launch(executablePath ? { executablePath } : {});
}

/** Petit collecteur de résultats, partagé par les suites. */
export function reporter(titre) {
  const res = [];
  console.log(`\n▸ ${titre}`);
  return {
    ok(nom, condition, detail = '') {
      res.push(!!condition);
      console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${nom}${detail ? '  — ' + detail : ''}`);
    },
    get failures() { return res.filter(r => !r).length; },
    get total() { return res.length; }
  };
}
