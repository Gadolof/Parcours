import { launch, reporter } from './harness.mjs';

/** Parcours linéaire de n étapes, positionnées et reliées. */
function gros(n) {
  const nodes = [{ id: 'i', type: 'intro', title: 'Départ', graphPos: { x: 20, y: 20 } }];
  const links = [];
  for (let k = 0; k < n; k++) {
    nodes.push({
      id: 'n' + k, type: k % 3 === 0 ? 'enigme' : 'etape', title: 'Point ' + k,
      graphPos: { x: (k % 8) * 210, y: 160 + Math.floor(k / 8) * 130 },
      position: { lat: 48.85 + k * 0.001, lng: 2.35 + k * 0.0008 },
      question: 'Question ?', answer: 'Réponse',
      validation: { type: 'qr', value: 'CODE' + k }
    });
    links.push({ id: 'l' + k, source: k === 0 ? 'i' : 'n' + (k - 1), target: 'n' + k });
  }
  nodes.push({ id: 'o', type: 'outro', title: 'Fin', graphPos: { x: 20, y: 2400 } });
  links.push({ id: 'lo', source: 'n' + (n - 1), target: 'o' });
  return { id: 'charge', meta: { title: 'Parcours chargé', startNodeId: 'i' }, nodes, links, assets: [] };
}

export default async function run(BASE) {
  const r = reporter('Tenue en charge');
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));

  await page.goto(BASE);
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen', '1'));
  await page.evaluate(s => window.Parcours.Scenario.load(s), gros(120));
  await page.evaluate(() => window.Parcours.Storage.flush());
  await page.goto(BASE + '#editor');
  await page.waitForSelector('#graph');
  await page.waitForTimeout(900);

  /* ---------- Les liens sont réellement dessinés ---------- */
  // Le rebuild diffère le calcul géométrique des connexions pour éviter
  // 300 recalculs de mise en page. Si cette passe différée manquait quoi
  // que ce soit, les liens seraient invisibles — d'où ce contrôle.
  const liens = await page.evaluate(() => {
    const chemins = [...document.querySelectorAll('.drawflow .connection .main-path')];
    const d = chemins.map(p => p.getAttribute('d') || '');
    return {
      attendus: window.Parcours.Scenario.current.links.length,
      dessines: chemins.length,
      vides: d.filter(x => !x.trim()).length,
      degeneres: d.filter(x => /NaN|undefined/.test(x)).length
    };
  });
  r.ok('Chaque lien du scénario a son tracé dans le graphe',
       liens.dessines === liens.attendus, `${liens.dessines}/${liens.attendus}`);
  r.ok('Aucun tracé vide ou dégénéré',
       liens.vides === 0 && liens.degeneres === 0, `${liens.vides} vides, ${liens.degeneres} dégénérés`);

  /* ---------- Coût du rebuild ---------- */
  const rebuild = await page.evaluate(() => {
    const t0 = performance.now();
    window.Parcours.Editor.rebuild();
    return Math.round(performance.now() - t0);
  });
  // Seuil large : il s'agit d'attraper une régression d'ordre de grandeur,
  // pas de mesurer la machine.
  r.ok('Un parcours de 120 étapes se reconstruit sous la seconde', rebuild < 1000, `${rebuild} ms`);

  /* ---------- Une frappe ne redessine pas la carte ---------- */
  const frappe = await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    let redessins = 0;
    const vrai = Editor.drawRoute.bind(Editor);
    Editor.drawRoute = () => { redessins++; return vrai(); };
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { Scenario.touch('meta:title'); Scenario.emit('metaUpdated'); }
    const ms = (performance.now() - t0) / 20;
    Editor.drawRoute = vrai;
    return { redessins, ms: Math.round(ms * 100) / 100 };
  });
  r.ok('Éditer les métadonnées ne redessine pas le tracé', frappe.redessins === 0, `${frappe.redessins} redessins`);
  r.ok('Une frappe de métadonnée reste sous 3 ms', frappe.ms < 3, `${frappe.ms} ms`);

  /* ---------- L'historique regroupe les frappes ---------- */
  const hist = await page.evaluate(() => {
    const { Scenario, History } = window.Parcours;
    History.reset();
    const n = Scenario.current.nodes[1];
    for (const c of 'Le vieux lavoir') { n.title += c; Scenario.touch(`${n.id}:title`); }
    const apresSaisie = History._passe.length;
    History.cloreGroupe();
    n.description = 'x'; Scenario.touch(`${n.id}:description`);
    return { apresSaisie, apresAutreChamp: History._passe.length };
  });
  r.ok('Une saisie continue ne fait qu\'une entrée d\'historique',
       hist.apresSaisie === 1, `${hist.apresSaisie} entrée(s) pour 15 frappes`);
  r.ok('Changer de champ ouvre une nouvelle entrée',
       hist.apresAutreChamp === 2, `${hist.apresAutreChamp} entrées`);

  const annule = await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    const avant = Scenario.getNode(Scenario.current.nodes[1].id).title;
    Editor.annuler();   // annule la description
    Editor.annuler();   // annule toute la saisie du titre
    return { avant, apres: Scenario.current.nodes[1].title };
  });
  r.ok('Une seule annulation efface tout le mot tapé',
       annule.apres === 'Point 0', `« ${annule.avant} » → « ${annule.apres} »`);

  r.ok('Aucune erreur JavaScript', errs.filter(e => !/tile|ERR_/i.test(e)).length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();
  return r;
}
