import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ON_WRONG, SCENARIO_VERSION,
  answersMatch, blankScenario, escapeHtml, estimateTiles, hasPosition,
  haversine, isKnownType, latLngToTile, migrateScenario, normalizeAnswer,
  onWrongBehaviour, pickNextNode, slugify, typeLabel
} from '../src/core.js';

/* ============================================================
   pickNextNode — le routage qui terminait des parties en silence
   ============================================================ */
describe('pickNextNode', () => {
  const L = (target, condition = null) => ({ id: 't', source: 'a', target, condition });

  test('sans lien sortant, le parcours se termine', () => {
    assert.deepEqual(pickNextNode([]), { targetId: null, reason: 'no-links' });
    assert.deepEqual(pickNextNode(undefined), { targetId: null, reason: 'no-links' });
  });

  test('suit le lien inconditionnel', () => {
    const r = pickNextNode([L('b')], { correct: true });
    assert.deepEqual(r, { targetId: 'b', reason: 'fallback' });
  });

  test('une condition satisfaite prime sur le lien inconditionnel', () => {
    const links = [L('fallback'), L('bravo', { type: 'correct' })];
    assert.equal(pickNextNode(links, { correct: true }).targetId, 'bravo');
  });

  test('route sur la branche « si incorrect »', () => {
    const links = [L('bravo', { type: 'correct' }), L('rattrapage', { type: 'incorrect' })];
    assert.equal(pickNextNode(links, { correct: false }).targetId, 'rattrapage');
  });

  test('une condition « correct » ne s\'applique pas à une réponse fausse', () => {
    const links = [L('bravo', { type: 'correct' }), L('suite')];
    assert.equal(pickNextNode(links, { correct: false }).targetId, 'suite');
  });

  test('sans réponse enregistrée, aucune condition correct/incorrect ne matche', () => {
    const links = [L('bravo', { type: 'correct' }), L('rattrapage', { type: 'incorrect' }), L('suite')];
    assert.equal(pickNextNode(links, { correct: null }).targetId, 'suite');
  });

  test('condition de flag', () => {
    const links = [L('secret', { type: 'flag', value: 'lampe' }), L('suite')];
    assert.equal(pickNextNode(links, { flags: ['lampe'] }).targetId, 'secret');
    assert.equal(pickNextNode(links, { flags: [] }).targetId, 'suite');
  });

  test('aucune condition ne matche et pas de repli : on avance quand même', () => {
    // Le bug d'origine : la partie se terminait ici, en plein parcours.
    const links = [L('bravo', { type: 'correct' })];
    const r = pickNextNode(links, { correct: false });
    assert.equal(r.targetId, 'bravo');
    assert.equal(r.reason, 'rescue');
  });

  test('l\'ordre de déclaration départage deux conditions satisfaites', () => {
    const links = [L('un', { type: 'flag', value: 'x' }), L('deux', { type: 'correct' })];
    assert.equal(pickNextNode(links, { correct: true, flags: ['x'] }).targetId, 'un');
  });
});

/* ============================================================
   Comparaison des réponses
   ============================================================ */
describe('normalizeAnswer / answersMatch', () => {
  test('ignore casse, accents et espaces superflus', () => {
    assert.equal(normalizeAnswer('  Le  CHÂTEAU  '), 'le chateau');
    assert.ok(answersMatch('Élève', 'eleve'));
    assert.ok(answersMatch(' 42 ', '42'));
  });

  test('reste sensible au contenu', () => {
    assert.ok(!answersMatch('chateau', 'chapeau'));
  });

  test('tolère null et undefined', () => {
    assert.equal(normalizeAnswer(null), '');
    assert.ok(answersMatch(null, undefined));
    assert.ok(!answersMatch('x', null));
  });
});

/* ============================================================
   Comportement sur mauvaise réponse
   ============================================================ */
describe('onWrongBehaviour', () => {
  test('réessayer est le défaut, y compris pour un nœud sans réglage', () => {
    assert.equal(onWrongBehaviour({}), ON_WRONG.RETRY);
    assert.equal(onWrongBehaviour(null), ON_WRONG.RETRY);
    assert.equal(onWrongBehaviour({ onWrong: 'nimporte quoi' }), ON_WRONG.RETRY);
  });

  test('« continue » est respecté', () => {
    assert.equal(onWrongBehaviour({ onWrong: ON_WRONG.CONTINUE }), ON_WRONG.CONTINUE);
  });
});

/* ============================================================
   Positions
   ============================================================ */
describe('hasPosition', () => {
  test('accepte une position complète', () => {
    assert.ok(hasPosition({ position: { lat: 48.85, lng: 2.35 } }));
    assert.ok(hasPosition({ position: { lat: 0, lng: 0 } }));
  });

  test('rejette les positions fantômes créées par l\'inspecteur', () => {
    assert.ok(!hasPosition({ position: { lat: null, lng: null } }));
    assert.ok(!hasPosition({ position: { lat: 48.85 } }));
    assert.ok(!hasPosition({ position: {} }));
    assert.ok(!hasPosition({ position: null }));
    assert.ok(!hasPosition({}));
    assert.ok(!hasPosition(null));
  });
});

/* ============================================================
   Géométrie et tuiles
   ============================================================ */
describe('haversine', () => {
  test('distance nulle', () => {
    assert.equal(haversine(48.8566, 2.3522, 48.8566, 2.3522), 0);
  });

  test('Paris – Lyon ≈ 392 km', () => {
    const d = haversine(48.8566, 2.3522, 45.7640, 4.8357);
    assert.ok(Math.abs(d - 392000) < 4000, `distance obtenue : ${Math.round(d)} m`);
  });

  test('cent mètres restent cent mètres', () => {
    const d = haversine(48.8566, 2.3522, 48.857499, 2.3522);
    assert.ok(Math.abs(d - 100) < 2, `distance obtenue : ${d.toFixed(1)} m`);
  });

  test('symétrique', () => {
    const a = haversine(48.85, 2.35, 45.76, 4.83);
    const b = haversine(45.76, 4.83, 48.85, 2.35);
    assert.ok(Math.abs(a - b) < 1e-6);
  });
});

describe('latLngToTile / estimateTiles', () => {
  test('au zoom 0, tout le monde est dans la tuile 0,0', () => {
    assert.deepEqual(latLngToTile(48.85, 2.35, 0), { x: 0, y: 0 });
  });

  test('ancrage vérifiable à la main : 45°N 45°E au zoom 1', () => {
    // x = floor((45+180)/360 * 2) = 1 ; y = floor((1 - asinh(tan45°)/π)/2 * 2) = 0
    assert.deepEqual(latLngToTile(45, 45, 1), { x: 1, y: 0 });
  });

  test('concorde avec la formule slippy-map de référence', () => {
    const reference = (lat, lng, z) => {
      const n = 2 ** z;
      const rad = lat * Math.PI / 180;
      return {
        x: Math.floor((lng + 180) / 360 * n),
        y: Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n)
      };
    };
    for (const [lat, lng, z] of [[48.8566, 2.3522, 13], [-33.87, 151.21, 16], [64.14, -21.94, 10]]) {
      assert.deepEqual(latLngToTile(lat, lng, z), reference(lat, lng, z), `${lat},${lng}@${z}`);
    }
  });

  test('les coordonnées de tuile suivent la géographie', () => {
    const a = latLngToTile(48.85, 2.00, 13);
    const b = latLngToTile(48.85, 2.50, 13);
    const sud = latLngToTile(48.00, 2.00, 13);
    assert.ok(b.x > a.x, 'vers l\'est, x augmente');
    assert.ok(sud.y > a.y, 'vers le sud, y augmente');
  });

  test('un seul zoom sur une zone minuscule = une tuile', () => {
    const b = { north: 48.8567, south: 48.8566, east: 2.3523, west: 2.3522 };
    assert.equal(estimateTiles(b, 13, 13), 1);
  });

  test('le compte croît avec la profondeur de zoom', () => {
    const b = { north: 48.90, south: 48.80, east: 2.42, west: 2.28 };
    const petit = estimateTiles(b, 13, 14);
    const grand = estimateTiles(b, 13, 16);
    assert.ok(grand > petit * 4, `${petit} → ${grand}`);
  });
});

/* ============================================================
   Utilitaires
   ============================================================ */
describe('slugify / escapeHtml / typeLabel', () => {
  test('slugify produit un nom de fichier sûr', () => {
    assert.equal(slugify('Chasse au Trésor — Été 2026'), 'chasse-au-tresor-ete-2026');
    assert.equal(slugify('!!!'), 'parcours');
    assert.equal(slugify(''), 'parcours');
    assert.equal(slugify(null, 'resultats'), 'resultats');
  });

  test('escapeHtml neutralise le balisage', () => {
    assert.equal(escapeHtml('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
    assert.equal(escapeHtml(null), '');
  });

  test('typeLabel connaît les cinq types', () => {
    assert.equal(typeLabel('etape'), 'Étape');
    assert.equal(typeLabel('enigme'), 'Énigme');
    assert.equal(typeLabel('inconnu'), 'inconnu');
    assert.ok(isKnownType('checkpoint'));
    assert.ok(!isKnownType('<script>'));
  });
});

/* ============================================================
   migrateScenario — le ZIP est une entrée non fiable
   ============================================================ */
describe('migrateScenario', () => {
  test('une entrée absurde donne un scénario vierge utilisable', () => {
    for (const bad of [null, undefined, 42, 'texte', []]) {
      const scn = migrateScenario(bad);
      assert.equal(scn.version, SCENARIO_VERSION);
      assert.deepEqual(scn.nodes, []);
      assert.deepEqual(scn.links, []);
      assert.ok(scn.meta.title !== undefined);
    }
  });

  test('un scénario sans nodes ne fait pas tomber l\'application', () => {
    const scn = migrateScenario({ id: 's1', meta: { title: 'Test' } });
    assert.deepEqual(scn.nodes, []);
    assert.equal(scn.meta.title, 'Test');
    assert.equal(scn.meta.tileProvider, 'carto');
    assert.equal(scn.meta.showMapToPlayers, false);
  });

  test('un type de nœud forgé est ramené à un type connu', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'n1', type: '<img src=x onerror=alert(1)>', title: 'Piège' }]
    });
    assert.equal(scn.nodes[0].type, 'etape');
    assert.ok(isKnownType(scn.nodes[0].type));
  });

  test('les liens vers des nœuds inexistants sont écartés', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'etape' }, { id: 'b', type: 'outro' }],
      links: [
        { id: 'l1', source: 'a', target: 'b' },
        { id: 'l2', source: 'a', target: 'fantome' },
        { id: 'l3', source: 'a', target: 'a' }
      ]
    });
    assert.equal(scn.links.length, 1);
    assert.equal(scn.links[0].target, 'b');
  });

  test('les doublons de nœuds et de liens sont éliminés', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'etape' }, { id: 'a', type: 'enigme' }, { id: 'b', type: 'etape' }],
      links: [{ source: 'a', target: 'b' }, { source: 'a', target: 'b' }]
    });
    assert.equal(scn.nodes.length, 2);
    assert.equal(scn.links.length, 1);
  });

  test('les positions incomplètes sont effacées', () => {
    const scn = migrateScenario({
      nodes: [
        { id: 'a', type: 'etape', position: { lat: null, lng: null } },
        { id: 'b', type: 'etape', position: { lat: 48.85, lng: 2.35 } }
      ]
    });
    assert.equal(scn.nodes[0].position, null);
    assert.deepEqual(scn.nodes[1].position, { lat: 48.85, lng: 2.35 });
  });

  test('un départ pointant vers un nœud supprimé est remis à zéro', () => {
    const scn = migrateScenario({ nodes: [{ id: 'a', type: 'etape' }], meta: { startNodeId: 'disparu' } });
    assert.equal(scn.meta.startNodeId, null);
  });

  test('les médias orphelins sont déréférencés', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'etape', media: { image: 'absent', audio: 'present' } }],
      assets: [{ id: 'present', name: 'son.mp3', type: 'audio/mpeg' }]
    });
    assert.equal(scn.nodes[0].media.image, undefined);
    assert.equal(scn.nodes[0].media.audio, 'present');
  });

  test('sans branche « si incorrect », le nœud passe en mode réessai', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'enigme' }, { id: 'b', type: 'outro' }],
      links: [{ source: 'a', target: 'b' }]
    });
    assert.equal(scn.nodes[0].onWrong, ON_WRONG.RETRY);
  });

  test('une branche « si incorrect » existante vaut intention de l\'auteur', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'enigme' }, { id: 'b', type: 'etape' }, { id: 'c', type: 'etape' }],
      links: [
        { source: 'a', target: 'b', condition: { type: 'correct' } },
        { source: 'a', target: 'c', condition: { type: 'incorrect' } }
      ]
    });
    assert.equal(scn.nodes[0].onWrong, ON_WRONG.CONTINUE);
  });

  test('un réglage explicite n\'est jamais écrasé', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'enigme', onWrong: ON_WRONG.RETRY }, { id: 'b', type: 'etape' }],
      links: [{ source: 'a', target: 'b', condition: { type: 'incorrect' } }]
    });
    assert.equal(scn.nodes[0].onWrong, ON_WRONG.RETRY);
  });

  test('une condition inconnue est neutralisée', () => {
    const scn = migrateScenario({
      nodes: [{ id: 'a', type: 'etape' }, { id: 'b', type: 'etape' }],
      links: [{ source: 'a', target: 'b', condition: { type: 'rm -rf' } }]
    });
    assert.equal(scn.links[0].condition, null);
  });

  test('un scénario valide traverse la migration sans perte', () => {
    const src = blankScenario();
    src.meta.title = 'Parcours du bois';
    src.nodes = [
      { id: 'i', type: 'intro', title: 'Départ', graphPos: { x: 10, y: 20 } },
      { id: 'e', type: 'enigme', title: 'La borne', question: 'Combien ?', answer: '7', position: { lat: 48.85, lng: 2.35 } }
    ];
    src.links = [{ id: 'l', source: 'i', target: 'e', condition: null }];
    src.meta.startNodeId = 'i';

    const out = migrateScenario(JSON.parse(JSON.stringify(src)));
    assert.equal(out.meta.title, 'Parcours du bois');
    assert.equal(out.nodes.length, 2);
    assert.equal(out.links.length, 1);
    assert.equal(out.meta.startNodeId, 'i');
    assert.equal(out.nodes[1].answer, '7');
    assert.deepEqual(out.nodes[0].graphPos, { x: 10, y: 20 });
  });

  test('la migration est idempotente', () => {
    const once = migrateScenario({
      nodes: [{ id: 'a', type: 'enigme', title: 'Q' }, { id: 'b', type: 'outro' }],
      links: [{ source: 'a', target: 'b' }]
    });
    const twice = migrateScenario(JSON.parse(JSON.stringify(once)));
    assert.deepEqual({ ...twice, updatedAt: 0 }, { ...once, updatedAt: 0 });
  });
});
