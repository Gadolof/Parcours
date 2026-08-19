import { launch, reporter } from './harness.mjs';

const IPHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
};

export default async function run(BASE) {
  const r = reporter('Interface mobile');
  const browser = await launch();
  const page = await (await browser.newContext(IPHONE)).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));

  await page.goto(BASE);
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen', '1'));

  /* ---------- Rien ne déborde horizontalement ---------- */
  const debord = async (vue) => {
    await page.goto(BASE + '#' + vue);
    await page.waitForTimeout(700);
    return page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      vue: window.innerWidth
    }));
  };
  for (const vue of ['home', 'editor', 'player', 'results']) {
    const d = await debord(vue);
    r.ok(`La vue « ${vue} » ne déborde pas en largeur`, d.scroll <= d.vue + 1, `${d.scroll} > ${d.vue}`);
  }

  /* ---------- Le zoom par pincement est rendu à l'utilisateur ---------- */
  const viewport = await page.evaluate(() =>
    document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '');
  r.ok('Le viewport n\'interdit plus le zoom',
       !/user-scalable\s*=\s*no|maximum-scale/.test(viewport), viewport);

  /* ---------- Éditeur : palette masquée, FAB présents ---------- */
  await page.goto(BASE + '#editor');
  await page.waitForSelector('#graph');
  await page.waitForTimeout(700);
  const chrome = await page.evaluate(() => {
    const vis = sel => {
      const e = document.querySelector(sel);
      return !!e && getComputedStyle(e).display !== 'none';
    };
    return { palette: vis('#palette'), fab: vis('#fab-group'), backdrop: vis('.inspector-backdrop') };
  });
  r.ok('La palette laisse la place au tactile', chrome.palette === false);
  r.ok('Les boutons flottants sont là', chrome.fab === true);

  /* ---------- Créer un nœud au doigt : FAB → type → tap sur la carte ---------- */
  await page.tap('#fab-add');
  await page.waitForSelector('.picker-grid');
  r.ok('Le sélecteur de type s\'ouvre', true);
  await page.tap('.picker-item.type-etape');
  await page.waitForTimeout(300);
  const enPlacement = await page.evaluate(() => ({
    banniere: !!document.getElementById('placement-banner'),
    classe: document.body.classList.contains('placing')
  }));
  r.ok('Le mode placement s\'annonce', enPlacement.banniere && enPlacement.classe, JSON.stringify(enPlacement));

  const boite = await page.evaluate(() => {
    const m = document.getElementById('map').getBoundingClientRect();
    return { x: Math.round(m.left + m.width / 2), y: Math.round(m.top + m.height / 2) };
  });
  await page.tap('#map', { position: { x: 60, y: 60 } }).catch(async () => {
    await page.mouse.click(boite.x, boite.y);
  });
  await page.waitForTimeout(500);
  const cree = await page.evaluate(() => {
    const { Scenario } = window.Parcours;
    const n = Scenario.current.nodes[Scenario.current.nodes.length - 1];
    return {
      total: Scenario.current.nodes.length,
      positionne: !!(n?.position?.lat != null),
      banniere: !!document.getElementById('placement-banner')
    };
  });
  r.ok('Un tap sur la carte pose le nœud', cree.total === 1 && cree.positionne, JSON.stringify(cree));
  r.ok('La bannière de placement se referme', cree.banniere === false);

  /* ---------- L'inspecteur s'ouvre en feuille, et se referme ---------- */
  const feuille = await page.evaluate(() => {
    const insp = document.querySelector('.inspector');
    const r1 = insp.getBoundingClientRect();
    return {
      ouvert: insp.classList.contains('open'),
      dansLEcran: r1.top < window.innerHeight && r1.bottom > 0,
      largeurPleine: Math.round(r1.width) >= window.innerWidth - 2
    };
  });
  r.ok('L\'inspecteur s\'ouvre en feuille sur la sélection', feuille.ouvert && feuille.dansLEcran, JSON.stringify(feuille));
  r.ok('Il occupe toute la largeur', feuille.largeurPleine === true);

  await page.tap('.inspector-handle .close-btn');
  await page.waitForTimeout(400);
  const ferme = await page.evaluate(() => {
    const insp = document.querySelector('.inspector');
    return { ouvert: insp.classList.contains('open'), backdrop: document.querySelector('.inspector-backdrop')?.classList.contains('open') };
  });
  r.ok('Il se referme, backdrop compris', !ferme.ouvert && !ferme.backdrop, JSON.stringify(ferme));

  /* ---------- Rien de Leaflet ne passe au-dessus de la feuille ---------- */
  await page.evaluate(() => window.Parcours.Editor.selectNode(window.Parcours.Scenario.current.nodes[0].id));
  await page.waitForTimeout(500);
  const couches = await page.evaluate(() => {
    const insp = document.querySelector('.inspector').getBoundingClientRect();
    // On sonde trois points dans la feuille : ce qui répond doit lui appartenir.
    const points = [
      [insp.left + insp.width / 2, insp.top + 30],
      [insp.left + insp.width / 2, insp.top + insp.height / 2],
      [insp.right - 30, insp.top + insp.height - 40]
    ];
    return points.map(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      return e?.closest('.inspector') ? 'inspecteur' : (e?.className || e?.tagName || 'rien');
    });
  });
  r.ok('L\'attribution de la carte ne recouvre plus la feuille',
       couches.every(c => c === 'inspecteur'), couches.join(' | '));

  /* ---------- La barre de navigation tient sur la largeur ---------- */
  const nav = await page.evaluate(() => {
    const liens = [...document.querySelectorAll('.nav a')];
    const barre = document.querySelector('.nav').getBoundingClientRect();
    const dernier = liens[liens.length - 1].getBoundingClientRect();
    return {
      entrees: liens.length,
      coupe: dernier.right > barre.right + 1,
      libelle: liens[liens.length - 1].textContent
    };
  });
  r.ok('Les quatre entrées de navigation tiennent sans être coupées',
       nav.entrees === 4 && !nav.coupe, `dernière : « ${nav.libelle} »`);

  /* ---------- Un toast ne bloque pas les boutons flottants ---------- */
  await page.tap('.inspector-handle .close-btn');
  await page.waitForTimeout(400);
  const sousToast = await page.evaluate(() => {
    window.Parcours.Toast.info('Un message qui recouvre les boutons');
    const fab = document.querySelector('#fab-add').getBoundingClientRect();
    const dessus = document.elementFromPoint(fab.left + fab.width / 2, fab.top + fab.height / 2);
    return { atteint: dessus?.id === 'fab-add' || !!dessus?.closest('#fab-add'), classe: dessus?.className };
  });
  r.ok('Le bouton « + » reste tapable pendant qu\'un message s\'affiche',
       sousToast.atteint === true, `au-dessus : ${sousToast.classe}`);

  /* ---------- Les champs ne déclenchent pas le zoom iOS ---------- */
  await page.tap('#fab-inspector');
  await page.waitForTimeout(400);
  const tailles = await page.evaluate(() => {
    const champs = [...document.querySelectorAll('.inspector input[type="text"], .inspector textarea, .inspector select')];
    return champs.map(c => parseFloat(getComputedStyle(c).fontSize)).filter(Boolean);
  });
  r.ok('Les champs font au moins 16 px (pas de zoom iOS au focus)',
       tailles.length > 0 && tailles.every(t => t >= 16), `tailles : ${[...new Set(tailles)].join(', ')}`);

  /* ---------- Cibles tactiles ---------- */
  const cibles = await page.evaluate(() => {
    const sels = ['#fab-add', '#fab-inspector', '#tuto-help', '.inspector-tabs button'];
    const petits = [];
    for (const sel of sels) {
      for (const e of document.querySelectorAll(sel)) {
        const b = e.getBoundingClientRect();
        if (b.width && b.height && (b.width < 40 || b.height < 40)) {
          petits.push(`${sel} ${Math.round(b.width)}×${Math.round(b.height)}`);
        }
      }
    }
    return petits;
  });
  r.ok('Les cibles tactiles principales font au moins 40 px', cibles.length === 0, cibles.join(' | '));

  /* ---------- Le joueur, sur un écran de téléphone ---------- */
  await page.evaluate(() => {
    const { Scenario } = window.Parcours;
    Scenario.load({
      id: 'mob', meta: { title: 'Parcours mobile', startNodeId: 'q' },
      nodes: [
        { id: 'q', type: 'enigme', title: 'La question', question: 'Combien de marches ?', answer: 'Douze' },
        { id: 'f', type: 'outro', title: 'Fin' }
      ],
      links: [{ id: 'l', source: 'q', target: 'f' }], assets: []
    });
  });
  await page.evaluate(() => window.Parcours.Storage.flush());
  await page.goto(BASE + '#player');
  await page.waitForSelector('.play-start-card');
  await page.fill('.big-input', 'Les Lynx');
  await page.tap('.btn-huge.accent');
  await page.waitForTimeout(400);

  const jeu = await page.evaluate(() => {
    const bouton = document.querySelector('.play-validation .btn-huge').getBoundingClientRect();
    return {
      hauteurBouton: Math.round(bouton.height),
      largeurBouton: Math.round(bouton.width),
      dansLEcran: bouton.right <= window.innerWidth + 1,
      debord: document.documentElement.scrollWidth <= window.innerWidth + 1
    };
  });
  r.ok('Le bouton de validation est atteignable au doigt',
       jeu.hauteurBouton >= 44 && jeu.dansLEcran, `${jeu.largeurBouton}×${jeu.hauteurBouton}`);
  r.ok('L\'écran de jeu ne déborde pas', jeu.debord === true);

  await page.fill('.play-validation .big-input', 'douze');
  await page.tap('.play-validation .btn-huge');
  await page.waitForTimeout(400);
  const apres = await page.evaluate(() => window.Parcours.Player.state.currentNodeId);
  r.ok('Une réponse juste fait avancer, au doigt aussi', apres === 'f', `nœud : ${apres}`);

  r.ok('Aucune erreur JavaScript', errs.filter(e => !/tile|ERR_/i.test(e)).length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();
  return r;
}
