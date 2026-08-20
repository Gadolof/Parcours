import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVERITES, allFlags, blankScenario, buildRanking, isResultFile, stepStats, flagsRequiredBy, flagsSetBy, graphOrder,
  mainRouteDistance, mainRouteLength, migrateScenario, missingFlags,
  isQrValueSafe, reachableNodes, routeSegments, validateScenario
} from '../src/core.js';

/** Construit un scénario complet à partir d'une description courte. */
function scenario({ nodes = [], links = [], start = null, assets = [] } = {}) {
  return migrateScenario({
    id: 'test',
    meta: { title: 'Test', startNodeId: start },
    nodes, links, assets
  });
}
const N = (id, type = 'etape', extra = {}) => ({ id, type, title: id, ...extra });
const L = (source, target, condition = null) => ({ id: `${source}-${target}`, source, target, condition });
const POS = (lat, lng) => ({ position: { lat, lng } });

/* ============================================================ */
describe('graphOrder', () => {
  test('numérote dans l\'ordre de parcours, pas de création', () => {
    // Les nœuds sont déclarés à l'envers du chemin réel.
    const scn = scenario({
      nodes: [N('c'), N('b'), N('a', 'intro')],
      links: [L('a', 'b'), L('b', 'c')],
      start: 'a'
    });
    const ordre = graphOrder(scn);
    assert.deepEqual([ordre.get('a'), ordre.get('b'), ordre.get('c')], [1, 2, 3]);
  });

  test('une branche est numérotée en largeur', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('bon'), N('mauvais'), N('suite')],
      links: [L('a', 'bon', { type: 'correct' }), L('a', 'mauvais', { type: 'incorrect' }),
              L('bon', 'suite'), L('mauvais', 'suite')],
      start: 'a'
    });
    const o = graphOrder(scn);
    assert.equal(o.get('a'), 1);
    assert.deepEqual([o.get('bon'), o.get('mauvais')].sort(), [2, 3]);
    assert.equal(o.get('suite'), 4);
  });

  test('les nœuds isolés reçoivent un numéro à la suite', () => {
    const scn = scenario({ nodes: [N('a', 'intro'), N('orphelin')], links: [], start: 'a' });
    const o = graphOrder(scn);
    assert.equal(o.get('a'), 1);
    assert.equal(o.get('orphelin'), 2);
  });

  test('un cycle ne boucle pas', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('b'), N('c')],
      links: [L('a', 'b'), L('b', 'c'), L('c', 'a')], start: 'a'
    });
    assert.equal(graphOrder(scn).size, 3);
  });

  test('sans départ, tout le monde a quand même un numéro', () => {
    const scn = scenario({ nodes: [N('a'), N('b')], links: [L('a', 'b')] });
    assert.equal(graphOrder(scn).size, 2);
  });
});

/* ============================================================ */
describe('reachableNodes', () => {
  test('ne retient que ce qui se rejoint depuis le départ', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('b'), N('perdu')],
      links: [L('a', 'b')], start: 'a'
    });
    const r = reachableNodes(scn);
    assert.ok(r.has('a') && r.has('b'));
    assert.ok(!r.has('perdu'));
  });

  test('sans départ, rien n\'est atteignable', () => {
    assert.equal(reachableNodes(scenario({ nodes: [N('a')] })).size, 0);
  });
});

/* ============================================================ */
describe('routeSegments et distances', () => {
  const parcours = () => scenario({
    nodes: [
      N('a', 'intro'),
      N('b', 'etape', POS(48.8566, 2.3522)),
      N('c', 'etape', POS(48.8606, 2.3376)),
      N('d', 'outro')
    ],
    links: [L('a', 'b'), L('b', 'c'), L('c', 'd')],
    start: 'a'
  });

  test('seuls les liens entre deux nœuds positionnés donnent un segment', () => {
    const seg = routeSegments(parcours());
    assert.equal(seg.length, 1);
    assert.equal(seg[0].from, 'b');
    assert.equal(seg[0].to, 'c');
  });

  test('la distance du segment est plausible', () => {
    const [seg] = routeSegments(parcours());
    // Louvre → Palais-Royal, environ 1,2 km
    assert.ok(seg.distance > 1000 && seg.distance < 1500, `${Math.round(seg.distance)} m`);
  });

  test('un lien conditionnel est marqué comme tel', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', POS(48.85, 2.35)), N('b', 'etape', POS(48.86, 2.34))],
      links: [L('a', 'b', { type: 'incorrect' })], start: 'a'
    });
    assert.equal(routeSegments(scn)[0].conditional, true);
  });

  test('la distance du chemin principal ignore les branches d\'échec', () => {
    const scn = scenario({
      nodes: [
        N('a', 'etape', POS(48.85, 2.35)),
        N('bon', 'etape', POS(48.851, 2.35)),
        N('loin', 'etape', POS(49.50, 2.35)),
        N('fin', 'outro')
      ],
      links: [L('a', 'bon', { type: 'correct' }), L('a', 'loin', { type: 'incorrect' }), L('bon', 'fin')],
      start: 'a'
    });
    const d = mainRouteDistance(scn);
    assert.ok(d > 50 && d < 200, `${Math.round(d)} m — la branche d'échec ne doit pas compter`);
  });

  test('un parcours sans position mesure zéro', () => {
    assert.equal(mainRouteDistance(scenario({ nodes: [N('a', 'intro')], start: 'a' })), 0);
  });
});

/* ============================================================ */
describe('mainRouteLength', () => {
  test('compte les étapes du chemin le plus court jusqu\'à une fin', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('b'), N('c'), N('fin', 'outro')],
      links: [L('a', 'b'), L('b', 'c'), L('c', 'fin')], start: 'a'
    });
    assert.equal(mainRouteLength(scn), 4);
  });

  test('les variantes n\'allongent pas le dénominateur', () => {
    // 12 nœuds dont 4 en variante : le chemin principal en fait 8.
    const nodes = [N('a', 'intro')];
    const links = [];
    for (let i = 1; i <= 6; i++) { nodes.push(N('e' + i)); }
    links.push(L('a', 'e1'));
    for (let i = 1; i < 6; i++) links.push(L('e' + i, 'e' + (i + 1)));
    for (let i = 1; i <= 4; i++) { nodes.push(N('v' + i)); links.push(L('e1', 'v' + i, { type: 'incorrect' })); }
    nodes.push(N('fin', 'outro'));
    links.push(L('e6', 'fin'));
    const scn = scenario({ nodes, links, start: 'a' });
    assert.equal(scn.nodes.length, 12);
    assert.equal(mainRouteLength(scn), 8);
  });

  test('s\'arrête aussi sur une impasse', () => {
    const scn = scenario({ nodes: [N('a', 'intro'), N('b')], links: [L('a', 'b')], start: 'a' });
    assert.equal(mainRouteLength(scn), 2);
  });
});

/* ============================================================ */
describe('flags', () => {
  test('les listes sont normalisées à la migration', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', { setsFlags: ['  lampe ', '', 'lampe', 'clé'] })]
    });
    assert.deepEqual(flagsSetBy(scn.nodes[0]), ['lampe', 'clé']);
  });

  test('seuls les checkpoints exigent des flags', () => {
    const scn = scenario({
      nodes: [N('c', 'checkpoint', { requiresFlags: ['lampe'] }),
              N('e', 'etape', { requiresFlags: ['lampe'] })]
    });
    assert.deepEqual(flagsRequiredBy(scn.nodes[0]), ['lampe']);
    assert.deepEqual(flagsRequiredBy(scn.nodes[1]), []);
  });

  test('missingFlags dit ce qui manque', () => {
    const cp = scenario({ nodes: [N('c', 'checkpoint', { requiresFlags: ['lampe', 'clé'] })] }).nodes[0];
    assert.deepEqual(missingFlags(cp, ['lampe']), ['clé']);
    assert.deepEqual(missingFlags(cp, ['lampe', 'clé']), []);
    assert.deepEqual(missingFlags(cp, []), ['lampe', 'clé']);
  });

  test('allFlags rassemble posés, exigés et testés', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', { setsFlags: ['lampe'] }), N('c', 'checkpoint', { requiresFlags: ['clé'] }), N('b')],
      links: [L('a', 'b', { type: 'flag', value: 'torche' })]
    });
    assert.deepEqual(allFlags(scn), ['clé', 'lampe', 'torche']);
  });
});

/* ============================================================ */
describe('validateScenario', () => {
  const messages = scn => validateScenario(scn).map(i => i.message);
  const erreurs = scn => validateScenario(scn).filter(i => i.severity === SEVERITES.ERREUR);

  test('un scénario vide est signalé', () => {
    assert.match(messages(blankScenario())[0], /aucun nœud/i);
  });

  test('un parcours correct ne produit aucune erreur', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('b', 'etape', { ...POS(48.85, 2.35), validation: { type: 'qr', value: 'BORNE47' } }), N('f', 'outro')],
      links: [L('a', 'b'), L('b', 'f')], start: 'a'
    });
    assert.deepEqual(erreurs(scn), [], JSON.stringify(messages(scn)));
  });

  test('départ manquant ou fantôme', () => {
    assert.match(messages(scenario({ nodes: [N('a')] })).join(' '), /aucun nœud de départ/i);
    const scn = scenario({ nodes: [N('a')], start: 'a' });
    scn.meta.startNodeId = 'disparu';
    assert.match(messages(scn).join(' '), /n'existe plus/i);
  });

  test('nœud inatteignable', () => {
    const scn = scenario({ nodes: [N('a', 'intro'), N('f', 'outro'), N('perdu')], links: [L('a', 'f')], start: 'a' });
    assert.match(messages(scn).join(' '), /perdu.*atteignable/i);
  });

  test('impasse', () => {
    const scn = scenario({ nodes: [N('a', 'intro'), N('b')], links: [L('a', 'b')], start: 'a' });
    assert.match(erreurs(scn).map(i => i.message).join(' '), /aucun lien sortant/i);
  });

  test('QR ou code sans valeur attendue', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', { validation: { type: 'qr', value: '' } }), N('f', 'outro')],
      links: [L('a', 'f')], start: 'a'
    });
    assert.match(erreurs(scn).map(i => i.message).join(' '), /attend un contenu de QR/i);
  });

  test('validation GPS sans position', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', { validation: { type: 'gps', radius: 20 } }), N('f', 'outro')],
      links: [L('a', 'f')], start: 'a'
    });
    assert.match(erreurs(scn).map(i => i.message).join(' '), /proximité GPS mais n'a pas de position/i);
  });

  test('une énigme n\'a pas de validation à renseigner', () => {
    // L'éditeur créait les énigmes avec une validation QR que le moteur
    // ignore : la vérification en réclamait le contenu, et l'auteur
    // cherchait un problème qui n'existait pas.
    const scn = scenario({
      nodes: [
        N('q', 'enigme', { question: 'Combien ?', answer: 'Sept', ...POS(48.85, 2.35), validation: { type: 'qr', value: '' } }),
        N('f', 'outro')
      ],
      links: [L('q', 'f')], start: 'q'
    });
    assert.equal(scn.nodes[0].validation, undefined, 'la validation vestigiale est écartée');
    assert.deepEqual(erreurs(scn), [], JSON.stringify(messages(scn)));
  });

  test('énigme sans réponse', () => {
    const scn = scenario({
      nodes: [N('q', 'enigme', { question: 'Combien ?', answer: '' }), N('f', 'outro')],
      links: [L('q', 'f')], start: 'q'
    });
    assert.match(erreurs(scn).map(i => i.message).join(' '), /pas de réponse attendue/i);
  });

  test('branche « si correct » sans repli', () => {
    const scn = scenario({
      nodes: [N('q', 'enigme', { question: 'Q', answer: 'R' }), N('f', 'outro')],
      links: [L('q', 'f', { type: 'correct' })], start: 'q'
    });
    assert.match(messages(scn).join(' '), /nulle part où aller/i);
  });

  test('plusieurs liens sans condition', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('b'), N('c'), N('f', 'outro')],
      links: [L('a', 'b'), L('a', 'c'), L('b', 'f'), L('c', 'f')], start: 'a'
    });
    assert.match(messages(scn).join(' '), /seul le premier servira/i);
  });

  test('flag exigé mais jamais posé', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('c', 'checkpoint', { requiresFlags: ['lampe'] }), N('f', 'outro')],
      links: [L('a', 'c'), L('c', 'f')], start: 'a'
    });
    assert.match(erreurs(scn).map(i => i.message).join(' '), /flag « lampe » est attendu mais aucun nœud ne le pose/i);
  });

  test('un flag posé quelque part ne déclenche rien', () => {
    const scn = scenario({
      nodes: [N('a', 'intro', { setsFlags: ['lampe'] }), N('c', 'checkpoint', { requiresFlags: ['lampe'] }), N('f', 'outro')],
      links: [L('a', 'c'), L('c', 'f')], start: 'a'
    });
    assert.deepEqual(erreurs(scn), [], JSON.stringify(messages(scn)));
  });

  test('checkpoint sans condition', () => {
    const scn = scenario({
      nodes: [N('a', 'intro'), N('c', 'checkpoint'), N('f', 'outro')],
      links: [L('a', 'c'), L('c', 'f')], start: 'a'
    });
    assert.match(messages(scn).join(' '), /checkpoint sans condition/i);
  });

  test('média orphelin et média manquant', () => {
    const scn = scenario({
      nodes: [N('a', 'intro', { media: { image: 'absent' } }), N('f', 'outro')],
      links: [L('a', 'f')], start: 'a',
      assets: [{ id: 'inutilise', name: 'photo.png', type: 'image/png' }]
    });
    const m = messages(scn).join(' ');
    // migrateScenario déréférence déjà le média absent ; reste l'orphelin.
    assert.match(m, /n'est utilisé nulle part/i);
  });

  test('outro absent', () => {
    const scn = scenario({ nodes: [N('a', 'intro'), N('b')], links: [L('a', 'b')], start: 'a' });
    assert.match(messages(scn).join(' '), /aucun nœud outro/i);
  });

  test('chaque anomalie porte le nœud concerné quand il y en a un', () => {
    const scn = scenario({ nodes: [N('a', 'intro'), N('b')], links: [L('a', 'b')], start: 'a' });
    const impasse = validateScenario(scn).find(i => /aucun lien sortant/.test(i.message));
    assert.equal(impasse.nodeId, 'b');
  });
});

/* ============================================================ */
describe('contenu des QR', () => {
  test('l\'ASCII imprimable passe', () => {
    for (const v of ['BORNE47', 'K7RQM2', 'borne-47_A', 'la borne 47', '']) {
      assert.ok(isQrValueSafe(v), v);
    }
  });

  test('les accents et symboles sont refusés', () => {
    // Encodés, ils produisent un QR valide que le décodeur embarqué
    // relit vide : le scan ne correspondrait jamais sur le terrain.
    for (const v of ['Église', 'château', 'borne→47', '★']) {
      assert.ok(!isQrValueSafe(v), v);
    }
  });

  test('la vérification signale un QR illisible', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', { validation: { type: 'qr', value: 'Église' } }), N('f', 'outro')],
      links: [L('a', 'f')], start: 'a'
    });
    const erreur = validateScenario(scn).find(i => /le scanner ne relit pas/i.test(i.message));
    assert.ok(erreur, JSON.stringify(validateScenario(scn).map(i => i.message)));
    assert.equal(erreur.severity, SEVERITES.ERREUR);
    assert.equal(erreur.nodeId, 'a');
  });

  test('un code saisi peut contenir des accents, lui', () => {
    const scn = scenario({
      nodes: [N('a', 'etape', { validation: { type: 'code', value: 'château' } }), N('f', 'outro')],
      links: [L('a', 'f')], start: 'a'
    });
    assert.ok(!validateScenario(scn).some(i => /scanner ne relit pas/i.test(i.message)));
  });
});

/* ============================================================ */
describe('agrégation des résultats', () => {
  const resultat = (teamName, durationSec, totalSteps, totalAttempts, extra = {}) => ({
    version: '0.2', scenarioId: 's', scenarioTitle: 'Le bois', teamName,
    durationSec, totalSteps, totalAttempts, testMode: false,
    path: Array.from({ length: totalSteps }, (_, i) => ({
      nodeId: 'n' + i, title: 'Étape ' + i, type: 'etape',
      durationSec: Math.round(durationSec / totalSteps), attempts: 1
    })),
    ...extra
  });

  test('reconnaît un fichier de résultats', () => {
    assert.ok(isResultFile(resultat('Les Lynx', 600, 4, 4)));
    assert.ok(!isResultFile(null));
    assert.ok(!isResultFile({ teamName: 'x' }));
    assert.ok(!isResultFile({ path: [] }));
  });

  test('classe par erreurs puis par temps', () => {
    const c = buildRanking([
      resultat('Lente sans faute', 1200, 4, 4),
      resultat('Rapide mais fautive', 400, 4, 7),
      resultat('Rapide sans faute', 600, 4, 4)
    ]);
    assert.deepEqual(c.equipes.map(e => e.teamName),
      ['Rapide sans faute', 'Lente sans faute', 'Rapide mais fautive']);
    assert.deepEqual(c.equipes.map(e => e.rang), [1, 2, 3]);
  });

  test('compte les erreurs comme les essais en trop', () => {
    const c = buildRanking([resultat('A', 100, 5, 8)]);
    assert.equal(c.equipes[0].erreurs, 3);
  });

  test('écarte les parties de test et les fichiers invalides', () => {
    const c = buildRanking([
      resultat('Vraie', 300, 3, 3),
      resultat('Essai', 100, 3, 3, { testMode: true }),
      { pas: 'un résultat' },
      null
    ]);
    assert.equal(c.equipes.length, 1);
    assert.equal(c.ignores, 3);
  });

  test('signale un mélange de scénarios', () => {
    const c = buildRanking([
      resultat('A', 300, 3, 3),
      { ...resultat('B', 300, 3, 3), scenarioTitle: 'Autre parcours' }
    ]);
    assert.equal(c.melange, true);
    assert.equal(c.scenarioTitle, null);
  });

  test('un seul scénario est nommé', () => {
    assert.equal(buildRanking([resultat('A', 300, 3, 3)]).scenarioTitle, 'Le bois');
  });

  test('les statistiques par étape agrègent les équipes', () => {
    const c = buildRanking([resultat('A', 600, 3, 3), resultat('B', 300, 3, 5)]);
    const stats = stepStats(c);
    assert.equal(stats.length, 3);
    assert.equal(stats[0].equipes, 2);
    assert.equal(stats[0].dureeMoyenne, 150);   // (200 + 100) / 2
    assert.ok(stats[0].dureeMax === 200);
  });

  test('aucun fichier donne un classement vide', () => {
    const c = buildRanking([]);
    assert.deepEqual(c.equipes, []);
    assert.deepEqual(stepStats(c), []);
  });
});
