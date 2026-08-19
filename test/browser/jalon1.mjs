import { launch, reporter } from './harness.mjs';

export default async function run(BASE) {
  const r = reporter('Correctifs du jalon 1');
  const B = BASE;

  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE);
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen', '1'));
  await page.goto(BASE + '#editor');
  await page.waitForSelector('#graph');
  await page.waitForTimeout(400);

  /* ---------- B2 : le focus survit à la saisie ---------- */
  await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    const n = Scenario.addNode('etape', { position: { lat: 48.85, lng: 2.35 }, graphPos: { x: 40, y: 40 } });
    Editor._addToMap(n); Editor._addToGraph(n); Editor.selectNode(n.id);
  });
  await page.waitForTimeout(200);
  const titleInput = page.locator('.inspector .form input').first();
  await titleInput.click();
  await titleInput.fill('');
  await page.keyboard.type('Le vieux lavoir', { delay: 20 });
  const b2 = await page.evaluate(() => ({
    value: document.querySelector('.inspector .form input')?.value,
    stillFocused: document.activeElement?.tagName === 'INPUT',
    stored: window.Parcours.Scenario.current.nodes[0].title,
    header: document.querySelector('.inspector .node-header h2')?.textContent
  }));
  r.ok('B2 — le titre saisi arrive entier', b2.stored === 'Le vieux lavoir', `stocké: "${b2.stored}"`);
  r.ok('B2 — le focus reste dans le champ', b2.stillFocused === true);
  r.ok('B2 — l\'en-tête suit sans re-render', b2.header === 'Le vieux lavoir', `en-tête: "${b2.header}"`);

  /* ---------- B7 : pas de position fantôme ---------- */
  await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    const n = Scenario.addNode('enigme', { graphPos: { x: 40, y: 260 } }); // sans position
    Editor._addToGraph(n); Editor.selectNode(n.id); // ouvre l'onglet Nœud
  });
  await page.waitForTimeout(250);
  const b7 = await page.evaluate(() => ({
    mapCount: document.querySelector('#map-count')?.textContent,
    position: window.Parcours.Scenario.current.nodes[1].position
  }));
  r.ok('B7 — le compteur carte ne compte pas le nœud sans position', b7.mapCount === '1', `compteur: ${b7.mapCount}`);
  r.ok('B7 — aucune position fantôme écrite', b7.position === null, `position: ${JSON.stringify(b7.position)}`);

  /* ---------- B4 : Suppr dans un champ ne détruit rien ---------- */
  await page.evaluate(() => window.Parcours.Editor.selectNode(window.Parcours.Scenario.current.nodes[0].id));
  await page.waitForTimeout(150);
  await page.locator('.inspector .form input').first().click();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  const survived = await page.evaluate(() => window.Parcours.Scenario.current.nodes.length);
  r.ok('B4 — Suppr dans un champ ne supprime pas le nœud', survived === 2, `nœuds: ${survived}`);

  /* ---------- B4 : Suppr dans le graphe supprime partout ---------- */
  const targetId = await page.evaluate(() => window.Parcours.Scenario.current.nodes[0].id);
  const dfId = await page.evaluate(id => window.Parcours.Editor.drawflowIdByNodeId[id], targetId);
  await page.locator('#node-' + dfId).click();          // vrai clic souris
  await page.waitForTimeout(150);
  const selected = await page.evaluate(() => !!window.Parcours.Editor.drawflow.node_selected);
  await page.keyboard.press('Delete');                   // vraie frappe clavier
  await page.waitForTimeout(300);
  const b4 = await page.evaluate(id => ({
    inScenario: window.Parcours.Scenario.current.nodes.some(n => n.id === id),
    inGraph: !!document.getElementById('node-' + window.Parcours.Editor.drawflowIdByNodeId[id]),
    marker: !!window.Parcours.Editor.markers[id],
    mapCount: document.querySelector('#map-count')?.textContent
  }), targetId);
  r.ok('B4 — le clic sélectionne bien le nœud dans Drawflow', selected === true);
  r.ok('B4 — Suppr retire le nœud du scénario', b4.inScenario === false);
  r.ok('B4 — Suppr retire le marqueur de la carte', b4.marker === false && b4.mapCount === '0', `compteur: ${b4.mapCount}`);

  /* ---------- B3 : pas d'accumulation d'abonnés ---------- */
  const counts = [];
  for (let i = 0; i < 4; i++) {
    await page.goto(BASE + '#home'); await page.waitForSelector('.view-home');
    await page.goto(BASE + '#editor'); await page.waitForSelector('#graph');
    await page.waitForTimeout(150);
    counts.push(await page.evaluate(() => window.Parcours.Scenario.listeners.size));
  }
  r.ok('B3 — le nombre d\'abonnés est stable', new Set(counts).size === 1, `relevés: ${counts.join(', ')}`);

  /* ---------- B1 : import d'un ZIP depuis l'accueil ---------- */
  await page.goto(BASE + '#home');
  await page.waitForSelector('.view-home');
  const b1 = await page.evaluate(async () => {
    const zip = new JSZip();
    zip.file('scenario.json', JSON.stringify({
      id: 'scn_importe', meta: { title: 'Parcours importé', startNodeId: 'a' },
      nodes: [{ id: 'a', type: 'intro', title: 'Départ' }, { id: 'b', type: 'outro', title: 'Fin' }],
      links: [{ id: 'l', source: 'a', target: 'b' }], assets: []
    }));
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'test.zip', { type: 'application/zip' });
    const ok = await window.Parcours.IO.importZip(file);
    await new Promise(done => setTimeout(done, 200));
    return {
      ok,
      title: window.Parcours.Scenario.current.meta.title,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent)
    };
  });
  r.ok('B1 — l\'import réussit', b1.ok === true && b1.title === 'Parcours importé', `titre: ${b1.title}`);
  r.ok('B1 — aucun message « corrompu »', !b1.toasts.some(t => /corrompu/i.test(t)), b1.toasts.join(' | '));

  await page.waitForTimeout(400);
  await page.goto(BASE + '#editor');
  await page.waitForSelector('#graph');
  await page.waitForTimeout(300);
  const rebuilt = await page.evaluate(() => Object.keys(window.Parcours.Editor.drawflowIdByNodeId).length);
  r.ok('B1 — le scénario importé se reconstruit dans l\'éditeur', rebuilt === 2, `nœuds au graphe: ${rebuilt}`);

  /* ---------- B6 : une mauvaise réponse ne fait plus avancer ---------- */
  await page.evaluate(() => {
    const { Scenario } = window.Parcours;
    Scenario.load({
      id: 'scn_b6', meta: { title: 'Test énigme', startNodeId: 'q' },
      nodes: [
        { id: 'q', type: 'enigme', title: 'La question', question: 'Combien ?', answer: 'Sept' },
        { id: 'f', type: 'outro', title: 'Fin' }
      ],
      links: [{ id: 'l', source: 'q', target: 'f' }],  // un seul lien, inconditionnel
      assets: []
    });
  });
  await page.goto(BASE + '#player');
  await page.waitForSelector('.play-start-card');
  await page.fill('.big-input', 'Rouge');
  await page.click('.btn-huge.accent');
  await page.waitForTimeout(300);
  await page.fill('.play-validation .big-input', 'quarante-deux');
  await page.click('.play-validation .btn-huge');
  await page.waitForTimeout(400);
  const b6 = await page.evaluate(() => ({
    current: window.Parcours.Player.state?.currentNodeId,
    ended: window.Parcours.Player.state?.ended,
    attempts: window.Parcours.Player.state?.history?.at(-1)?.attempts,
    retryVisible: !!document.querySelector('.play-validation .play-status.warn')?.textContent
  }));
  r.ok('B6 — le joueur reste sur l\'énigme', b6.current === 'q' && !b6.ended, `nœud: ${b6.current}, fini: ${b6.ended}`);
  r.ok('B6 — la tentative est comptée', b6.attempts === 1, `essais: ${b6.attempts}`);
  r.ok('B6 — un message de réessai s\'affiche', b6.retryVisible === true);

  await page.fill('.play-validation .big-input', '  sept ');
  await page.click('.play-validation .btn-huge');
  await page.waitForTimeout(400);
  const b6b = await page.evaluate(() => ({
    current: window.Parcours.Player.state?.currentNodeId,
    attempts: window.Parcours.Player.state?.history?.[0]?.attempts
  }));
  r.ok('B6 — la bonne réponse (accents/casse ignorés) fait avancer', b6b.current === 'f', `nœud: ${b6b.current}`);
  r.ok('B6 — les essais ratés sont conservés dans l\'historique', b6b.attempts === 2, `essais: ${b6b.attempts}`);

  /* ---------- Bilan ---------- */
  const realErrors = errors.filter(e => !/tile|Failed to load resource|net::ERR|favicon/i.test(e));
  r.ok('Aucune erreur JavaScript', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));

  await browser.close();
  return r;
}
