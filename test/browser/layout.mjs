import { launch, reporter } from './harness.mjs';

export default async function run(BASE) {
  const r = reporter('Mise en page et état');
  const B = BASE;
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));

  await page.goto(B); await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen','1'));

  // B11 : grille de l'éditeur
  await page.goto(B + '#editor'); await page.waitForSelector('#graph'); await page.waitForTimeout(600);
  const grid = await page.evaluate(() => {
    const insp = document.querySelector('.inspector').getBoundingClientRect();
    const pal  = document.querySelector('.palette').getBoundingClientRect();
    return { inspLeft: Math.round(insp.left), inspW: Math.round(insp.width), palRight: Math.round(pal.right), vw: innerWidth };
  });
  r.ok('B11 — l\'inspecteur occupe la colonne de droite',
     grid.inspLeft > grid.palRight && grid.inspLeft + grid.inspW <= grid.vw + 1,
     `inspecteur à x=${grid.inspLeft}, largeur ${grid.inspW}, viewport ${grid.vw}`);

  // B13 : le tutoriel passe au-dessus de la carte
  await page.evaluate(() => localStorage.removeItem('parcours.tutoSeen'));
  await page.reload(); await page.waitForSelector('.tuto-bubble'); await page.waitForTimeout(700);
  const z = await page.evaluate(() => {
    const bubble = document.querySelector('.tuto-bubble').getBoundingClientRect();
    const cx = bubble.left + bubble.width/2, cy = bubble.top + bubble.height/2;
    const top = document.elementFromPoint(cx, cy);
    return { inBubble: !!top?.closest('.tuto-bubble'), tag: top?.className };
  });
  r.ok('B13 — rien ne recouvre la bulle du tutoriel', z.inBubble === true, `élément au sommet : ${z.tag}`);

  // B9 : export depuis la bibliothèque sans permutation
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen','1'));
  const b9 = await page.evaluate(async () => {
    const { Library, Scenario, IO } = window.Parcours;
    const autre = { ...Scenario.blank(), id: 'autre_scn' };
    autre.meta.title = 'Autre parcours';
    await Library.put(autre);
    const avant = Scenario.current.id;
    const full = await Library.get('autre_scn');
    await IO.exportZip(full);
    return { avant, apres: Scenario.current.id };
  });
  r.ok('B9 — l\'export bibliothèque ne touche pas au scénario courant', b9.avant === b9.apres, `${b9.avant} → ${b9.apres}`);

  // 5.2 : un type forgé ne devient pas du HTML
  const xss = await page.evaluate(() => {
    const { Scenario } = window.Parcours;
    Scenario.load({ id: 'x', meta: {}, assets: [], links: [],
      nodes: [{ id: 'n1', type: '<img src=x onerror="window.__pwn=1">', title: 'Piège' }] });
    return { type: Scenario.current.nodes[0].type, pwned: !!window.__pwn };
  });
  r.ok('5.2 — le type forgé est ramené à un type connu', xss.type === 'etape' && !xss.pwned, `type: ${xss.type}`);

  // 4.2 : déplacer la carte ne salit plus le document
  await page.goto(B + '#editor'); await page.waitForSelector('#map'); await page.waitForTimeout(700);
  const pan = await page.evaluate(async () => {
    const { Editor, App } = window.Parcours;
    App.markClean();
    Editor.map.panBy([200, 120]);
    await new Promise(done => setTimeout(done, 900));
    return { dirty: App.dirty, pending: !!Editor._pendingArea };
  });
  r.ok('4.2 — un panoramique ne déclenche pas de sauvegarde', pan.dirty === false && pan.pending === true,
     `dirty: ${pan.dirty}, en attente: ${pan.pending}`);
  const saved = await page.evaluate(async () => {
    const { Editor, Scenario } = window.Parcours;
    const before = JSON.stringify(Scenario.current.meta.area);
    Editor.unmount();
    return { before, after: JSON.stringify(Scenario.current.meta.area) };
  });
  r.ok('4.2 — le cadrage est bien enregistré en sortie d\'éditeur', saved.before !== saved.after, `${saved.before} → ${saved.after}`);

  r.ok('Aucune erreur JavaScript', errs.length === 0, errs.slice(0,2).join(' | '));
  await browser.close();
  return r;
}
