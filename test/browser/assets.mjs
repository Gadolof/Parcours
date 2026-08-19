import { launch, reporter } from './harness.mjs';

export default async function run(BASE) {
  const r = reporter('Médias, tuiles et stockage');
  const B = BASE;
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(B);
  await page.waitForFunction(() => window.Parcours?.App?.root);
  await page.evaluate(() => localStorage.setItem('parcours.tutoSeen','1'));
  await page.goto(B + '#editor'); await page.waitForSelector('#graph'); await page.waitForTimeout(500);

  // --- Un média ajouté part en Blob, pas en base64 dans le scénario ---
  const add = await page.evaluate(async () => {
    const { Scenario, Inspector, AssetStore, Library } = window.Parcours;
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const file = new File([png], 'borne.png', { type: 'image/png' });
    await Inspector._addFiles([file]);
    await new Promise(done => setTimeout(done, 400));
    const a = Scenario.current.assets[0];
    const stored = await Library.get(Scenario.current.id);
    const blob = await AssetStore.getBlob(a.id);
    return {
      inScenario: JSON.stringify(Scenario.current.assets),
      dansLeDocument: JSON.stringify(stored?.assets || []).includes('data:'),
      blobPresent: !!blob, blobType: blob?.type, blobSize: blob?.size,
      id: a.id, scenarioId: Scenario.current.id
    };
  });
  r.ok('Le média est stocké en Blob', add.blobPresent && add.blobType === 'image/png', `${add.blobSize} o`);
  r.ok('Le document du scénario ne contient plus de base64', add.dansLeDocument === false, add.inScenario);

  // --- Une URL d'objet est mémorisée, pas recréée à chaque appel ---
  const urls = await page.evaluate(async (id) => {
    const { AssetStore } = window.Parcours;
    const u1 = await AssetStore.url(id), u2 = await AssetStore.url(id);
    return { same: u1 === u2, isBlob: u1?.startsWith('blob:'), taille: AssetStore._urls.size };
  }, add.id);
  r.ok('Les object URLs sont mémorisés', urls.same && urls.isBlob, `cache: ${urls.taille}`);

  // --- Aller-retour ZIP complet ---
  const roundtrip = await page.evaluate(async (assetId) => {
    const { Scenario, IO, AssetStore } = window.Parcours;
    Scenario.updateMeta({ title: 'Parcours avec média' });
    const n = Scenario.addNode('etape');
    Scenario.updateNode(n.id, { media: { image: assetId } });

    // Export : on récupère le blob du ZIP sans passer par le téléchargement.
    const zip = new JSZip();
    const exported = JSON.parse(JSON.stringify(Scenario.current));
    exported.assets = exported.assets.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size, path: `assets/${a.id}_${a.name}` }));
    zip.file('scenario.json', JSON.stringify(exported));
    for (const a of Scenario.current.assets) zip.file(`assets/${a.id}_${a.name}`, await AssetStore.getBlob(a.id));
    const blob = await zip.generateAsync({ type: 'blob' });

    // On efface tout, puis on réimporte.
    await AssetStore.removeForScenario(Scenario.current.id);
    const ok = await IO.importZip(new File([blob], 'p.zip', { type: 'application/zip' }));
    await new Promise(done => setTimeout(done, 300));
    const a = Scenario.current.assets[0];
    const restored = a ? await AssetStore.getBlob(a.id) : null;
    return { ok, nom: a?.name, type: a?.type, taille: restored?.size, lie: Scenario.current.nodes[0]?.media?.image === a?.id };
  }, add.id);
  r.ok('L\'export/import ZIP conserve le média', roundtrip.ok && roundtrip.taille > 0 && roundtrip.type === 'image/png',
     `${roundtrip.nom} · ${roundtrip.taille} o`);
  r.ok('La référence du nœud vers le média survit', roundtrip.lie === true);

  // --- Reprise d'un scénario v0.1 (médias base64 dans le document) ---
  const legacy = await page.evaluate(async () => {
    const { Scenario, AssetStore } = window.Parcours;
    Scenario.load({
      id: 'ancien', meta: { title: 'Ancien format' }, nodes: [], links: [],
      assets: [{ id: 'a_vieux', name: 'photo.png', type: 'image/png', size: 70,
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }]
    });
    await new Promise(done => setTimeout(done, 600));
    const blob = await AssetStore.getBlob('a_vieux');
    return { migre: !!blob, taille: blob?.size, resteEnLigne: !!Scenario.current.assets[0]?.dataUrl };
  });
  r.ok('Les médias base64 d\'un ancien scénario sont repris', legacy.migre && !legacy.resteEnLigne, `${legacy.taille} o`);

  // --- Comptage des tuiles par index ---
  const tiles = await page.evaluate(async () => {
    const { TileCache } = window.Parcours;
    const b = new Blob([new Uint8Array(64)], { type: 'image/png' });
    for (let i = 0; i < 12; i++) await TileCache.put('carto', 13, 4149 + i, 2818, b);
    for (let i = 0; i < 5; i++)  await TileCache.put('topo', 13, 4149 + i, 2818, b);
    return {
      carto: await TileCache.countFor('carto'),
      topo: await TileCache.countFor('topo'),
      total: await TileCache.countAll(),
      presente: await TileCache.has('carto', 13, 4149, 2818),
      absente: await TileCache.has('carto', 13, 9999, 2818),
      purge: await TileCache.clearProvider('topo'),
      apres: await TileCache.countFor('topo')
    };
  });
  r.ok('Le comptage par fond de carte est juste', tiles.carto === 12 && tiles.topo === 5 && tiles.total === 17, JSON.stringify(tiles));
  r.ok('has() répond sans charger le blob', tiles.presente === true && tiles.absente === false);
  r.ok('La purge par fond de carte est ciblée', tiles.purge === 5 && tiles.apres === 0 && await page.evaluate(() => window.Parcours.TileCache.countFor('carto')) === 12);

  r.ok('Aucune erreur JavaScript', errs.filter(e => !/tile|ERR_/i.test(e)).length === 0, errs.slice(0,2).join(' | '));
  await browser.close();
  return r;
}
