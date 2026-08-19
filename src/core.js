/* ==========================================================
   PARCOURS — core
   Logique pure, sans DOM ni navigateur : c'est le seul module
   couvert par les tests (`node --test`).
   ========================================================== */

export const APP_VERSION = '0.3';
export const SCENARIO_VERSION = '0.3';

export const NODE_TYPES = ['etape', 'enigme', 'checkpoint', 'intro', 'outro'];

const TYPE_LABELS = {
  etape: 'Étape',
  enigme: 'Énigme',
  intro: 'Intro',
  outro: 'Outro',
  checkpoint: 'Checkpoint'
};

/** Libellé lisible d'un type de nœud. Source unique de vérité. */
export function typeLabel(type) {
  return TYPE_LABELS[type] || String(type ?? '');
}

/** Un type inconnu (scénario importé, forgé) ne doit jamais atteindre le DOM. */
export function isKnownType(type) {
  return NODE_TYPES.includes(type);
}

export function uid(prefix = 'n') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

export function debounce(fn, ms = 300) {
  let t;
  const wrapped = function (...args) {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  return wrapped;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function slugify(s, fallback = 'parcours') {
  const out = String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return out || fallback;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
  return (n / 1024 / 1024).toFixed(1) + ' Mo';
}

export function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Un nœud n'est « positionné » que si ses deux coordonnées existent.
 * L'inspecteur crée des objets position partiels pendant la saisie :
 * tester la seule présence de `position` compte des nœuds fantômes.
 */
export function hasPosition(node) {
  const p = node?.position;
  return !!p && p.lat != null && p.lng != null &&
         Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}

/** Comparaison des réponses : insensible à la casse, aux accents et aux espaces. */
export function normalizeAnswer(s) {
  return String(s ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

export function answersMatch(given, expected) {
  return normalizeAnswer(given) === normalizeAnswer(expected);
}

/** Distance orthodromique en mètres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- Tuiles ---------- */

export function latLngToTile(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

export function estimateTiles(bounds, minZ, maxZ) {
  let count = 0;
  for (let z = minZ; z <= maxZ; z++) {
    const nw = latLngToTile(bounds.north, bounds.west, z);
    const se = latLngToTile(bounds.south, bounds.east, z);
    count += (Math.abs(se.x - nw.x) + 1) * (Math.abs(se.y - nw.y) + 1);
  }
  return count;
}

/* ---------- Routage du joueur ---------- */

/**
 * Choisit le nœud suivant parmi les liens sortants.
 *
 * Règles, dans l'ordre :
 *   1. un lien conditionnel dont la condition est satisfaite ;
 *   2. le lien sans condition (repli voulu par l'auteur) ;
 *   3. à défaut, le premier lien sortant — un parcours ne doit jamais
 *      s'arrêter en silence parce qu'aucune condition ne correspond.
 *
 * Retourne `{ targetId, reason }`. `targetId` vaut null uniquement
 * lorsqu'il n'existe aucun lien sortant (fin légitime du parcours).
 */
export function pickNextNode(links, { correct = null, flags = [] } = {}) {
  if (!Array.isArray(links) || links.length === 0) {
    return { targetId: null, reason: 'no-links' };
  }
  const flagSet = new Set(flags);

  for (const l of links) {
    if (!l.condition) continue;
    const { type, value } = l.condition;
    if (type === 'correct' && correct === true) return { targetId: l.target, reason: 'condition' };
    if (type === 'incorrect' && correct === false) return { targetId: l.target, reason: 'condition' };
    if (type === 'flag' && flagSet.has(value)) return { targetId: l.target, reason: 'condition' };
  }

  const unconditional = links.find(l => !l.condition);
  if (unconditional) return { targetId: unconditional.target, reason: 'fallback' };

  return { targetId: links[0].target, reason: 'rescue' };
}

/* ---------- Réponse fausse ---------- */

export const ON_WRONG = { RETRY: 'retry', CONTINUE: 'continue' };

/**
 * Comportement d'un nœud face à une mauvaise réponse.
 * `retry` (défaut) garde le joueur sur place ; `continue` avance,
 * ce qui laisse `pickNextNode` emprunter une branche « si incorrect ».
 */
export function onWrongBehaviour(node) {
  return node?.onWrong === ON_WRONG.CONTINUE ? ON_WRONG.CONTINUE : ON_WRONG.RETRY;
}

/* ---------- Scénario ---------- */

export const DEFAULT_PROVIDER = 'carto';

function normaliseFlagList(raw) {
  if (!Array.isArray(raw)) return [];
  const vus = new Set();
  for (const f of raw) {
    const nom = String(f ?? '').trim();
    if (nom) vus.add(nom);
  }
  return [...vus];
}

export function blankScenario() {
  return {
    version: SCENARIO_VERSION,
    id: uid('scenario'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: {
      title: 'Nouveau parcours',
      description: '',
      author: '',
      duration: 90,
      difficulty: 'moyen',
      startNodeId: null,
      area: { center: [48.8566, 2.3522], zoom: 13 },
      tileProvider: DEFAULT_PROVIDER,
      showMapToPlayers: false
    },
    nodes: [],
    links: [],
    assets: []
  };
}

/**
 * Normalise un scénario venu du stockage ou d'un ZIP.
 *
 * Un `.zip` circule entre personnes : c'est une entrée qu'on ne
 * contrôle pas. Cette fonction ne fait jamais confiance à la structure
 * reçue — elle répare ce qui peut l'être et écarte le reste.
 */
export function migrateScenario(raw) {
  const base = blankScenario();
  if (!raw || typeof raw !== 'object') return base;

  const scn = {
    version: SCENARIO_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    meta: { ...base.meta, ...(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}) },
    nodes: [],
    links: [],
    assets: []
  };

  // --- Métadonnées ---
  if (!scn.meta.tileProvider) scn.meta.tileProvider = DEFAULT_PROVIDER;
  scn.meta.showMapToPlayers = !!scn.meta.showMapToPlayers;
  scn.meta.title = String(scn.meta.title ?? '');
  scn.meta.description = String(scn.meta.description ?? '');
  scn.meta.author = String(scn.meta.author ?? '');
  const area = scn.meta.area;
  if (!area || !Array.isArray(area.center) || area.center.length !== 2 ||
      !Number.isFinite(Number(area.center[0])) || !Number.isFinite(Number(area.center[1]))) {
    scn.meta.area = { ...base.meta.area };
  }

  // --- Nœuds ---
  const seen = new Set();
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!n || typeof n !== 'object') continue;
    if (typeof n.id !== 'string' || !n.id || seen.has(n.id)) continue;
    seen.add(n.id);

    const type = isKnownType(n.type) ? n.type : 'etape';
    const node = {
      ...n,
      id: n.id,
      type,
      title: String(n.title ?? typeLabel(type)),
      description: String(n.description ?? ''),
      graphPos: {
        x: Number(n.graphPos?.x) || 0,
        y: Number(n.graphPos?.y) || 0
      },
      media: n.media && typeof n.media === 'object' ? n.media : {},
      position: hasPosition(n) ? { lat: Number(n.position.lat), lng: Number(n.position.lng) } : null
    };
    if (type === 'enigme') {
      node.question = String(n.question ?? '');
      node.answer = String(n.answer ?? '');
    }
    // Flags : listes de noms, normalisées ici une fois pour toutes.
    node.setsFlags = normaliseFlagList(n.setsFlags);
    if (type === 'checkpoint') node.requiresFlags = normaliseFlagList(n.requiresFlags);
    else delete node.requiresFlags;
    scn.nodes.push(node);
  }

  // --- Liens (on écarte ceux qui pendent dans le vide) ---
  const linkKeys = new Set();
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (!l || typeof l !== 'object') continue;
    if (!seen.has(l.source) || !seen.has(l.target) || l.source === l.target) continue;
    const key = l.source + '→' + l.target;
    if (linkKeys.has(key)) continue;
    linkKeys.add(key);
    let condition = null;
    if (l.condition && ['correct', 'incorrect', 'flag'].includes(l.condition.type)) {
      condition = l.condition.type === 'flag'
        ? { type: 'flag', value: String(l.condition.value ?? '') }
        : { type: l.condition.type };
    }
    scn.links.push({
      id: typeof l.id === 'string' && l.id ? l.id : uid('link'),
      source: l.source,
      target: l.target,
      condition
    });
  }

  // --- Comportement sur réponse fausse ---
  // Avant la v0.2, une mauvaise réponse faisait toujours avancer. On ne
  // conserve ce comportement que là où l'auteur a câblé une branche
  // « si incorrect » : ailleurs, il valait fin de partie silencieuse.
  for (const n of scn.nodes) {
    if (n.onWrong === ON_WRONG.RETRY || n.onWrong === ON_WRONG.CONTINUE) continue;
    const hasIncorrectBranch = scn.links.some(
      l => l.source === n.id && l.condition?.type === 'incorrect'
    );
    n.onWrong = hasIncorrectBranch ? ON_WRONG.CONTINUE : ON_WRONG.RETRY;
  }

  // --- Assets ---
  for (const a of Array.isArray(raw.assets) ? raw.assets : []) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue;
    scn.assets.push({ ...a, name: String(a.name ?? 'sans-nom'), type: String(a.type ?? '') });
  }
  const assetIds = new Set(scn.assets.map(a => a.id));
  for (const n of scn.nodes) {
    if (n.media.image && !assetIds.has(n.media.image)) delete n.media.image;
    if (n.media.audio && !assetIds.has(n.media.audio)) delete n.media.audio;
  }

  // --- Départ ---
  if (!seen.has(scn.meta.startNodeId)) scn.meta.startNodeId = null;

  return scn;
}

/* ==========================================================
   Analyse du graphe
   ========================================================== */

/** Index { source -> liens } pour éviter les balayages répétés. */
function linksBySource(scn) {
  const map = new Map();
  for (const l of scn.links) {
    if (!map.has(l.source)) map.set(l.source, []);
    map.get(l.source).push(l);
  }
  return map;
}

/**
 * Ordre de visite depuis le nœud de départ, en largeur.
 *
 * C'est le seul numéro qui veut dire quelque chose pour l'auteur : la
 * position dans le tableau `nodes` ne reflète que l'ordre de création, et
 * se décale à la première suppression.
 *
 * @returns {Map<string, number>} nodeId -> numéro (à partir de 1)
 */
export function graphOrder(scn) {
  const order = new Map();
  if (!scn?.nodes?.length) return order;

  const byId = new Map(scn.nodes.map(n => [n.id, n]));
  const outgoing = linksBySource(scn);
  const start = byId.has(scn.meta?.startNodeId) ? scn.meta.startNodeId : null;

  let n = 1;
  const queue = start ? [start] : [];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    order.set(id, n++);
    for (const l of outgoing.get(id) || []) {
      if (byId.has(l.target) && !seen.has(l.target)) { seen.add(l.target); queue.push(l.target); }
    }
  }
  // Les nœuds hors du parcours gardent un numéro, à la suite, pour rester
  // désignables — mais ils sont signalés par validateScenario().
  for (const node of scn.nodes) if (!order.has(node.id)) order.set(node.id, n++);
  return order;
}

/** Ensemble des nœuds atteignables depuis le départ. */
export function reachableNodes(scn) {
  const reachable = new Set();
  const startId = scn?.meta?.startNodeId;
  if (!startId || !scn.nodes.some(n => n.id === startId)) return reachable;
  const outgoing = linksBySource(scn);
  const queue = [startId];
  reachable.add(startId);
  while (queue.length) {
    const id = queue.shift();
    for (const l of outgoing.get(id) || []) {
      if (!reachable.has(l.target)) { reachable.add(l.target); queue.push(l.target); }
    }
  }
  return reachable;
}

/**
 * Segments géographiques du parcours : un par lien dont les deux extrémités
 * sont positionnées. `distance` est en mètres.
 */
export function routeSegments(scn) {
  const byId = new Map((scn?.nodes || []).map(n => [n.id, n]));
  const segments = [];
  for (const l of scn?.links || []) {
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!hasPosition(a) || !hasPosition(b)) continue;
    segments.push({
      linkId: l.id,
      from: a.id,
      to: b.id,
      conditional: !!l.condition,
      coords: [[a.position.lat, a.position.lng], [b.position.lat, b.position.lng]],
      distance: haversine(a.position.lat, a.position.lng, b.position.lat, b.position.lng)
    });
  }
  return segments;
}

/**
 * Longueur du chemin principal — celui qu'on suit en répondant juste,
 * sans jamais emprunter de branche « si incorrect ».
 */
export function mainRouteDistance(scn) {
  const byId = new Map((scn?.nodes || []).map(n => [n.id, n]));
  const outgoing = linksBySource(scn);
  let total = 0;
  let id = scn?.meta?.startNodeId;
  const seen = new Set();
  while (id && byId.has(id) && !seen.has(id)) {
    seen.add(id);
    const links = outgoing.get(id) || [];
    const next = links.find(l => l.condition?.type === 'correct')
              || links.find(l => !l.condition)
              || links[0];
    if (!next) break;
    const a = byId.get(id), b = byId.get(next.target);
    if (hasPosition(a) && hasPosition(b)) {
      total += haversine(a.position.lat, a.position.lng, b.position.lat, b.position.lng);
    }
    id = next.target;
  }
  return total;
}

/**
 * Nombre d'étapes du chemin le plus court entre le départ et une fin
 * (nœud outro, ou nœud sans lien sortant).
 *
 * Sert de dénominateur à la barre de progression : `nodes.length` était
 * faux par construction dès qu'il y avait des branches.
 */
export function mainRouteLength(scn) {
  const byId = new Map((scn?.nodes || []).map(n => [n.id, n]));
  const startId = scn?.meta?.startNodeId;
  if (!byId.has(startId)) return scn?.nodes?.length || 0;

  const outgoing = linksBySource(scn);
  const queue = [[startId, 1]];
  const seen = new Set([startId]);
  let finOutro = null;
  let plusLoin = 1;

  while (queue.length) {
    const [id, depth] = queue.shift();
    plusLoin = Math.max(plusLoin, depth);
    // Une vraie fin, c'est un outro. Une impasse en est une aussi, mais
    // c'est une anomalie (validateScenario la signale) : elle ne doit pas
    // raccourcir la barre de progression de tout le monde.
    if (byId.get(id)?.type === 'outro') {
      finOutro = finOutro == null ? depth : Math.min(finOutro, depth);
      continue;
    }
    for (const l of outgoing.get(id) || []) {
      if (byId.has(l.target) && !seen.has(l.target)) { seen.add(l.target); queue.push([l.target, depth + 1]); }
    }
  }
  return finOutro ?? plusLoin;
}

/* ==========================================================
   Flags
   ========================================================== */

/** Flags qu'un nœud pose lorsqu'il est complété. */
export function flagsSetBy(node) {
  const raw = node?.setsFlags;
  if (!Array.isArray(raw)) return [];
  return raw.map(f => String(f || '').trim()).filter(Boolean);
}

/** Flags exigés par un checkpoint pour laisser passer. */
export function flagsRequiredBy(node) {
  if (node?.type !== 'checkpoint') return [];
  const raw = node?.requiresFlags;
  if (!Array.isArray(raw)) return [];
  return raw.map(f => String(f || '').trim()).filter(Boolean);
}

/** Ce qui manque à une équipe pour franchir un checkpoint. */
export function missingFlags(node, heldFlags = []) {
  const held = new Set(heldFlags);
  return flagsRequiredBy(node).filter(f => !held.has(f));
}

/** Tous les noms de flags employés dans un scénario, posés ou testés. */
export function allFlags(scn) {
  const flags = new Set();
  for (const n of scn?.nodes || []) {
    flagsSetBy(n).forEach(f => flags.add(f));
    flagsRequiredBy(n).forEach(f => flags.add(f));
  }
  for (const l of scn?.links || []) {
    if (l.condition?.type === 'flag' && l.condition.value) flags.add(l.condition.value);
  }
  return [...flags].sort();
}

/* ==========================================================
   Vérification du parcours
   ========================================================== */

const ERREUR = 'erreur';
const AVERTISSEMENT = 'avertissement';

/** ASCII imprimable : ce que le décodeur embarqué sait relire. */
const QR_SAFE = /^[\x20-\x7E]+$/;

/** Le contenu d'un QR est-il relisible par le scanner de l'application ? */
export function isQrValueSafe(valeur) {
  const v = String(valeur ?? '').trim();
  return v === '' || QR_SAFE.test(v);
}

/**
 * Passe le scénario en revue avant export. Chaque anomalie porte le nœud
 * concerné pour être cliquable depuis l'inspecteur.
 *
 * `erreur` : le parcours ne peut pas se jouer correctement.
 * `avertissement` : jouable, mais probablement pas ce que l'auteur voulait.
 */
export function validateScenario(scn) {
  const issues = [];
  const add = (severity, message, nodeId = null) => issues.push({ severity, message, nodeId });
  if (!scn) return issues;

  const nodes = scn.nodes || [];
  const links = scn.links || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const outgoing = linksBySource(scn);

  // --- Départ ---
  if (!nodes.length) {
    add(ERREUR, 'Le parcours ne contient aucun nœud.');
    return issues;
  }
  if (!scn.meta?.startNodeId) {
    add(ERREUR, 'Aucun nœud de départ défini : le Player ne saura pas par où commencer.');
  } else if (!byId.has(scn.meta.startNodeId)) {
    add(ERREUR, 'Le nœud de départ désigné n\'existe plus.');
  }

  // --- Fin ---
  if (!nodes.some(n => n.type === 'outro')) {
    add(AVERTISSEMENT, 'Aucun nœud outro : la partie se terminera sans écran de conclusion.');
  }

  // --- Accessibilité ---
  const reachable = reachableNodes(scn);
  if (reachable.size) {
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        add(AVERTISSEMENT, `« ${n.title} » n'est atteignable depuis aucun chemin.`, n.id);
      }
    }
  }

  for (const n of nodes) {
    const sortants = outgoing.get(n.id) || [];

    // --- Impasses ---
    if (n.type !== 'outro' && sortants.length === 0 && reachable.has(n.id)) {
      add(ERREUR, `« ${n.title} » n'a aucun lien sortant : la partie s'arrêtera là.`, n.id);
    }

    // --- Contenu de validation ---
    if (n.type !== 'intro' && n.type !== 'outro') {
      const v = n.validation || {};
      const valeur = String(v.value || '').trim();
      if ((v.type === 'qr' || v.type === 'code') && !valeur) {
        const quoi = v.type === 'qr' ? 'contenu de QR attendu' : 'code attendu';
        add(ERREUR, `« ${n.title} » attend un ${quoi}, mais aucun n'est renseigné.`, n.id);
      }
      // Un QR accentué s'encode sans problème mais le décodeur embarqué le
      // relit vide : sur le terrain, le scan ne correspondrait jamais.
      if (v.type === 'qr' && valeur && !QR_SAFE.test(valeur)) {
        add(ERREUR, `Le QR de « ${n.title} » contient des caractères que le scanner ne relit pas (accents, symboles). Utilise des lettres et chiffres simples.`, n.id);
      }
      if (v.type === 'gps' && !hasPosition(n)) {
        add(ERREUR, `« ${n.title} » valide par proximité GPS mais n'a pas de position.`, n.id);
      }
      if (!hasPosition(n) && v.type !== 'none') {
        add(AVERTISSEMENT, `« ${n.title} » n'a pas de position sur la carte.`, n.id);
      }
    }

    // --- Énigmes ---
    if (n.type === 'enigme') {
      if (!String(n.question || '').trim()) {
        add(AVERTISSEMENT, `« ${n.title} » n'a pas de question.`, n.id);
      }
      if (!String(n.answer || '').trim()) {
        add(ERREUR, `« ${n.title} » n'a pas de réponse attendue : aucune saisie ne pourra être juste.`, n.id);
      }
    }

    // --- Branches conditionnelles ---
    const conditionnels = sortants.filter(l => l.condition);
    const inconditionnels = sortants.filter(l => !l.condition);
    if (conditionnels.length && !inconditionnels.length) {
      const couvreIncorrect = conditionnels.some(l => l.condition.type === 'incorrect');
      const couvreCorrect = conditionnels.some(l => l.condition.type === 'correct');
      if (couvreCorrect && !couvreIncorrect) {
        add(AVERTISSEMENT,
          `« ${n.title} » n'a qu'une branche « si correct » et aucun repli : une mauvaise réponse n'aura nulle part où aller.`, n.id);
      }
    }
    if (inconditionnels.length > 1) {
      add(AVERTISSEMENT, `« ${n.title} » a ${inconditionnels.length} liens sans condition : seul le premier servira.`, n.id);
    }

    // --- Checkpoints ---
    if (n.type === 'checkpoint') {
      const requis = flagsRequiredBy(n);
      if (!requis.length) {
        add(AVERTISSEMENT, `« ${n.title} » est un checkpoint sans condition : il se comporte comme une étape.`, n.id);
      }
    }
  }

  // --- Flags : posés vs attendus ---
  const poses = new Set();
  for (const n of nodes) flagsSetBy(n).forEach(f => poses.add(f));
  const attendus = new Map();
  for (const l of links) {
    if (l.condition?.type === 'flag' && l.condition.value) {
      attendus.set(l.condition.value, byId.get(l.source));
    }
  }
  for (const n of nodes) {
    for (const f of flagsRequiredBy(n)) if (!attendus.has(f)) attendus.set(f, n);
  }
  for (const [flag, node] of attendus) {
    if (!poses.has(flag)) {
      add(ERREUR, `Le flag « ${flag} » est attendu mais aucun nœud ne le pose.`, node?.id || null);
    }
  }

  // --- Médias ---
  const assetIds = new Set((scn.assets || []).map(a => a.id));
  const utilises = new Set();
  for (const n of nodes) {
    for (const k of ['image', 'audio']) {
      const id = n.media?.[k];
      if (!id) continue;
      utilises.add(id);
      if (!assetIds.has(id)) add(ERREUR, `« ${n.title} » référence un média absent.`, n.id);
    }
  }
  for (const a of scn.assets || []) {
    if (!utilises.has(a.id)) {
      add(AVERTISSEMENT, `Le média « ${a.name} » n'est utilisé nulle part : il alourdit le ZIP pour rien.`);
    }
  }

  return issues;
}

export const SEVERITES = { ERREUR, AVERTISSEMENT };

/* ==========================================================
   Résultats — agrégation multi-équipes
   ========================================================== */

/** Un fichier de résultats exporté est-il exploitable ? */
export function isResultFile(data) {
  return !!data && typeof data === 'object'
      && typeof data.teamName === 'string'
      && Array.isArray(data.path);
}

/**
 * Classement d'un ensemble de fichiers de résultats.
 *
 * L'organisateur d'un événement à six équipes n'avait aucun moyen de
 * comparer : chaque équipe repartait avec son JSON dans son coin.
 */
export function buildRanking(fichiers) {
  const equipes = fichiers
    .filter(isResultFile)
    .filter(r => !r.testMode)
    .map(r => ({
      teamName: r.teamName,
      scenarioTitle: r.scenarioTitle || '',
      durationSec: Number(r.durationSec) || 0,
      totalSteps: Number(r.totalSteps) || (r.path?.length ?? 0),
      totalAttempts: Number(r.totalAttempts) || 0,
      // Un essai par étape, c'est un sans-faute. Au-delà, il y a eu reprise.
      erreurs: Math.max(0, (Number(r.totalAttempts) || 0) - (Number(r.totalSteps) || 0)),
      endedAt: r.endedAt || null,
      path: r.path || []
    }));

  // Le moins d'erreurs d'abord, le temps départage.
  equipes.sort((a, b) => a.erreurs - b.erreurs || a.durationSec - b.durationSec);
  equipes.forEach((e, i) => { e.rang = i + 1; });

  const titres = [...new Set(equipes.map(e => e.scenarioTitle).filter(Boolean))];
  return {
    equipes,
    scenarioTitle: titres.length === 1 ? titres[0] : null,
    melange: titres.length > 1,
    ignores: fichiers.length - equipes.length
  };
}

/** Temps moyen passé sur chaque étape, tous participants confondus. */
export function stepStats(classement) {
  const parNoeud = new Map();
  for (const equipe of classement.equipes) {
    for (const etape of equipe.path) {
      if (!parNoeud.has(etape.nodeId)) {
        parNoeud.set(etape.nodeId, { nodeId: etape.nodeId, title: etape.title, type: etape.type, durees: [], essais: [] });
      }
      const e = parNoeud.get(etape.nodeId);
      if (etape.durationSec != null) e.durees.push(etape.durationSec);
      e.essais.push(etape.attempts || 0);
    }
  }
  const moyenne = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return [...parNoeud.values()].map(e => ({
    nodeId: e.nodeId,
    title: e.title,
    type: e.type,
    equipes: e.essais.length,
    dureeMoyenne: Math.round(moyenne(e.durees)),
    dureeMax: e.durees.length ? Math.max(...e.durees) : 0,
    essaisMoyens: Math.round(moyenne(e.essais) * 10) / 10
  }));
}
