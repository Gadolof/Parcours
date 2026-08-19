import { launch, reporter } from './harness.mjs';

export default async function run(BASE) {
  const r = reporter('Fonctionnement hors ligne');
  const B = BASE;
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));

  // --- Aucune requête vers l'extérieur au chargement ---
  const external = [];
  page.on('request', req => { const u = new URL(req.url()); if (u.hostname !== '127.0.0.1') external.push(req.url()); });

  await page.goto(B);
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen','1'));
  r.ok('Aucune requête vers un domaine externe', external.length === 0, external.slice(0,3).join(' '));

  // --- Le service worker s'installe et précache ---
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active };
  });
  r.ok('Service worker actif', sw.active === true, sw.scope);

  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    if (!keys.length) return false;
    const c = await caches.open(keys[0]);
    return (await c.keys()).length >= 28;
  }, null, { timeout: 20000 });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return { name: keys[0], n: (await c.keys()).length };
  });
  r.ok('Coquille précachée', cached.n >= 28, `${cached.n} entrées dans ${cached.name}`);

  // --- Les polices sont bien locales ---
  const fonts = await page.evaluate(() => [...document.fonts].map(f => f.family));
  r.ok('Polices chargées localement', fonts.includes('Fraunces') && fonts.some(f => f.includes('IBM Plex')),
     [...new Set(fonts)].join(', '));

  // --- Persistance demandée ---
  // Chrome n'accorde la persistance qu'après « engagement » de l'utilisateur :
  // en headless la réponse est non, ce qui n'est pas un défaut du code. On
  // vérifie que la demande est bien faite et que l'état est exploitable.
  const persist = await page.evaluate(async () => ({
    demande: typeof window.Parcours.Offline?.requestPersistence === 'function',
    reponse: await window.Parcours.Offline.requestPersistence(),
    estime: await window.Parcours.Offline.estimate()
  }));
  r.ok('La persistance est demandée et son état lisible',
     persist.demande && typeof persist.reponse === 'boolean' && persist.estime?.quota > 0,
     `accordée=${persist.reponse}, quota=${Math.round((persist.estime?.quota||0)/1048576)} Mo`);

  // --- LE test : hors ligne, l'application démarre ---
  await ctx.setOffline(true);
  await page.goto(B).catch(() => {});
  await page.waitForTimeout(1500);
  const offline = await page.evaluate(() => ({
    booted: !!window.Parcours?.App?.root,
    depsError: document.body.textContent.includes('Fichiers manquants'),
    leaflet: typeof L !== 'undefined',
    drawflow: typeof Drawflow !== 'undefined',
    jszip: typeof JSZip !== 'undefined',
    jsqr: typeof jsQR !== 'undefined',
    styled: getComputedStyle(document.body).backgroundColor
  }));
  r.ok('HORS LIGNE — l\'application démarre', offline.booted && !offline.depsError,
     `démarré=${offline.booted}, écran d'erreur=${offline.depsError}`);
  r.ok('HORS LIGNE — les quatre bibliothèques sont là',
     offline.leaflet && offline.drawflow && offline.jszip && offline.jsqr,
     `L=${offline.leaflet} DF=${offline.drawflow} ZIP=${offline.jszip} QR=${offline.jsqr}`);
  r.ok('HORS LIGNE — la feuille de style est appliquée',
     offline.styled === 'rgb(244, 236, 223)', offline.styled);

  await page.goto(B + '#editor').catch(() => {});
  await page.waitForSelector('#graph', { timeout: 10000 }).catch(() => {});
  const edit = await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    const n = Scenario.addNode('etape', { position: { lat: 48.85, lng: 2.35 }, graphPos: { x: 40, y: 40 } });
    Editor._addToMap(n); Editor._addToGraph(n);
    return { nodes: Scenario.current.nodes.length, marker: !!Editor.markers[n.id] };
  });
  r.ok('HORS LIGNE — l\'éditeur reste utilisable', edit.nodes === 1 && edit.marker, JSON.stringify(edit));

  await ctx.setOffline(false);
  r.ok('Aucune erreur JavaScript', errs.filter(e => !/tile|ERR_/i.test(e)).length === 0, errs.slice(0,2).join(' | '));

  await browser.close();
  return r;
}
