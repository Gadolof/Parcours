import { launch, reporter } from './harness.mjs';

export default async function run(BASE) {
  const r = reporter('Outils de l\'auteur (jalon 3)');
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e.stack || e)));

  await page.goto(BASE);
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen', '1'));

  /* ---------- Un parcours de démonstration ---------- */
  const DEMO = {
    id: 'demo3', meta: { title: 'Le bois des Ardennes', startNodeId: 'i' },
    nodes: [
      { id: 'i', type: 'intro', title: 'Départ', graphPos: { x: 30, y: 30 }, setsFlags: ['briefing'] },
      { id: 'b', type: 'etape', title: 'La borne 47', graphPos: { x: 30, y: 170 },
        position: { lat: 48.8566, lng: 2.3522 }, validation: { type: 'qr', value: 'BORNE47' }, setsFlags: ['lampe'] },
      { id: 'q', type: 'enigme', title: 'Le chêne creux', graphPos: { x: 250, y: 170 },
        position: { lat: 48.8606, lng: 2.3376 }, question: 'Combien ?', answer: 'Sept' },
      { id: 'c', type: 'checkpoint', title: 'La grille', graphPos: { x: 250, y: 300 },
        position: { lat: 48.8620, lng: 2.3300 }, requiresFlags: ['lampe'], validation: { type: 'none' } },
      { id: 'o', type: 'outro', title: 'Refuge', graphPos: { x: 460, y: 300 } }
    ],
    links: [
      { id: 'l1', source: 'i', target: 'b' }, { id: 'l2', source: 'b', target: 'q' },
      { id: 'l3', source: 'q', target: 'c' }, { id: 'l4', source: 'c', target: 'o' }
    ],
    assets: []
  };
  // `window.__demo` disparaît à chaque navigation : on le repose ensuite.
  const semer = () => page.evaluate(d => { window.__demo = d; }, DEMO);
  await semer();
  await page.evaluate(d => window.Parcours.Scenario.load(JSON.parse(JSON.stringify(d))), DEMO);
  await page.evaluate(() => window.Parcours.Storage.flush());
  await page.goto(BASE + '#editor');
  await page.waitForSelector('#graph');
  await semer();
  await page.waitForTimeout(700);

  /* ---------- B10 : numérotation par ordre de parcours ---------- */
  const numeros = await page.evaluate(() => {
    const { Editor } = window.Parcours;
    return Object.fromEntries(Object.entries(Editor.markers).map(([id, m]) => [id, m._icon?.textContent]));
  });
  r.ok('Les marqueurs sont numérotés dans l\'ordre du parcours',
       numeros.b === '2' && numeros.q === '3' && numeros.c === '4', JSON.stringify(numeros));

  /* ---------- 3.5 : tracé et distance ---------- */
  const trace = await page.evaluate(() => {
    const { Editor } = window.Parcours;
    let n = 0, couleurs = [];
    Editor._routeLayer?.eachLayer(l => { n++; couleurs.push(l.options.color); });
    return { n, couleurs, info: document.querySelector('#route-info')?.textContent };
  });
  r.ok('Le parcours est tracé sur la carte', trace.n === 2, `${trace.n} segment(s)`);
  r.ok('Les couleurs sont résolues, pas des tokens CSS',
       trace.couleurs.every(c => /^#[0-9a-f]{6}$/i.test(c)), trace.couleurs.join(' '));
  r.ok('La longueur du parcours est affichée', /km|m$/.test(trace.info || ''), trace.info);

  /* ---------- 3.2 : vérification ---------- */
  const check = await page.evaluate(() => {
    const { Inspector } = window.Parcours;
    Inspector.setTab('scenario');
    const items = [...document.querySelectorAll('.check-item')].map(e => e.textContent);
    return { items, ok: !!document.querySelector('.check-ok') };
  });
  r.ok('Le parcours de démonstration passe la vérification',
       check.ok === true && check.items.length === 0, check.items.join(' | '));

  const casse = await page.evaluate(() => {
    const { Scenario, Inspector } = window.Parcours;
    Scenario.updateNode('b', { validation: { type: 'qr', value: '' } });   // QR sans valeur
    Scenario.updateNode('q', { answer: '' });                              // énigme sans réponse
    Scenario.addNode('etape', { title: 'Orphelin' });                      // inatteignable
    Inspector.setTab('scenario');
    const items = [...document.querySelectorAll('.check-item')];
    return {
      textes: items.map(e => e.textContent),
      cliquables: items.filter(e => e.classList.contains('clickable')).length,
      erreurs: items.filter(e => e.classList.contains('erreur')).length
    };
  });
  r.ok('Les anomalies sont détectées', casse.textes.length >= 4, `${casse.textes.length} anomalies`);
  r.ok('Le QR sans valeur est signalé', casse.textes.some(t => /contenu de QR/i.test(t)));
  r.ok('L\'énigme sans réponse est signalée', casse.textes.some(t => /pas de réponse attendue/i.test(t)));
  r.ok('Le nœud inatteignable est signalé', casse.textes.some(t => /atteignable/i.test(t)));
  r.ok('Les anomalies liées à un nœud sont cliquables', casse.cliquables >= 3, `${casse.cliquables} cliquables`);

  const saut = await page.evaluate(() => {
    document.querySelectorAll('.check-item.clickable')[0].click();
    return window.Parcours.Editor.selectedNodeId;
  });
  r.ok('Cliquer une anomalie sélectionne le nœud fautif', !!saut, `nœud ${saut}`);

  /* ---------- 3.3 : annuler / rétablir ---------- */
  const undo = await page.evaluate(async () => {
    const { Scenario, Editor, History } = window.Parcours;
    Scenario.load(JSON.parse(JSON.stringify(window.__demo)));
    await new Promise(d => setTimeout(d, 100));
    const avant = Scenario.current.nodes.length;
    Scenario.addNode('etape', { title: 'Ajout à annuler' });
    const apres = Scenario.current.nodes.length;
    const peut = History.peutAnnuler;
    Editor.annuler();
    const annule = Scenario.current.nodes.length;
    Editor.retablir();
    const retabli = Scenario.current.nodes.length;
    return { avant, apres, peut, annule, retabli };
  });
  r.ok('Annuler retire l\'ajout', undo.peut && undo.annule === undo.avant,
       `${undo.avant} → ${undo.apres} → ${undo.annule}`);
  r.ok('Rétablir le remet', undo.retabli === undo.apres, `${undo.annule} → ${undo.retabli}`);

  const undoBtn = await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    Scenario.updateNode('b', { title: 'Titre modifié' });
    const actif = !document.querySelector('#undo-btn').disabled;
    Editor.annuler();
    return { actif, titre: Scenario.getNode('b')?.title };
  });
  r.ok('Le bouton Annuler reflète l\'historique', undoBtn.actif === true);
  r.ok('Annuler restaure le titre précédent', undoBtn.titre === 'La borne 47', `titre : ${undoBtn.titre}`);

  const undoSuite = await page.evaluate(() => {
    const { Scenario, Editor } = window.Parcours;
    Scenario.updateNode('b', { title: 'A' });
    Scenario.updateNode('b', { title: 'AB' });
    Scenario.updateNode('b', { title: 'ABC' });
    Editor.annuler(); Editor.annuler();
    return Scenario.getNode('b')?.title;
  });
  r.ok('Plusieurs annulations d\'affilée fonctionnent', undoSuite === 'A', `titre : ${undoSuite}`);

  /* ---------- 3.1 : QR ---------- */
  const qr = await page.evaluate(() => {
    const { QR, Scenario } = window.Parcours;
    Scenario.load(JSON.parse(JSON.stringify(window.__demo)));
    const svg = QR.svg('BORNE47', { taille: 120 });
    const codes = new Set(Array.from({ length: 200 }, () => QR.code()));
    return {
      balise: svg.tagName,
      chemins: svg.querySelectorAll('path').length,
      viewBox: svg.getAttribute('viewBox'),
      aImprimer: QR.nodesToPrint(Scenario.current).length,
      codeLongueur: QR.code().length,
      codeAlphabet: /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(QR.code()),
      uniques: codes.size
    };
  });
  r.ok('Le QR est rendu en SVG', qr.balise === 'svg' && qr.chemins === 1, `viewBox ${qr.viewBox}`);
  r.ok('La planche recense les nœuds à QR', qr.aImprimer === 1, `${qr.aImprimer} nœud(s)`);
  r.ok('Les codes générés évitent les caractères ambigus', qr.codeAlphabet && qr.codeLongueur === 6);
  r.ok('Les codes générés ne se répètent pas', qr.uniques === 200, `${qr.uniques}/200 uniques`);

  const planche = await page.evaluate(() => {
    const { QR, Scenario } = window.Parcours;
    QR.printSheet(Scenario.current);
    const sheet = document.getElementById('qr-sheet');
    const res = {
      existe: !!sheet,
      cartes: sheet?.querySelectorAll('.qr-card').length,
      valeur: sheet?.querySelector('.qr-value')?.textContent,
      titre: sheet?.querySelector('.qr-title')?.textContent,
      classe: document.body.classList.contains('printing')
    };
    document.body.classList.remove('printing');
    sheet?.remove();
    return res;
  });
  r.ok('La planche à imprimer est construite', planche.existe && planche.cartes === 1, `${planche.cartes} carte(s)`);
  r.ok('Chaque carte porte le code en clair', planche.valeur === 'BORNE47' && planche.titre === 'La borne 47',
       `${planche.titre} / ${planche.valeur}`);

  /* ---------- Le QR produit se relit avec le décodeur du joueur ---------- */
  const relecture = await page.evaluate(async () => {
    const { QR } = window.Parcours;
    const lire = async (texte) => {
      const svg = QR.svg(texte, { taille: 260 });
      const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 260;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 260, 260);
      ctx.drawImage(img, 0, 0, 260, 260);
      URL.revokeObjectURL(url);
      const data = ctx.getImageData(0, 0, 260, 260);
      return jsQR(data.data, data.width, data.height)?.data ?? null;
    };
    return {
      simple: await lire('BORNE47'),
      accents: await lire('Église-Château'),
      genere: await (async () => { const c = QR.code(); return (await lire(c)) === c; })()
    };
  });
  r.ok('Le QR imprimé se relit avec jsQR', relecture.simple === 'BORNE47', `lu : ${relecture.simple}`);
  // Un QR accentué s'encode, mais le décodeur embarqué le rend vide : le
  // scan ne correspondrait jamais. C'est pour cela que la vérification
  // refuse ces valeurs plutôt que de laisser l'auteur le découvrir dehors.
  r.ok('Un QR accentué ne se relit pas — d\'où le garde-fou', !relecture.accents, `lu : "${relecture.accents}"`);
  r.ok('Un code généré se relit à l\'identique', relecture.genere === true);

  const garde = await page.evaluate(() => {
    const { Scenario, Inspector } = window.Parcours;
    Scenario.load(JSON.parse(JSON.stringify(window.__demo)));
    Scenario.updateNode('b', { validation: { type: 'qr', value: 'Église' } });
    Inspector.setTab('scenario');
    return [...document.querySelectorAll('.check-item.erreur')].map(e => e.textContent);
  });
  r.ok('La vérification refuse un QR que le scanner ne relira pas',
       garde.some(t => /scanner ne relit pas/i.test(t)), garde.join(' | '));

  /* ---------- B5 : les flags fonctionnent enfin ---------- */
  await page.goto(BASE + '#player');
  await semer();
  await page.waitForSelector('.play-start-card');
  await page.fill('.big-input', 'Les Lynx');
  await page.click('.btn-huge.accent');
  await page.waitForTimeout(300);

  const progression = await page.evaluate(() => ({
    total: document.querySelector('.play-progress span:last-child')?.textContent,
    noeuds: window.Parcours.Scenario.current.nodes.length
  }));
  r.ok('Le dénominateur suit le chemin, pas le nombre de nœuds',
       progression.total === '5' && progression.noeuds === 5, `${progression.total} / ${progression.noeuds} nœuds`);

  await page.click('.play-validation .btn-huge');       // intro → pose « briefing »
  await page.waitForTimeout(300);
  const apresIntro = await page.evaluate(() => window.Parcours.Player.state.flags);
  r.ok('Un nœud pose ses flags à la complétion', apresIntro.includes('briefing'), apresIntro.join(', '));

  /* ---------- Checkpoint verrouillé puis franchi ---------- */
  const bloque = await page.evaluate(async () => {
    const { Player } = window.Parcours;
    Player.state.flags = ['briefing'];          // « lampe » manque
    Player._enterNode('c');
    await new Promise(d => setTimeout(d, 250));
    return {
      lignes: [...document.querySelectorAll('.flag-line')].map(e => e.textContent.trim()),
      acquis: document.querySelectorAll('.flag-line.acquis').length,
      avertissement: document.querySelector('.play-validation .play-status.warn')?.textContent
    };
  });
  r.ok('Le checkpoint se referme quand il manque un flag',
       /manque/i.test(bloque.avertissement || ''), bloque.avertissement);
  r.ok('Il dit ce qui manque', bloque.lignes.some(l => l.includes('lampe')) && bloque.acquis === 0,
       bloque.lignes.join(' | '));

  const franchi = await page.evaluate(async () => {
    const { Player } = window.Parcours;
    Player.state.flags = ['briefing', 'lampe'];
    Player._renderNode();
    await new Promise(d => setTimeout(d, 250));
    return {
      bloquant: !!document.querySelector('.flag-line'),
      bouton: document.querySelector('.play-validation .btn-huge')?.textContent
    };
  });
  r.ok('Avec le flag, le checkpoint s\'ouvre', !franchi.bloquant, `bouton : ${franchi.bouton}`);

  /* ---------- Routage par flag ---------- */
  const routage = await page.evaluate(async () => {
    const { Scenario, Player } = window.Parcours;
    Scenario.load({
      id: 'flagroute', meta: { title: 'Routage', startNodeId: 'a' },
      nodes: [
        { id: 'a', type: 'etape', title: 'Porte', validation: { type: 'none' } },
        { id: 'secret', type: 'etape', title: 'Passage secret', validation: { type: 'none' } },
        { id: 'normal', type: 'outro', title: 'Sortie normale' }
      ],
      links: [
        { id: 'l1', source: 'a', target: 'secret', condition: { type: 'flag', value: 'lampe' } },
        { id: 'l2', source: 'a', target: 'normal' }
      ],
      assets: []
    });
    Player.scenario = Scenario.current;
    Player.state = window.Parcours.PlayerState.create(Scenario.current, 'Test', true);
    Player.state.flags = ['lampe'];
    Player._enterNode('a');
    Player._completeNode(null, true);
    return Player.state.currentNodeId;
  });
  r.ok('Une condition « si flag » achemine enfin quelque part', routage === 'secret', `nœud atteint : ${routage}`);

  /* ---------- 3.8 : comparer plusieurs équipes ---------- */
  await page.goto(BASE + '#results');
  await page.waitForSelector('.upload-drop');
  const classement = await page.evaluate(async () => {
    const { Results } = window.Parcours;
    const equipe = (nom, duree, essais) => ({
      version: '0.2', scenarioId: 'demo3', scenarioTitle: 'Le bois des Ardennes',
      teamName: nom, testMode: false, durationSec: duree, totalSteps: 4, totalAttempts: essais,
      path: Array.from({ length: 4 }, (_, i) => ({
        nodeId: 'n' + i, title: 'Étape ' + i, type: 'etape',
        durationSec: Math.round(duree / 4), attempts: i === 2 ? essais - 3 : 1
      }))
    });
    const fichiers = [
      new File([JSON.stringify(equipe('Les Lynx', 1500, 4))], 'lynx.json', { type: 'application/json' }),
      new File([JSON.stringify(equipe('Les Blaireaux', 900, 7))], 'blaireaux.json', { type: 'application/json' }),
      new File([JSON.stringify(equipe('Les Chouettes', 1100, 4))], 'chouettes.json', { type: 'application/json' })
    ];
    await Results._lireFichiers(fichiers);
    await new Promise(d => setTimeout(d, 200));
    return {
      rangs: [...document.querySelectorAll('.ranking-row .equipe')].map(e => e.textContent),
      etapes: [...document.querySelectorAll('.step-row .titre')].map(e => e.textContent),
      premier: document.querySelector('.ranking-row.premier .equipe')?.textContent
    };
  });
  r.ok('Le classement ordonne par erreurs puis par temps',
       classement.rangs[0] === 'Les Chouettes' && classement.rangs[2] === 'Les Blaireaux',
       classement.rangs.join(' < '));
  r.ok('La première équipe est mise en avant', classement.premier === 'Les Chouettes', classement.premier);
  r.ok('Les étapes où ça a bloqué sont listées', classement.etapes.length === 4, `${classement.etapes.length} étapes`);

  r.ok('Aucune erreur JavaScript', errs.filter(e => !/tile|ERR_/i.test(e)).length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();
  return r;
}
