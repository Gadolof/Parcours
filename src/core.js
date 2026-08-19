/* ==========================================================
   PARCOURS — core
   Logique pure, sans DOM ni navigateur : c'est le seul module
   couvert par les tests (`node --test`).
   ========================================================== */

export const APP_VERSION = '0.2';
export const SCENARIO_VERSION = '0.2';

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
