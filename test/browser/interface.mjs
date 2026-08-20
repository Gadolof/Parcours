import { launch, reporter } from './harness.mjs';

const PARCOURS = {
  id: 'ui', meta: { title: 'Le bois des Ardennes', startNodeId: 'i', showMapToPlayers: false },
  nodes: [
    { id: 'i', type: 'intro', title: 'Départ', graphPos: { x: 20, y: 20 } },
    { id: 'b', type: 'etape', title: 'La borne 47', graphPos: { x: 20, y: 160 },
      position: { lat: 48.8566, lng: 2.3522 }, validation: { type: 'code', value: 'K7RQM2' } },
    { id: 'q', type: 'enigme', title: 'Le chêne creux', question: 'Combien ?', answer: 'Sept',
      graphPos: { x: 240, y: 160 }, position: { lat: 48.8606, lng: 2.3376 } },
    { id: 'o', type: 'outro', title: 'Refuge', graphPos: { x: 240, y: 300 } }
  ],
  links: [{ id: 'l1', source: 'i', target: 'b' }, { id: 'l2', source: 'b', target: 'q' }, { id: 'l3', source: 'q', target: 'o' }],
  assets: []
};

export default async function run(BASE) {
  const r = reporter('Interface et lisibilité');
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));

  // On vise explicitement #home : sinon l'application y navigue elle-même
  // et l'évaluation suivante tombe pendant le changement de contexte.
  await page.goto(BASE + '#home');
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.waitForSelector('.home-hero');
  await page.waitForTimeout(400);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen', '1'));

  /* ---------- Les propriétés CSS personnalisées passent bien ---------- */
  const custom = await page.evaluate(() => {
    const d = document.createElement('div');
    // même chemin que el() : un objet de styles contenant une variable
    const e = window.Parcours.Toast.container;
    d.style.setProperty('--sonde', 'ok');
    return { direct: d.style.getPropertyValue('--sonde'), conteneur: !!e };
  });
  r.ok('Le navigateur accepte les propriétés personnalisées', custom.direct === 'ok');

  /* ---------- Accueil : pas de doublon, pas de fausse séquence ---------- */
  const accueilVide = await page.evaluate(() => {
    const cartes = [...document.querySelectorAll('.home-card')];
    return {
      n: cartes.length,
      titres: cartes.map(c => c.querySelector('h3').textContent),
      rangs: cartes.map(c => c.querySelector('.num').textContent),
      principale: document.querySelectorAll('.home-card.primary').length
    };
  });
  r.ok('Sans travail en cours, aucune carte « Reprendre »',
       !accueilVide.rangs.includes('Reprendre'), accueilVide.rangs.join(' · '));
  r.ok('Deux cartes ne portent pas le même titre',
       new Set(accueilVide.titres).size === accueilVide.titres.length, accueilVide.titres.join(' | '));
  r.ok('Les libellés ne numérotent plus une séquence inexistante',
       accueilVide.rangs.every(t => !/^\d/.test(t)), accueilVide.rangs.join(' · '));
  r.ok('Une seule carte est mise en avant', accueilVide.principale === 1);

  /* ---------- Avec un scénario : la carte « Reprendre » apparaît ---------- */
  await page.evaluate(s => window.Parcours.Scenario.load(s), PARCOURS);
  await page.evaluate(() => window.Parcours.Storage.setCurrent(window.Parcours.Scenario.current.id));
  await page.evaluate(() => window.Parcours.Storage.flush());
  // reload() et non goto() : vers la même URL avec le même fragment, le
  // navigateur ne recharge rien et l'accueil resterait tel qu'il était.
  await page.reload();
  await page.waitForSelector('.home-card');
  await page.waitForTimeout(500);
  const accueilPlein = await page.evaluate(() => {
    const cartes = [...document.querySelectorAll('.home-card')];
    const grille = getComputedStyle(document.querySelector('.home-actions')).gridTemplateColumns.split(' ').length;
    return {
      rangs: cartes.map(c => c.querySelector('.num').textContent),
      colonnes: grille, n: cartes.length,
      texte: cartes[0].querySelector('p').textContent
    };
  });
  r.ok('Le scénario en cours se reprend depuis l\'accueil',
       accueilPlein.rangs[0] === 'Reprendre', accueilPlein.rangs.join(' · '));
  r.ok('Les quatre cartes tiennent sur une seule ligne',
       accueilPlein.n === 4 && accueilPlein.colonnes === 4, `${accueilPlein.n} cartes, ${accueilPlein.colonnes} colonnes`);
  r.ok('Les pluriels sont écrits en français',
       !/\(s\)/.test(accueilPlein.texte) && /4 nœuds, 3 liens/.test(accueilPlein.texte), accueilPlein.texte);

  /* ---------- Éditeur : l'en-tête de carte n'est plus percuté ---------- */
  await page.goto(BASE + '#editor');
  await page.waitForSelector('#graph');
  await page.waitForTimeout(800);
  const enTete = await page.evaluate(() => {
    const h = document.querySelector('#pane-map .pane-header').getBoundingClientRect();
    const zoom = document.querySelector('#map .leaflet-control-zoom').getBoundingClientRect();
    const chevauche = !(h.right < zoom.left || h.left > zoom.right || h.bottom < zoom.top || h.top > zoom.bottom);
    // Le libellé complet doit être lisible, pas rogné.
    const el = document.querySelector('#pane-map .pane-header');
    return { chevauche, coupe: el.scrollWidth > el.clientWidth + 1, texte: el.textContent.trim().slice(0, 20) };
  });
  r.ok('L\'en-tête de la carte ne croise plus les boutons de zoom', !enTete.chevauche);
  r.ok('Son libellé n\'est pas rogné', !enTete.coupe, enTete.texte);

  /* ---------- Cadrer sur le parcours ---------- */
  const cadrage = await page.evaluate(() => {
    const { Editor } = window.Parcours;
    Editor.map.setView([0, 0], 3, { animate: false });
    const avant = Editor.map.getCenter();
    Editor.fitToRoute();
    const apres = Editor.map.getCenter();
    return { avantLat: avant.lat, apresLat: Math.round(apres.lat * 100) / 100, zoom: Editor.map.getZoom() };
  });
  r.ok('« Cadrer » ramène la carte sur les nœuds',
       Math.abs(cadrage.apresLat - 48.86) < 0.2 && cadrage.zoom > 8,
       `${cadrage.avantLat} → ${cadrage.apresLat} (zoom ${cadrage.zoom})`);

  /* ---------- Une énigme n'expose pas de validation morte ---------- */
  const enigme = await page.evaluate(() => {
    const { Editor, Scenario } = window.Parcours;
    Editor.selectNode('q');
    const titres = [...document.querySelectorAll('.inspector-section h3')].map(h => h.textContent.replace(/\s+/g, ' ').trim());
    const nouvelle = Scenario.addNode('enigme');
    return { titres, validationNouvelle: nouvelle.validation, validationChargee: Scenario.getNode('q').validation };
  });
  r.ok('L\'inspecteur d\'une énigme ne propose pas de validation par QR',
       !enigme.titres.some(t => t.startsWith('Validation')), enigme.titres.join(' | '));
  r.ok('La section Énigme passe avant les autres',
       enigme.titres.indexOf('Énigme') === 1, enigme.titres.join(' | '));
  r.ok('Une énigme neuve ne porte aucune validation',
       !enigme.validationNouvelle && !enigme.validationChargee,
       JSON.stringify(enigme));

  /* ---------- Hiérarchie : la section domine ses étiquettes ---------- */
  const hierarchie = await page.evaluate(() => {
    const section = getComputedStyle(document.querySelector('.inspector-section h3'));
    const label = getComputedStyle(document.querySelector('.inspector .field label'));
    const lum = c => { const [r, g, b] = c.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    return {
      grasSection: Number(section.fontWeight), grasLabel: Number(label.fontWeight),
      lumSection: Math.round(lum(section.color)), lumLabel: Math.round(lum(label.color))
    };
  });
  r.ok('Le titre de section est plus gras que les étiquettes',
       hierarchie.grasSection > hierarchie.grasLabel, `${hierarchie.grasSection} vs ${hierarchie.grasLabel}`);
  r.ok('Et plus sombre, pas plus pâle',
       hierarchie.lumSection < hierarchie.lumLabel, `${hierarchie.lumSection} vs ${hierarchie.lumLabel}`);

  /* ---------- La barre de progression avance vraiment ---------- */
  await page.evaluate(s => {
    window.Parcours.Scenario.load(s);
    window.Parcours.Storage.setCurrent(window.Parcours.Scenario.current.id);
    return window.Parcours.Storage.flush();
  }, PARCOURS);
  await page.goto(BASE + '#player');
  await page.waitForSelector('.play-start-card', { timeout: 15000 });
  await page.fill('.big-input', 'Les Lynx');
  await page.click('.btn-huge.accent');
  await page.waitForTimeout(400);
  const mesureBarre = () => page.evaluate(() => {
    const bar = document.querySelector('.play-progress .bar');
    return {
      pct: bar.style.getPropertyValue('--pct'),
      remplissage: Math.round(parseFloat(getComputedStyle(bar, '::after').width)),
      largeur: Math.round(bar.getBoundingClientRect().width)
    };
  });
  const etape1 = await mesureBarre();
  r.ok('La barre de progression porte bien sa valeur', etape1.pct !== '', `--pct = « ${etape1.pct} »`);
  r.ok('Et se remplit à l\'écran', etape1.remplissage > 0, `${etape1.remplissage} px sur ${etape1.largeur}`);

  await page.click('.play-validation .btn-huge');
  await page.waitForTimeout(500);
  const etape2 = await mesureBarre();
  r.ok('Elle progresse d\'une étape à l\'autre', etape2.remplissage > etape1.remplissage,
       `${etape1.remplissage} px → ${etape2.remplissage} px`);

  /* ---------- Un écran à carte unique est centré ---------- */
  await page.evaluate(() => window.Parcours.PlayerState.clear('ui'));
  await page.reload();
  await page.waitForSelector('.play-start-card', { timeout: 15000 });
  await page.waitForTimeout(300);
  const centrage = await page.evaluate(() => {
    const carte = document.querySelector('.play-start-card').getBoundingClientRect();
    const vue = document.querySelector('.view-player').getBoundingClientRect();
    return {
      hautDessus: Math.round(carte.top - vue.top),
      basDessous: Math.round(vue.bottom - carte.bottom)
    };
  });
  r.ok('La carte de départ n\'est plus collée en haut d\'une page vide',
       centrage.hautDessus > 60, `${centrage.hautDessus} px au-dessus, ${centrage.basDessous} px en dessous`);

  /* ---------- Fin de partie : une seule action principale ---------- */
  await page.evaluate(() => {
    const { Player, Scenario } = window.Parcours;
    Player.scenario = Scenario.current;
    Player.state = window.Parcours.PlayerState.create(Scenario.current, 'Les Lynx', false);
    Player.state.endedAt = Date.now();
    Player._endGame();
  });
  await page.waitForSelector('.play-end-card');
  const fin = await page.evaluate(() => {
    const carte = document.querySelector('.play-end-card');
    return {
      principales: carte.querySelectorAll('.btn-huge.accent').length,
      secondaires: carte.querySelectorAll('.btn-row.secondaires .btn').length,
      styles: new Set([...carte.querySelectorAll('.btn-row.secondaires .btn')].map(b => b.className)).size
    };
  });
  r.ok('Une seule action principale en fin de partie', fin.principales === 1);
  r.ok('Les actions secondaires partagent un même style',
       fin.secondaires === 3 && fin.styles === 1, `${fin.secondaires} boutons, ${fin.styles} style(s)`);

  r.ok('Aucune erreur JavaScript', errs.filter(e => !/tile|ERR_/i.test(e)).length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();
  return r;
}
