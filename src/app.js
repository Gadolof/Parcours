/* ==========================================================
   PARCOURS — v0.3
   Application autonome : éditeur + moteur de jeu
   La logique pure vit dans ./core.js (couverte par les tests).
   ========================================================== */

import {
  APP_VERSION, DEFAULT_PROVIDER, ON_WRONG, SEVERITES,
  allFlags, buildRanking, flagsRequiredBy, flagsSetBy, graphOrder, mainRouteDistance,
  stepStats,
  mainRouteLength, missingFlags, routeSegments, validateScenario,
  answersMatch, blankScenario, debounce, escapeHtml, estimateTiles,
  formatBytes, formatDate, hasPosition, haversine, latLngToTile,
  migrateScenario, onWrongBehaviour, pickNextNode, slugify, typeLabel, uid
} from './core.js';
import qrcode from '../vendor/qrcode.mjs';
import '../vendor/qrcode_UTF8.mjs';   // effet de bord : encode les accents

// ============================================================
// Utilitaires DOM
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Applique un objet de styles. `Object.assign` sur une CSSStyleDeclaration
 * ignore silencieusement les propriétés personnalisées : `--pct` n'était
 * jamais posé, et la barre de progression du joueur n'a jamais avancé.
 */
function applyStyle(node, styles) {
  for (const [prop, valeur] of Object.entries(styles)) {
    if (valeur == null) continue;
    if (prop.startsWith('--')) node.style.setProperty(prop, String(valeur));
    else node.style[prop] = valeur;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') applyStyle(node, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * « 0 nœud(s) » est le pluriel des machines. Le français en a un vrai,
 * et cette application soigne trop sa typographie pour s'en passer.
 */
function compte(n, singulier, pluriel = null) {
  const mot = n > 1 ? (pluriel || singulier + 's') : singulier;
  return `${n} ${mot}`;
}

// Détection mobile dynamique (respecte rotations/resize)
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

/**
 * Valeur résolue d'un token de la palette.
 *
 * Leaflet écrit ses couleurs dans les attributs SVG `stroke` et `fill`,
 * où `var(--forest)` ne se résout pas : le trait tombait en noir. On lit
 * donc la valeur calculée, ce qui garde une seule source de vérité.
 */
const cssVar = (nom, repli = '#000') =>
  getComputedStyle(document.documentElement).getPropertyValue(nom).trim() || repli;

// ============================================================
// IDB — wrapper minimal IndexedDB
// ============================================================
const IDB = {
  _db: null,
  _promise: null,
  DB_NAME: 'parcours',
  DB_VERSION: 2,

  open() {
    if (this._db) return Promise.resolve(this._db);
    if (this._promise) return this._promise;
    this._promise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onupgradeneeded = e => {
        const db = e.target.result;
        const tx = e.target.transaction;

        if (!db.objectStoreNames.contains('scenarios')) {
          db.createObjectStore('scenarios', { keyPath: 'id' });
        }

        const tiles = db.objectStoreNames.contains('tiles')
          ? tx.objectStore('tiles')
          : db.createObjectStore('tiles', { keyPath: 'key' });
        // v2 : sans cet index, compter les tuiles d'un fond exigeait de
        // charger tous les blobs en mémoire — une centaine de Mo pour
        // obtenir un entier. Les enregistrements portent déjà `provider`.
        if (!tiles.indexNames.contains('provider')) {
          tiles.createIndex('provider', 'provider', { unique: false });
        }

        // v2 : les médias quittent le document du scénario. En base64
        // dans le même enregistrement, chaque autosave réécrivait
        // l'intégralité des images.
        if (!db.objectStoreNames.contains('assets')) {
          const assets = db.createObjectStore('assets', { keyPath: 'id' });
          assets.createIndex('scenarioId', 'scenarioId', { unique: false });
        }
      };
    });
    return this._promise;
  },

  async _store(name, mode = 'readonly') {
    const db = await this.open();
    return db.transaction(name, mode).objectStore(name);
  },

  _req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },

  async put(store, value)     { return this._req((await this._store(store, 'readwrite')).put(value)); },
  async get(store, key)       { return this._req((await this._store(store)).get(key)); },
  async delete(store, key)    { return this._req((await this._store(store, 'readwrite')).delete(key)); },
  async getAll(store)         { return this._req((await this._store(store)).getAll()); },
  async count(store)          { return this._req((await this._store(store)).count()); },
  async clear(store)          { return this._req((await this._store(store, 'readwrite')).clear()); },

  /** Nombre d'enregistrements pour une valeur d'index — sans les charger. */
  async countByIndex(store, index, value) {
    const os = await this._store(store);
    return this._req(os.index(index).count(IDBKeyRange.only(value)));
  },

  /** Clés primaires pour une valeur d'index — sans charger les blobs. */
  async keysByIndex(store, index, value) {
    const os = await this._store(store);
    return this._req(os.index(index).getAllKeys(IDBKeyRange.only(value)));
  },

  async deleteMany(store, keys) {
    if (!keys.length) return 0;
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      keys.forEach(k => os.delete(k));
      tx.oncomplete = () => res(keys.length);
      tx.onerror = () => rej(tx.error);
    });
  }
};

// ============================================================
// Library — scénarios persistants (IndexedDB)
// ============================================================
const Library = {
  async list() {
    try {
      const all = await IDB.getAll('scenarios');
      return all.map(s => ({
        id: s.id,
        title: s.meta?.title || 'Sans titre',
        description: s.meta?.description || '',
        author: s.meta?.author || '',
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        nodeCount: s.nodes?.length || 0,
        linkCount: s.links?.length || 0,
        assetCount: s.assets?.length || 0
      })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch (e) { console.error(e); return []; }
  },
  async put(scenario) { return IDB.put('scenarios', scenario); },
  async get(id)       { return IDB.get('scenarios', id); },
  async delete(id)    { return IDB.delete('scenarios', id); }
};

// ============================================================
// AssetStore — médias binaires, hors du document du scénario
// ============================================================
const AssetStore = {
  _urls: new Map(), // assetId -> object URL, révoqués au changement de scénario

  async put(scenarioId, asset, blob) {
    await IDB.put('assets', {
      id: asset.id,
      scenarioId,
      name: asset.name,
      type: asset.type,
      size: blob.size,
      blob
    });
  },

  async getBlob(id) {
    const row = await IDB.get('assets', id);
    return row?.blob || null;
  },

  /**
   * URL utilisable dans un `src`. Le résultat est mémorisé : chaque
   * createObjectURL sans révocation est une fuite, et le rendu de
   * l'inspecteur en demanderait une par frappe.
   */
  async url(id) {
    if (this._urls.has(id)) return this._urls.get(id);
    const blob = await this.getBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this._urls.set(id, url);
    return url;
  },

  /** Pose le `src` dès que le blob est lu. */
  bind(element, id, attr = 'src') {
    this.url(id).then(url => { if (url) element[attr] = url; });
    return element;
  },

  releaseAll() {
    this._urls.forEach(url => URL.revokeObjectURL(url));
    this._urls.clear();
  },

  release(id) {
    const url = this._urls.get(id);
    if (url) { URL.revokeObjectURL(url); this._urls.delete(id); }
  },

  async remove(id) {
    this.release(id);
    await IDB.delete('assets', id);
  },

  async removeForScenario(scenarioId) {
    const keys = await IDB.keysByIndex('assets', 'scenarioId', scenarioId);
    keys.forEach(k => this.release(k));
    return IDB.deleteMany('assets', keys);
  },

  async totalSize(scenarioId) {
    const keys = await IDB.keysByIndex('assets', 'scenarioId', scenarioId);
    let total = 0;
    for (const k of keys) total += (await IDB.get('assets', k))?.size || 0;
    return total;
  },

  /**
   * Reprend les scénarios d'avant la v0.2, dont les médias étaient des
   * chaînes base64 inscrites dans le document lui-même.
   */
  async migrateInlineAssets(scn) {
    if (!scn?.assets?.length) return false;
    let migrated = false;
    for (const a of scn.assets) {
      if (!a.dataUrl) continue;
      try {
        const blob = await (await fetch(a.dataUrl)).blob();
        await this.put(scn.id, { ...a, type: a.type || blob.type }, blob);
        a.size = blob.size;
        delete a.dataUrl;
        migrated = true;
      } catch (e) {
        console.error('[assets] migration impossible :', a.name, e);
      }
    }
    return migrated;
  }
};

// ============================================================
// TILE_PROVIDERS — fonds de carte disponibles
// ============================================================
const TILE_PROVIDERS = {
  carto: {
    name: 'Carto Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap · © CARTO',
    maxZoom: 19,
    subdomains: ['a', 'b', 'c', 'd']
  },
  cartoPositron: {
    name: 'Carto Positron (clair)',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap · © CARTO',
    maxZoom: 19,
    subdomains: ['a', 'b', 'c', 'd']
  },
  osmfr: {
    name: 'OSM France',
    url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap France',
    maxZoom: 20,
    subdomains: ['a', 'b', 'c']
  },
  topo: {
    name: 'OpenTopoMap (reliefs)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap',
    maxZoom: 17,
    subdomains: ['a', 'b', 'c']
  },
  esriSat: {
    name: 'Esri Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri',
    maxZoom: 19,
    subdomains: null
  }
};

function buildTileUrl(providerId, z, x, y, subdomainIdx = 0) {
  const p = TILE_PROVIDERS[providerId] || TILE_PROVIDERS[DEFAULT_PROVIDER];
  let u = p.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (p.subdomains) u = u.replace('{s}', p.subdomains[subdomainIdx % p.subdomains.length]);
  return u;
}

// ============================================================
// TileCache — tuiles préfixées par provider (IndexedDB)
// ============================================================
const TileCache = {
  _key(provider, z, x, y) { return `${provider}/${z}/${x}/${y}`; },

  async get(provider, z, x, y) {
    try {
      const row = await IDB.get('tiles', this._key(provider, z, x, y));
      return row?.blob || null;
    } catch (e) { return null; }
  },

  async put(provider, z, x, y, blob) {
    try { return IDB.put('tiles', { key: this._key(provider, z, x, y), blob, provider, addedAt: Date.now() }); }
    catch (e) { /* quota : ignore */ }
  },

  async countAll() { try { return IDB.count('tiles'); } catch (e) { return 0; } },

  async countFor(provider) {
    try { return await IDB.countByIndex('tiles', 'provider', provider); }
    catch (e) { return 0; }
  },

  async clear() { return IDB.clear('tiles'); },

  async clearProvider(provider) {
    try {
      const keys = await IDB.keysByIndex('tiles', 'provider', provider);
      return await IDB.deleteMany('tiles', keys);
    } catch (e) { return 0; }
  },

  /** Présence d'une tuile sans transférer son blob. */
  async has(provider, z, x, y) {
    try {
      const os = await IDB._store('tiles');
      const k = await IDB._req(os.getKey(this._key(provider, z, x, y)));
      return k !== undefined;
    } catch (e) { return false; }
  },

  estimate(bounds, minZ, maxZ) { return estimateTiles(bounds, minZ, maxZ); },

  async precache(provider, bounds, minZ, maxZ, opts = {}) {
    const tiles = [];
    for (let z = minZ; z <= maxZ; z++) {
      const nw = latLngToTile(bounds.north, bounds.west, z);
      const se = latLngToTile(bounds.south, bounds.east, z);
      for (let x = Math.min(nw.x, se.x); x <= Math.max(nw.x, se.x); x++) {
        for (let y = Math.min(nw.y, se.y); y <= Math.max(nw.y, se.y); y++) {
          tiles.push({ z, x, y });
        }
      }
    }

    let done = 0, skipped = 0, errors = 0;
    const total = tiles.length;
    const notify = () => opts.onProgress?.({ done, total, skipped, errors });
    notify();

    // Une tuile à la fois plus 120 ms d'attente, c'était six minutes de
    // plancher pour 3 000 tuiles. Quelques requêtes en vol, avec le même
    // débit global, respectent tout autant le fournisseur.
    const concurrency = opts.concurrency || 4;
    const delayMs = opts.delayMs ?? 120;
    let cursor = 0;
    let subIdx = 0;

    const worker = async () => {
      while (cursor < tiles.length) {
        if (opts.isCancelled?.()) return;
        const t = tiles[cursor++];

        // `has()` interroge la clé sans transférer le blob.
        if (await this.has(provider, t.z, t.x, t.y)) {
          skipped++; done++; notify();
          continue;
        }
        try {
          const url = buildTileUrl(provider, t.z, t.x, t.y, subIdx++);
          const r = await fetch(url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          await this.put(provider, t.z, t.x, t.y, await r.blob());
        } catch (e) {
          errors++;
        }
        done++; notify();
        if (delayMs) await new Promise(r => setTimeout(r, delayMs * concurrency));
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
    return { done, total, skipped, errors };
  }
};

// ============================================================
// createCachedTileLayer — lit IDB d'abord, fallback réseau
// ============================================================
function createCachedTileLayer(providerId) {
  const provider = TILE_PROVIDERS[providerId] || TILE_PROVIDERS[DEFAULT_PROVIDER];
  const options = {
    attribution: provider.attribution,
    maxZoom: provider.maxZoom
  };
  if (provider.subdomains) options.subdomains = provider.subdomains;

  const layer = L.tileLayer(provider.url, options);
  layer._providerId = providerId;

  // Chaque tuile servie depuis le cache crée un object URL. Leaflet détruit
  // les tuiles sorties de l'écran, mais l'URL, elle, retenait le blob : la
  // mémoire grimpait à chaque panoramique jusqu'à faire tomber l'onglet.
  layer.on('tileunload', e => {
    const src = e.tile?.src;
    if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
  });
  layer.on('remove', () => {
    for (const key in layer._tiles) {
      const src = layer._tiles[key]?.el?.src;
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
    }
  });

  layer.createTile = function(coords, done) {
    const tile = document.createElement('img');
    tile.setAttribute('role', 'presentation');
    tile.alt = '';
    (async () => {
      const cached = await TileCache.get(this._providerId, coords.z, coords.x, coords.y);
      if (cached) {
        tile.src = URL.createObjectURL(cached);
        tile.onload  = () => done(null, tile);
        tile.onerror = () => done(new Error('decode'), tile);
        return;
      }
      try {
        const url = this.getTileUrl(coords);
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        TileCache.put(this._providerId, coords.z, coords.x, coords.y, blob).catch(() => {});
        tile.src = URL.createObjectURL(blob);
        tile.onload  = () => done(null, tile);
        tile.onerror = () => done(new Error('decode'), tile);
      } catch (e) {
        // Fallback : laisse Leaflet charger via src direct
        tile.src = this.getTileUrl(coords);
        tile.onload  = () => done(null, tile);
        tile.onerror = () => done(e, tile);
      }
    })();
    return tile;
  };
  return layer;
}

// ============================================================
// Offline — service worker, persistance, quota
// ============================================================
const Offline = {
  registration: null,

  /**
   * Le service worker est ce qui rend la promesse « hors ligne » réelle :
   * sans lui, l'application ne s'ouvre pas quand il n'y a pas de réseau.
   */
  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Un service worker exige un contexte sécurisé. En http:// sur une IP
    // locale, on ne s'en plaint pas : c'est le cas du développement.
    if (!window.isSecureContext) return;
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      this.registration = reg;
      if (reg.waiting) this._announceUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // controller null = première installation : rien à annoncer.
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            this._announceUpdate(sw);
          }
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (e) {
      console.error('[offline] enregistrement du service worker :', e);
    }
  },

  _announceUpdate(worker) {
    Toast.action('Nouvelle version disponible', 'Recharger', () => worker.postMessage('SKIP_WAITING'));
  },

  /**
   * Sans persistance, le navigateur peut évincer IndexedDB sous pression
   * de stockage — c'est-à-dire perdre scénarios et tuiles, sur un
   * téléphone plein, un jour d'événement.
   */
  async requestPersistence() {
    if (!navigator.storage?.persist) return null;
    try {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch (e) { return null; }
  },

  async estimate() {
    if (!navigator.storage?.estimate) return null;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    } catch (e) { return null; }
  }
};

// ============================================================
// Toast
// ============================================================
const Toast = {
  container: null,
  init() { this.container = $('#toasts'); },
  show(message, kind = 'info', ms = 3000) {
    const icons = { info: 'i', ok: '✓', warn: '!', error: '×' };
    const actualKind = kind === 'ok' ? 'info' : kind;
    const t = el('div', {
      class: `toast ${actualKind}`,
      // Une erreur interrompt la lecture en cours ; le reste attend.
      role: kind === 'error' ? 'alert' : 'status'
    },
      el('span', { class: 'icon', 'aria-hidden': 'true' }, icons[kind] || 'i'),
      el('span', {}, message)
    );
    this.container.appendChild(t);
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 200);
    }, ms);
  },
  /** Toast persistant portant une action — mise à jour, reprise… */
  action(message, label, onClick) {
    const t = el('div', { class: 'toast info with-action', role: 'status' },
      el('span', { class: 'icon', 'aria-hidden': 'true' }, '↻'),
      el('span', {}, message),
      el('button', {
        class: 'toast-action',
        onclick: () => { t.remove(); onClick(); }
      }, label),
      el('button', { class: 'toast-close', 'aria-label': 'Ignorer', onclick: () => t.remove() }, '✕')
    );
    this.container.appendChild(t);
    return t;
  },

  ok(m)    { this.show(m, 'ok'); },
  info(m)  { this.show(m, 'info'); },
  warn(m)  { this.show(m, 'warn'); },
  error(m) { this.show(m, 'error', 4000); }
};

// ============================================================
// Tutorial — onboarding éditeur
// ============================================================
const Tutorial = {
  SEEN_KEY: 'parcours.tutoSeen',
  _step: 0,
  _overlay: null,
  _steps: null,

  start(force = false) {
    if (!force && localStorage.getItem(this.SEEN_KEY)) return;
    this._step = 0;
    this._buildSteps();
    this._render();
  },

  _buildSteps() {
    const mobile = isMobile();
    this._steps = [
      {
        title: 'Bienvenue',
        body: `<p>Ce petit tour te montre comment construire un parcours en <strong>2 minutes</strong>. Tu peux le rouvrir plus tard via le bouton <code>?</code> en bas à gauche.</p>
               <p>L'éditeur est un <strong>split-screen</strong> : la carte à gauche (le <em>où</em>), le graphe à droite (le <em>dans quel ordre</em>). Les deux sont synchronisés.</p>`,
        target: null,
        center: true
      },
      {
        title: 'Créer un nœud',
        body: mobile
          ? `<p>Touche le gros bouton <strong>+</strong> en bas à droite, choisis un <strong>type</strong> (étape, énigme…), puis touche la carte à l'endroit voulu.</p>
             <p>Pour <code>intro</code> ou <code>outro</code>, pas besoin de position : ils se créent directement dans le graphe.</p>`
          : `<p>Dans la <strong>palette</strong> à gauche, attrape un type de nœud et <strong>glisse-le</strong> vers la carte (pour le placer géographiquement) ou vers le graphe (sans position).</p>
             <p>Tu peux aussi re-glisser les markers sur la carte pour ajuster leur position.</p>`,
        target: mobile ? '#fab-add' : '#palette',
        pos: mobile ? 'top' : 'right'
      },
      {
        title: 'Relier deux nœuds',
        body: `<p>C'est la partie qui surprend au début. Dans le <strong>graphe</strong>, chaque nœud a :</p>
               <div class="demo-link">
                 <div class="from">A</div>
                 <div class="arrow"></div>
                 <div class="to">B</div>
               </div>
               <p>→ un <strong>petit cercle noir à droite</strong> (la sortie)<br>
               → un <strong>petit cercle blanc à gauche</strong> (l'entrée)</p>
               <p><strong>Clique-maintiens</strong> sur le cercle noir du nœud source, <strong>glisse un trait</strong> jusqu'au cercle blanc du nœud cible, puis <strong>relâche</strong>.</p>
               <p>Pour <strong>supprimer un lien</strong> : clique dessus (il devient rouge), puis <kbd>Suppr</kbd>. Ou depuis l'inspecteur du nœud, bouton <code>✕</code>.</p>`,
        target: '#graph',
        pos: 'left',
        spotlight: true
      },
      {
        title: 'Conditions sur les liens',
        body: `<p>Un lien peut être <strong>conditionnel</strong>. Dans l'inspecteur du nœud source, section <em>Liens</em>, clique sur <code>Cond.</code>.</p>
               <p>Tu peux router selon :</p>
               <p>→ <strong>Si correct</strong> — si la réponse est juste<br>
               → <strong>Si incorrect</strong> — pour une branche alternative<br>
               → <strong>Si flag</strong> — pour des conditions avancées</p>
               <p>S'il y a plusieurs liens sortants, les conditionnels sont évalués d'abord, le lien sans condition sert de fallback.</p>`,
        target: null,
        center: true
      },
      {
        title: 'Définir le départ',
        body: `<p>Sélectionne un nœud, puis dans l'inspecteur clique <strong>"Définir comme départ"</strong>. C'est par là que le Player commencera la partie.</p>
               <p>Onglet <em>Scénario</em> → tu peux aussi choisir le départ dans la liste déroulante.</p>`,
        target: null,
        center: true
      },
      {
        title: 'Tester et partager',
        body: `<p>Bouton <strong>▶ Tester</strong> dans l'onglet Scénario → tu lances une partie avec un panneau de contrôle pour sauter d'un nœud à l'autre.</p>
               <p>Quand c'est prêt : <strong>Exporter .zip</strong> → envoie à ton équipe. Ils ouvriront le ZIP depuis la page d'accueil et pourront jouer <strong>hors ligne</strong> (pense à pré-cacher les tuiles de la zone avant).</p>
               <p style="color:var(--forest-dark);font-weight:500;">Bonne route !</p>`,
        target: null,
        center: true
      }
    ];
  },

  _render() {
    this._cleanup();
    const step = this._steps[this._step];
    if (!step) { this.finish(); return; }

    const overlay = el('div', { class: 'tuto-overlay' });
    const backdrop = el('div', { class: 'tuto-backdrop' });
    overlay.appendChild(backdrop);

    // Clip-path spotlight (découpe un trou dans le backdrop)
    if (step.target && step.spotlight !== false) {
      const targetEl = document.querySelector(step.target);
      if (targetEl) {
        const r = targetEl.getBoundingClientRect();
        const pad = 8;
        const x1 = Math.max(0, r.left - pad);
        const y1 = Math.max(0, r.top - pad);
        const x2 = Math.min(window.innerWidth, r.right + pad);
        const y2 = Math.min(window.innerHeight, r.bottom + pad);
        // Polygon "evenodd" qui exclut le rectangle cible
        backdrop.style.clipPath = `polygon(
          0 0, 100% 0, 100% 100%, 0 100%, 0 0,
          ${x1}px ${y1}px,
          ${x1}px ${y2}px,
          ${x2}px ${y2}px,
          ${x2}px ${y1}px,
          ${x1}px ${y1}px
        )`;
      }
    }

    // Bulle
    const bubble = el('div', { class: 'tuto-bubble' });
    bubble.innerHTML = `
      <div class="step">Étape ${this._step + 1} / ${this._steps.length}</div>
      <h3>${step.title}</h3>
      ${step.body}
    `;
    const actions = el('div', { class: 'tuto-actions' });
    const dots = el('div', { class: 'progress-dots' });
    this._steps.forEach((_, i) => {
      const d = el('span');
      if (i < this._step) d.classList.add('done');
      if (i === this._step) d.classList.add('active');
      dots.appendChild(d);
    });
    actions.appendChild(dots);

    const btns = el('div', { class: 'btn-row', style: { margin: 0 } });
    if (this._step > 0) {
      btns.appendChild(el('button', {
        class: 'btn ghost small',
        onclick: () => { this._step--; this._render(); }
      }, '← Précédent'));
    }
    const isLast = this._step === this._steps.length - 1;
    btns.appendChild(el('button', {
      class: 'btn accent small',
      onclick: () => {
        if (isLast) this.finish();
        else { this._step++; this._render(); }
      }
    }, isLast ? 'Terminer' : 'Suivant →'));
    actions.appendChild(btns);

    bubble.appendChild(actions);

    // Skip en haut à droite
    const skip = el('button', {
      style: {
        position: 'absolute',
        top: '10px', right: '10px',
        background: 'none', border: 'none',
        color: 'var(--ink-faint)', cursor: 'pointer',
        fontSize: '18px', padding: '4px 8px', lineHeight: '1'
      },
      'aria-label': 'Passer',
      onclick: () => this.finish()
    }, '✕');
    bubble.appendChild(skip);

    overlay.appendChild(bubble);
    document.body.appendChild(overlay);
    this._overlay = overlay;

    // Positionnement
    this._positionBubble(bubble, step);

    // Reposition sur resize/scroll
    this._onResize = () => this._positionBubble(bubble, step);
    window.addEventListener('resize', this._onResize);
  },

  _positionBubble(bubble, step) {
    // Sur mobile la bulle est étirée bord à bord par la CSS (left/right).
    // Le translate(-50%) du centrage la faisait alors sortir par la gauche.
    if (isMobile()) {
      bubble.style.transform = 'none';
      bubble.style.left = '';
      const h = bubble.offsetHeight;
      const top = Math.max(12, (window.innerHeight - h) / 2);
      bubble.style.top = Math.min(top, Math.max(12, window.innerHeight - h - 12)) + 'px';
      bubble.classList.remove('pos-top', 'pos-bottom', 'pos-left', 'pos-right');
      return;
    }

    // Par défaut, centré
    if (step.center || !step.target) {
      bubble.style.top = '50%';
      bubble.style.left = '50%';
      bubble.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const targetEl = document.querySelector(step.target);
    if (!targetEl) {
      bubble.style.top = '50%';
      bubble.style.left = '50%';
      bubble.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const r = targetEl.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const gap = 16;
    const pad = 12;

    let top, left, posClass = '';
    const pos = step.pos || 'right';

    if (pos === 'right' && r.right + gap + bw < window.innerWidth - pad) {
      left = r.right + gap;
      top = r.top + r.height / 2 - bh / 2;
      posClass = 'pos-right';
    } else if (pos === 'left' && r.left - gap - bw > pad) {
      left = r.left - gap - bw;
      top = r.top + r.height / 2 - bh / 2;
      posClass = 'pos-left';
    } else if (pos === 'top' && r.top - gap - bh > pad) {
      top = r.top - gap - bh;
      left = r.left + r.width / 2 - bw / 2;
      posClass = 'pos-top';
    } else if (pos === 'bottom') {
      top = r.bottom + gap;
      left = r.left + r.width / 2 - bw / 2;
      posClass = 'pos-bottom';
    } else {
      // Fallback : centré
      bubble.style.top = '50%';
      bubble.style.left = '50%';
      bubble.style.transform = 'translate(-50%, -50%)';
      return;
    }

    // Clamp dans la viewport
    left = Math.max(pad, Math.min(left, window.innerWidth - bw - pad));
    top  = Math.max(pad, Math.min(top,  window.innerHeight - bh - pad));

    bubble.style.top = top + 'px';
    bubble.style.left = left + 'px';
    bubble.style.transform = 'none';
    bubble.classList.remove('pos-top', 'pos-bottom', 'pos-left', 'pos-right');
    if (posClass) bubble.classList.add(posClass);
  },

  finish() {
    this._cleanup();
    localStorage.setItem(this.SEEN_KEY, '1');
  },

  _cleanup() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
  }
};
const Scenario = {
  current: null,
  listeners: new Set(),

  blank() { return blankScenario(); },

  load(data) {
    // Les object URLs du scénario précédent n'ont plus de raison d'être.
    AssetStore.releaseAll();
    // Toute donnée entrante (stockage, ZIP partagé) passe par la
    // normalisation du noyau avant de devenir l'état courant.
    this.current = migrateScenario(data);
    this.touch(false);
    History.reset();
    this.emit('load');

    // Médias hérités de la v0.1 (base64 dans le document) : on les sort
    // vers leur store, sans bloquer l'affichage.
    const id = this.current.id;
    AssetStore.migrateInlineAssets(this.current).then(migrated => {
      if (!migrated || this.current?.id !== id) return;
      Storage.save?.();
      this.emit('assetsMigrated');
      Inspector.render?.();
    }).catch(console.error);
  },

  /**
   * @param {boolean|string} markDirty  un identifiant de groupe (clé du
   *   champ édité) au lieu de `true` fusionne les frappes successives dans
   *   une seule entrée d'historique.
   */
  touch(markDirty = true) {
    if (!this.current) return;
    this.current.updatedAt = Date.now();
    if (markDirty === false) return;
    History.enregistrer(typeof markDirty === 'string' ? markDirty : null);
    App.markDirty();
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit(evt, payload) {
    this.listeners.forEach(fn => fn(evt, payload));
  },

  // --- Nœuds ---
  addNode(type, overrides = {}) {
    const n = {
      id: uid('node'),
      type,
      title: ({
        etape: 'Nouvelle étape',
        enigme: 'Nouvelle énigme',
        intro: 'Introduction',
        outro: 'Conclusion',
        checkpoint: 'Checkpoint'
      })[type] || 'Nœud',
      description: '',
      position: null,
      graphPos: { x: 100, y: 100 },
      media: {},
      validation: null,
      ...overrides
    };
    // Une énigme se valide par sa réponse : lui donner en plus une
    // validation QR affichait un réglage sans effet, et la vérification
    // en réclamait le contenu.
    if (type === 'etape' || type === 'checkpoint') {
      if (!n.validation) n.validation = { type: 'qr', value: '', radius: 20 };
    } else {
      // Même forme qu'après migration : pas de champ du tout, plutôt qu'un
      // `null` qui ressemble à un réglage vidé.
      delete n.validation;
    }
    if (type === 'etape' || type === 'enigme' || type === 'checkpoint') {
      if (!n.onWrong) n.onWrong = ON_WRONG.RETRY;
    }
    if (type === 'enigme') {
      n.question = n.question || '';
      n.answer = n.answer || '';
    }
    this.current.nodes.push(n);
    this.touch();
    this.emit('nodeAdded', n);
    return n;
  },

  updateNode(id, patch) {
    const n = this.current.nodes.find(x => x.id === id);
    if (!n) return;
    Object.assign(n, patch);
    this.touch();
    this.emit('nodeUpdated', n);
  },

  removeNode(id) {
    const idx = this.current.nodes.findIndex(x => x.id === id);
    if (idx < 0) return;
    this.current.nodes.splice(idx, 1);
    this.current.links = this.current.links.filter(l => l.source !== id && l.target !== id);
    if (this.current.meta.startNodeId === id) this.current.meta.startNodeId = null;
    this.touch();
    this.emit('nodeRemoved', id);
  },

  getNode(id) { return this.current.nodes.find(n => n.id === id); },

  // --- Liens ---
  addLink(source, target, condition = null) {
    if (source === target) return null;
    const exists = this.current.links.find(l => l.source === source && l.target === target);
    if (exists) return exists;
    const link = { id: uid('link'), source, target, condition };
    this.current.links.push(link);
    this.touch();
    this.emit('linkAdded', link);
    return link;
  },

  updateLink(id, patch) {
    const l = this.current.links.find(x => x.id === id);
    if (!l) return;
    Object.assign(l, patch);
    this.touch();
    this.emit('linkUpdated', l);
  },

  removeLink(id) {
    const idx = this.current.links.findIndex(x => x.id === id);
    if (idx < 0) return;
    this.current.links.splice(idx, 1);
    this.touch();
    this.emit('linkRemoved', id);
  },

  getLinksFrom(id) { return this.current.links.filter(l => l.source === id); },
  getLinksTo(id)   { return this.current.links.filter(l => l.target === id); },

  // --- Meta ---
  updateMeta(patch) {
    Object.assign(this.current.meta, patch);
    this.touch();
    this.emit('metaUpdated');
  },

  // --- Assets ---
  addAsset(asset) {
    this.current.assets.push(asset);
    this.touch();
    this.emit('assetAdded', asset);
  },
  removeAsset(id) {
    const idx = this.current.assets.findIndex(a => a.id === id);
    if (idx < 0) return;
    this.current.assets.splice(idx, 1);
    // Nettoyer les références
    this.current.nodes.forEach(n => {
      if (n.media?.image === id) delete n.media.image;
      if (n.media?.audio === id) delete n.media.audio;
    });
    this.touch();
    this.emit('assetRemoved', id);
  }
};

// ============================================================
// History — annuler / rétablir
// ============================================================
const History = {
  MAX: 60,
  /** Frappes consécutives sur le même champ, regroupées en une entrée. */
  FUSION_MS: 900,
  _passe: [],
  _futur: [],
  _reference: null,
  _gele: false,
  _dernierGroupe: null,
  _dernierInstant: 0,

  /**
   * Instantanés JSON du scénario. C'est grossier, mais les médias vivent
   * désormais dans leur propre store : un scénario ne pèse plus que
   * quelques dizaines de kilo-octets, et le code reste lisible.
   */
  _snapshot() {
    return Scenario.current ? JSON.stringify(Scenario.current) : null;
  },

  /** Repart de zéro sur un nouveau scénario. */
  reset() {
    // Annuler recharge le scénario, ce qui rappelle ici : sans ce garde,
    // le premier « annuler » viderait la pile qu'il vient d'utiliser.
    if (this._gele) { this._reference = this._snapshot(); return; }
    this._passe = [];
    this._futur = [];
    this._reference = this._snapshot();
    this._dernierGroupe = null;
    this._notifier();
  },

  /**
   * Ferme le groupe en cours : la prochaine modification ouvrira sa propre
   * entrée. À appeler quand on quitte un champ ou qu'on change de sujet.
   */
  cloreGroupe() { this._dernierGroupe = null; },

  /**
   * Enregistre l'état *précédent* le changement. Appelé après coup par
   * Scenario.touch() : la référence retenue est celle d'avant la mutation.
   */
  /**
   * @param {string|null} groupe  identifiant du champ édité. Deux appels
   *   consécutifs portant le même groupe, à moins d'une seconde d'écart,
   *   partagent une seule entrée : sinon, annuler un titre de quinze
   *   lettres demandait quinze annulations — chacune reconstruisant tout
   *   l'éditeur.
   */
  enregistrer(groupe = null) {
    if (this._gele) return;
    const avant = this._reference;
    const apres = this._snapshot();
    if (avant === null || avant === apres) { this._reference = apres; return; }

    const maintenant = Date.now();
    const prolonge = groupe != null
      && groupe === this._dernierGroupe
      && maintenant - this._dernierInstant < this.FUSION_MS
      && this._passe.length > 0;

    this._dernierGroupe = groupe;
    this._dernierInstant = maintenant;
    this._reference = apres;

    // On prolonge le groupe : l'état d'avant la première frappe est déjà
    // en pile, il n'y a rien à empiler de plus.
    if (prolonge) { this._notifier(); return; }

    this._passe.push(avant);
    if (this._passe.length > this.MAX) this._passe.shift();
    this._futur.length = 0;
    this._notifier();
  },

  get peutAnnuler() { return this._passe.length > 0; },
  get peutRetablir() { return this._futur.length > 0; },

  annuler() { return this._appliquer(this._passe, this._futur); },
  retablir() { return this._appliquer(this._futur, this._passe); },

  _appliquer(source, destination) {
    if (!source.length) return false;
    const cible = source.pop();
    destination.push(this._snapshot());
    this._gele = true;
    try {
      Scenario.load(JSON.parse(cible));
      Editor.rebuild();
      Storage.save?.();
    } finally {
      this._gele = false;
      this._reference = this._snapshot();
    }
    this._notifier();
    return true;
  },

  _abonnes: new Set(),
  on(fn) { this._abonnes.add(fn); return () => this._abonnes.delete(fn); },
  _notifier() { this._abonnes.forEach(fn => fn()); }
};

// ============================================================
// Storage — autosave debounced vers IndexedDB (via Library)
// ============================================================
const Storage = {
  LAST_KEY: 'parcours.lastId',

  save: null,
  init() {
    this._write = async () => {
      if (!Scenario.current) return;
      try {
        await Library.put(Scenario.current);
        localStorage.setItem(this.LAST_KEY, Scenario.current.id);
        App.markClean();
      } catch (e) {
        Toast.error('Sauvegarde impossible');
        console.error(e);
      }
    };
    this.save = debounce(this._write, 800);
  },

  /** Écrit sans attendre la fin du debounce. */
  flush() {
    this.save?.cancel();
    return this._write?.();
  },

  async loadLast() {
    const id = localStorage.getItem(this.LAST_KEY);
    if (!id) return null;
    try { return await Library.get(id); } catch (e) { return null; }
  },

  setCurrent(id) { localStorage.setItem(this.LAST_KEY, id); },

  // Migration depuis l'ancien stockage localStorage (v0.1 pré-IDB)
  async migrateLegacy() {
    try {
      const raw = localStorage.getItem('parcours.current');
      if (!raw) return null;
      const scn = JSON.parse(raw);
      if (scn?.id) {
        await Library.put(scn);
        localStorage.setItem(this.LAST_KEY, scn.id);
        localStorage.removeItem('parcours.current');
        Toast.info('Scénario migré vers la bibliothèque');
        return scn;
      }
    } catch (e) { console.error('Migration :', e); }
    return null;
  }
};

// ============================================================
// FormBuilder — rendu de formulaires par schéma
// ============================================================
const FormBuilder = {
  /**
   * schema: [
   *   { key: 'title', label: 'Titre', type: 'text', placeholder: '...' },
   *   { key: 'description', label: 'Description', type: 'textarea' },
   *   { key: 'difficulty', label: 'Difficulté', type: 'select', options: [['facile','Facile'], ['moyen','Moyen']] },
   *   { key: 'position.lat', label: 'Lat', type: 'number', step: 0.000001 },
   *   { key: 'duration', label: 'Durée (min)', type: 'number', min: 1 }
   * ]
   */
  render(schema, data, onChange) {
    const form = el('div', { class: 'form' });

    schema.forEach(field => {
      if (field.type === 'group-inline') {
        const row = el('div', { class: 'field inline' });
        field.fields.forEach(f => row.appendChild(this._renderField(f, data, onChange)));
        form.appendChild(row);
      } else if (field.type === 'heading') {
        form.appendChild(el('h3', {}, field.label));
      } else if (field.type === 'custom' && field.render) {
        form.appendChild(field.render(data, onChange));
      } else {
        form.appendChild(this._renderField(field, data, onChange));
      }
    });

    return form;
  },

  /**
   * Chaque champ notifie `onChange(key, value, field)`. C'est à l'appelant
   * de décider s'il doit re-rendre : un `render()` systématique détruit
   * l'input en cours de saisie et le focus part au bout d'une lettre.
   */
  _renderField(field, data, onChange) {
    const wrap = el('div', { class: 'field' });
    // Un <label> sans `for` ne sert à rien : ni clic pour donner le focus,
    // ni annonce par un lecteur d'écran.
    const id = `champ-${field.key.replace(/[^a-z0-9]+/gi, '-')}-${uid('f')}`;
    if (field.label) wrap.appendChild(el('label', { for: id }, field.label));
    const value = this._get(data, field.key);

    let input;
    if (field.type === 'textarea') {
      input = el('textarea', {
        placeholder: field.placeholder || '',
        rows: field.rows || 3,
        oninput: e => { this._set(data, field.key, e.target.value); onChange(field.key, e.target.value, field); }
      });
      input.value = value ?? '';
    } else if (field.type === 'select') {
      input = el('select', {
        onchange: e => { this._set(data, field.key, e.target.value); onChange(field.key, e.target.value, field); }
      });
      (field.options || []).forEach(([v, label]) => {
        const opt = el('option', { value: v }, label);
        if (String(value) === String(v)) opt.selected = true;
        input.appendChild(opt);
      });
    } else if (field.type === 'number') {
      input = el('input', {
        type: 'number',
        placeholder: field.placeholder || '',
        step: field.step || 1,
        min: field.min,
        max: field.max,
        oninput: e => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          this._set(data, field.key, v); onChange(field.key, v, field);
        }
      });
      if (value != null) input.value = value;
    } else {
      input = el('input', {
        type: field.type || 'text',
        placeholder: field.placeholder || '',
        oninput: e => { this._set(data, field.key, e.target.value); onChange(field.key, e.target.value, field); }
      });
      input.value = value ?? '';
    }
    // Sortir du champ clôt le groupe : la modification suivante s'annulera
    // séparément, même si elle survient dans la seconde.
    input.addEventListener('blur', () => History.cloreGroupe());
    input.id = id;
    if (field.hint) {
      const aideId = id + '-aide';
      input.setAttribute('aria-describedby', aideId);
      wrap.appendChild(input);
      wrap.appendChild(el('div', { class: 'field-hint', id: aideId }, field.hint));
      return wrap;
    }
    wrap.appendChild(input);
    return wrap;
  },

  _get(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  },
  _set(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => {
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, obj);
    target[last] = value;
  }
};

// ============================================================
// Inspector — onglets Nœud / Scénario / Assets
// ============================================================
const Inspector = {
  root: null,
  activeTab: 'scenario', // 'node' | 'scenario' | 'assets'
  selectedNodeId: null,

  mount(root) {
    this.root = root;
    this.render();
  },

  unmount() {
    this.root = null;
    this._headerTitleEl = null;
    this.selectedNodeId = null;
    this.activeTab = 'scenario';
  },

  setSelection(nodeId) {
    this.selectedNodeId = nodeId;
    if (nodeId) this.activeTab = 'node';
    this.render();
  },

  setTab(tab) {
    this.activeTab = tab;
    this.render();
  },

  render() {
    if (!this.root) return;
    this.root.innerHTML = '';

    // Handle en haut (mobile seulement, via CSS)
    const handle = el('div', { class: 'inspector-handle' },
      el('span', { class: 'title' }, 'Inspecteur'),
      el('button', {
        class: 'close-btn',
        'aria-label': 'Fermer',
        onclick: () => Editor._closeInspector?.()
      }, '✕')
    );
    this.root.appendChild(handle);

    const tabs = el('div', { class: 'inspector-tabs' },
      el('button', {
        class: this.activeTab === 'node' ? 'active' : '',
        onclick: () => this.setTab('node')
      }, 'Nœud'),
      el('button', {
        class: this.activeTab === 'scenario' ? 'active' : '',
        onclick: () => this.setTab('scenario')
      }, 'Scénario'),
      el('button', {
        class: this.activeTab === 'assets' ? 'active' : '',
        onclick: () => this.setTab('assets')
      }, 'Médias')
    );

    const body = el('div', { class: 'inspector-body' });

    if (this.activeTab === 'node')         body.appendChild(this.renderNodeTab());
    else if (this.activeTab === 'scenario') body.appendChild(this.renderScenarioTab());
    else                                    body.appendChild(this.renderAssetsTab());

    this.root.appendChild(tabs);
    this.root.appendChild(body);
  },

  renderNodeTab() {
    const node = this.selectedNodeId ? Scenario.getNode(this.selectedNodeId) : null;
    if (!node) {
      return el('div', { class: 'inspector-empty' },
        'Sélectionne un nœud sur la carte ou dans le graphe pour en éditer les détails.'
      );
    }

    const frag = el('div');

    const headerTitle = el('h2', { style: { marginTop: '4px', fontSize: '22px' } }, node.title);
    this._headerTitleEl = headerTitle;
    frag.appendChild(el('div', { class: 'node-header' },
      el('span', { class: `type-badge type-${node.type}` }, typeLabel(node.type)),
      el('span', { class: 'id' }, node.id),
      headerTitle
    ));

    // Une frappe ne re-rend rien : on met à jour l'en-tête et le marqueur
    // en place. Seuls les champs marqués `rerender` reconstruisent le
    // panneau, parce qu'ils changent la liste des champs affichés.
    const onChange = (key, value, field) => {
      Editor.refreshNode(node.id, { route: key.startsWith('position.') });
      // La clé du champ sert de groupe d'historique : taper un titre
      // produit une entrée, pas une par lettre.
      Scenario.touch(`${node.id}:${key}`);
      Scenario.emit('nodeUpdated', node);
      if (key === 'title' && this._headerTitleEl) {
        this._headerTitleEl.textContent = value || '';
      }
      if (field?.rerender) this.render();
    };

    const commonSchema = [
      { type: 'heading', label: 'Contenu' },
      { key: 'title', label: 'Titre', type: 'text', placeholder: 'Nom du nœud' },
      { key: 'description', label: 'Description', type: 'textarea', rows: 4, placeholder: 'Ce que voit ou entend le joueur.' }
    ];

    frag.appendChild(FormBuilder.render(commonSchema, node, onChange));

    // Position sur carte (sauf intro/outro)
    if (node.type !== 'intro' && node.type !== 'outro') {
      const posSection = el('div', { class: 'inspector-section' });
      posSection.appendChild(el('h3', {}, 'Position'));

      if (!node.position) {
        posSection.appendChild(el('p', { style: { fontSize: '12px', color: 'var(--ink-soft)', marginBottom: '10px' } },
          'Ce nœud n\'a pas encore de position. Fais-le glisser sur la carte, ou renseigne les coordonnées.'
        ));
      }

      const posSchema = [
        {
          type: 'group-inline',
          fields: [
            { key: 'position.lat', label: 'Latitude', type: 'number', step: 0.000001 },
            { key: 'position.lng', label: 'Longitude', type: 'number', step: 0.000001 }
          ]
        }
      ];
      // On ne pré-crée pas `node.position` : FormBuilder le construit à
      // la première saisie. Un objet {lat:null,lng:null} serait truthy et
      // ferait compter le nœud comme positionné (cf. hasPosition).
      posSection.appendChild(FormBuilder.render(posSchema, node, (key) => {
        Editor.refreshNode(node.id);
        Scenario.touch(`${node.id}:${key}`);
      }));

      const centerBtn = el('button', { class: 'btn ghost small', onclick: () => Editor.centerOn(node.id) }, 'Centrer la carte');
      posSection.appendChild(centerBtn);
      frag.appendChild(posSection);
    }

    // Validation : ni pour intro/outro, ni pour une énigme — celle-ci se
    // juge sur sa réponse, et le moteur ignore son bloc `validation`.
    if (node.type !== 'intro' && node.type !== 'outro' && node.type !== 'enigme') {
      const valSection = el('div', { class: 'inspector-section' });
      valSection.appendChild(el('h3', {}, 'Validation'));

      if (!node.validation) node.validation = { type: 'qr', value: '', radius: 20 };

      const valSchema = [
        {
          key: 'validation.type', label: 'Méthode', type: 'select', rerender: true,
          options: [['qr', 'QR code'], ['code', 'Code saisi'], ['gps', 'Proximité GPS'], ['none', 'Aucune']]
        }
      ];
      valSection.appendChild(FormBuilder.render(valSchema, node, onChange));

      const valType = node.validation.type;
      if (valType === 'qr' || valType === 'code') {
        const champ = FormBuilder.render([
          { key: 'validation.value', label: valType === 'qr' ? 'Contenu du QR attendu' : 'Code attendu', type: 'text' }
        ], node, onChange);
        valSection.appendChild(champ);
        const input = $('input', champ);
        valSection.appendChild(el('div', { class: 'btn-row', style: { marginTop: '-6px', marginBottom: '12px' } },
          el('button', {
            class: 'btn ghost small',
            title: 'Un code tiré au sort ne se devine pas',
            onclick: () => {
              const code = QR.code();
              node.validation.value = code;
              if (input) input.value = code;
              Scenario.touch();
              this.render();
            }
          }, '⚄ Code aléatoire')
        ));
        // Aperçu : ce qui sera imprimé, visible tout de suite.
        const valeur = String(node.validation.value || '').trim();
        if (valType === 'qr' && valeur) {
          const apercu = el('div', { class: 'qr-preview' });
          apercu.appendChild(QR.svg(valeur, { taille: 104 }));
          apercu.appendChild(el('div', { class: 'hint' }, 'Aperçu du QR à poser sur le terrain'));
          valSection.appendChild(apercu);
        }
      }
      if (valType === 'gps') {
        valSection.appendChild(FormBuilder.render([
          { key: 'validation.radius', label: 'Rayon (m)', type: 'number', min: 5, max: 200 }
        ], node, onChange));
      }

      // Une réponse peut être fausse dès qu'il y a quelque chose à comparer.
      if (valType === 'qr' || valType === 'code') {
        valSection.appendChild(FormBuilder.render([
          {
            key: 'onWrong', label: 'Si la réponse est fausse', type: 'select',
            options: [
              [ON_WRONG.RETRY, 'Rester sur place et réessayer'],
              [ON_WRONG.CONTINUE, 'Avancer quand même']
            ],
            hint: 'Avec « avancer », le joueur suit le lien « si incorrect » s\'il existe, sinon le lien normal.'
          }
        ], node, onChange));
      }

      frag.appendChild(valSection);
    }

    // L'énigme d'abord : question et réponse sont le contenu du nœud,
    // pas un réglage annexe.
    if (node.type === 'enigme') {
      const enSection = el('div', { class: 'inspector-section' });
      enSection.appendChild(el('h3', {}, 'Énigme'));
      enSection.appendChild(FormBuilder.render([
        { key: 'question', label: 'Question', type: 'textarea', rows: 2, placeholder: 'Ce qu\'on demande à l\'équipe.' },
        { key: 'answer', label: 'Réponse attendue', type: 'text', hint: 'Comparaison insensible à la casse et aux accents.' },
        {
          key: 'onWrong', label: 'Si la réponse est fausse', type: 'select',
          options: [
            [ON_WRONG.RETRY, 'Rester sur place et réessayer'],
            [ON_WRONG.CONTINUE, 'Avancer quand même']
          ],
          hint: 'Avec « avancer », le joueur suit le lien « si incorrect » s\'il existe, sinon le lien normal.'
        }
      ], node, onChange));
      frag.appendChild(enSection);
    }

    // Flags posés à la complétion — c'est ce qui manquait pour que les
    // conditions « si flag » et les checkpoints veuillent dire quelque chose.
    if (node.type !== 'outro') {
      frag.appendChild(this._renderFlagEditor(
        node, 'setsFlags', 'Flags posés',
        'Acquis par l\'équipe quand elle valide ce nœud. Un autre nœud pourra les exiger, ou un lien les tester.'
      ));
    }
    if (node.type === 'checkpoint') {
      frag.appendChild(this._renderFlagEditor(
        node, 'requiresFlags', 'Flags exigés',
        'L\'équipe ne franchit ce checkpoint qu\'en les ayant tous. Sans flag exigé, il se comporte comme une étape.'
      ));
    }

    // Médias
    const imageAssets = Scenario.current.assets.filter(a => a.type?.startsWith('image/'));
    const audioAssets = Scenario.current.assets.filter(a => a.type?.startsWith('audio/'));

    if (imageAssets.length || audioAssets.length || node.media?.image || node.media?.audio) {
      const mediaSection = el('div', { class: 'inspector-section' });
      mediaSection.appendChild(el('h3', {}, 'Médias'));

      if (!node.media) node.media = {};

      // Image
      const imgField = el('div', { class: 'field' });
      imgField.appendChild(el('label', { for: 'champ-media-image' }, 'Image'));
      const imgSel = el('select', {
        onchange: e => {
          if (e.target.value) node.media.image = e.target.value;
          else delete node.media.image;
          Scenario.touch();
          this.render();
        }
      });
      imgSel.appendChild(el('option', { value: '' }, '— Aucune —'));
      imageAssets.forEach(a => {
        const opt = el('option', { value: a.id }, a.name);
        if (node.media.image === a.id) opt.selected = true;
        imgSel.appendChild(opt);
      });
      imgSel.id = 'champ-media-image';
      imgField.appendChild(imgSel);
      if (imageAssets.length === 0) {
        imgField.appendChild(el('div', { class: 'field-hint' }, 'Ajoute d\'abord des images via l\'onglet Médias.'));
      }
      mediaSection.appendChild(imgField);

      if (node.media.image) {
        const a = imageAssets.find(x => x.id === node.media.image);
        if (a) mediaSection.appendChild(AssetStore.bind(el('img', {
          alt: a.name,
          style: { width: '100%', maxHeight: '160px', objectFit: 'cover', borderRadius: '3px', border: '1px solid var(--line)', marginBottom: '12px' }
        }), a.id));
      }

      // Audio
      const audField = el('div', { class: 'field' });
      audField.appendChild(el('label', { for: 'champ-media-audio' }, 'Audio'));
      const audSel = el('select', {
        onchange: e => {
          if (e.target.value) node.media.audio = e.target.value;
          else delete node.media.audio;
          Scenario.touch();
          this.render();
        }
      });
      audSel.appendChild(el('option', { value: '' }, '— Aucun —'));
      audioAssets.forEach(a => {
        const opt = el('option', { value: a.id }, a.name);
        if (node.media.audio === a.id) opt.selected = true;
        audSel.appendChild(opt);
      });
      audSel.id = 'champ-media-audio';
      audField.appendChild(audSel);
      if (audioAssets.length === 0) {
        audField.appendChild(el('div', { class: 'field-hint' }, 'Ajoute d\'abord des sons via l\'onglet Médias.'));
      }
      mediaSection.appendChild(audField);

      if (node.media.audio) {
        const a = audioAssets.find(x => x.id === node.media.audio);
        if (a) mediaSection.appendChild(AssetStore.bind(el('audio', {
          controls: true,
          style: { width: '100%', marginBottom: '8px' }
        }), a.id));
      }

      frag.appendChild(mediaSection);
    }

    // Liens sortants
    const linksFrom = Scenario.getLinksFrom(node.id);
    const linksTo   = Scenario.getLinksTo(node.id);

    const linkSection = el('div', { class: 'inspector-section' });
    linkSection.appendChild(el('h3', {}, 'Liens',
      el('span', { class: 'section-count' },
        `${compte(linksFrom.length, 'sortant')} · ${compte(linksTo.length, 'entrant')}`)
    ));

    if (linksFrom.length === 0) {
      linkSection.appendChild(el('p', { style: { fontSize: '12px', color: 'var(--ink-faint)', fontStyle: 'italic' } },
        'Aucun lien sortant. Trace un trait dans le graphe depuis le cercle à droite du nœud.'
      ));
    }
    linksFrom.forEach(l => {
      const target = Scenario.getNode(l.target);
      const row = el('div', { class: 'link-row' },
        el('span', {},
          el('span', { class: 'arrow' }, '→ '),
          target ? target.title : '(nœud supprimé)'
        ),
        el('span', {},
          l.condition
            ? el('code', {}, this._conditionLabel(l.condition))
            : el('span', { class: 'chip' }, 'toujours'),
          el('button', {
            class: 'btn ghost small',
            style: { marginLeft: '6px' },
            onclick: () => Editor.editLinkCondition(l.id)
          }, 'Cond.'),
          el('button', {
            class: 'btn ghost small danger',
            style: { marginLeft: '4px' },
            onclick: async () => {
              const cible = Scenario.getNode(l.target);
              if (await Modal.confirm(`Supprimer le lien vers « ${cible?.title || '?'} » ?`,
                                      { titre: 'Supprimer le lien', valider: 'Supprimer', danger: true })) {
                Editor.removeLink(l.id);
              }
            }
          }, '✕')
        )
      );
      linkSection.appendChild(row);
    });
    frag.appendChild(linkSection);

    // Actions
    const actions = el('div', { class: 'inspector-section' });
    actions.appendChild(el('h3', {}, 'Actions'));
    actions.appendChild(el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn ghost',
        onclick: () => Scenario.updateMeta({ startNodeId: node.id })
      }, Scenario.current.meta.startNodeId === node.id ? '✓ Départ' : 'Définir comme départ'),
      el('button', {
        class: 'btn ghost danger',
        onclick: async () => {
          const liens = Scenario.getLinksFrom(node.id).length + Scenario.getLinksTo(node.id).length;
          if (await Modal.confirm(`Supprimer « ${node.title} » ?`, {
            titre: 'Supprimer le nœud', valider: 'Supprimer', danger: true,
            detail: liens ? `${compte(liens, 'lien')} ${liens > 1 ? 'seront supprimés' : 'sera supprimé'} avec lui.` : null
          })) {
            Editor.removeNode(node.id);
          }
        }
      }, 'Supprimer')
    ));
    frag.appendChild(actions);

    return frag;
  },

  /** Petit éditeur de liste de flags, partagé par « posés » et « exigés ». */
  _renderFlagEditor(node, cle, titre, aide) {
    const section = el('div', { class: 'inspector-section' });
    section.appendChild(el('h3', {}, titre));
    section.appendChild(el('p', { class: 'field-hint', style: { marginBottom: '10px' } }, aide));

    const liste = Array.isArray(node[cle]) ? node[cle] : [];
    const majAffichage = () => { Scenario.touch(); this.render(); };

    if (liste.length) {
      const chips = el('div', { class: 'flag-list' });
      liste.forEach(flag => {
        chips.appendChild(el('span', { class: 'flag-chip' }, flag,
          el('button', {
            'aria-label': `Retirer ${flag}`,
            onclick: () => { node[cle] = liste.filter(f => f !== flag); majAffichage(); }
          }, '✕')
        ));
      });
      section.appendChild(chips);
    }

    // Les flags déjà employés ailleurs sont proposés : c'est là que se
    // jouent la plupart des fautes de frappe.
    const connus = allFlags(Scenario.current).filter(f => !liste.includes(f));
    const input = el('input', {
      type: 'text', placeholder: 'nom du flag', list: `flags-${cle}`,
      id: `champ-ajout-${cle}`, 'aria-label': `Ajouter un flag — ${titre.toLowerCase()}`
    });
    const datalist = el('datalist', { id: `flags-${cle}` });
    connus.forEach(f => datalist.appendChild(el('option', { value: f })));

    const ajouter = () => {
      const nom = input.value.trim();
      if (!nom) return;
      if (liste.includes(nom)) { Toast.info('Ce flag est déjà dans la liste'); return; }
      node[cle] = [...liste, nom];
      majAffichage();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ajouter(); } });

    section.appendChild(el('div', { class: 'flag-add' },
      input, datalist,
      el('button', { class: 'btn ghost small', onclick: ajouter }, 'Ajouter')
    ));
    return section;
  },

  renderScenarioTab() {
    const scn = Scenario.current;
    const frag = el('div');

    const headerTitle = el('h2', { style: { marginTop: '4px', fontSize: '22px' } }, scn.meta.title || '—');
    frag.appendChild(el('div', { class: 'node-header' },
      el('span', { class: 'type-badge' }, 'Scénario'),
      el('span', { class: 'id' }, scn.id),
      headerTitle
    ));

    const onChange = (key, value) => {
      Scenario.touch(`meta:${key}`);
      Scenario.emit('metaUpdated');
      if (key === 'meta.title') headerTitle.textContent = value || '—';
    };

    frag.appendChild(FormBuilder.render([
      { type: 'heading', label: 'Informations' },
      { key: 'meta.title', label: 'Titre', type: 'text' },
      { key: 'meta.description', label: 'Pitch', type: 'textarea', rows: 3, placeholder: 'En quelques phrases, de quoi parle le parcours ?' },
      { key: 'meta.author', label: 'Auteur / organisation', type: 'text' },
      {
        type: 'group-inline',
        fields: [
          { key: 'meta.duration', label: 'Durée (min)', type: 'number', min: 5, max: 600 },
          {
            key: 'meta.difficulty', label: 'Difficulté', type: 'select',
            options: [['facile', 'Facile'], ['moyen', 'Moyen'], ['difficile', 'Difficile'], ['expert', 'Expert']]
          }
        ]
      }
    ], scn, onChange));

    // Options de jeu
    const gameOpts = el('div', { class: 'inspector-section' });
    gameOpts.appendChild(el('h3', {}, 'Options de jeu'));
    const mapToggleWrap = el('div', { class: 'field' });
    mapToggleWrap.appendChild(el('label', { for: 'champ-carte-joueurs' }, 'Carte visible par les joueurs'));
    const mapToggleSel = el('select', {
      onchange: e => {
        scn.meta.showMapToPlayers = e.target.value === 'yes';
        Scenario.touch();
      }
    },
      el('option', { value: 'no' }, 'Non — carte masquée'),
      el('option', { value: 'yes' }, 'Oui — afficher la destination sur une mini-carte')
    );
    mapToggleSel.id = 'champ-carte-joueurs';
    mapToggleSel.value = scn.meta.showMapToPlayers ? 'yes' : 'no';
    mapToggleWrap.appendChild(mapToggleSel);
    mapToggleWrap.appendChild(el('div', { class: 'field-hint' },
      'Si activé, chaque étape positionnée affiche une mini-carte Leaflet pour aider les joueurs à naviguer.'
    ));
    gameOpts.appendChild(mapToggleWrap);
    frag.appendChild(gameOpts);

    // Départ
    const startSection = el('div', { class: 'inspector-section' });
    startSection.appendChild(el('h3', {}, 'Départ'));
    const select = el('select', {
      onchange: e => Scenario.updateMeta({ startNodeId: e.target.value || null })
    });
    select.appendChild(el('option', { value: '' }, '— Aucun —'));
    scn.nodes.forEach(n => {
      const opt = el('option', { value: n.id }, `${typeLabel(n.type)} · ${n.title}`);
      if (scn.meta.startNodeId === n.id) opt.selected = true;
      select.appendChild(opt);
    });
    const fw = el('div', { class: 'field' });
    select.id = 'champ-depart';
    fw.appendChild(el('label', { for: 'champ-depart' }, 'Nœud de départ'));
    fw.appendChild(select);
    startSection.appendChild(fw);
    frag.appendChild(startSection);

    // Vérification, puis actions : « mon parcours tient-il debout ? »
    // avant « qu'est-ce que j'en fais ? ». Les statistiques, qui ne servent
    // qu'à consulter, descendent en fin de panneau.
    frag.appendChild(this._renderChecklist(scn));

    const io = el('div', { class: 'inspector-section' });
    io.appendChild(el('h3', {}, 'Le parcours'));

    // Une action principale : l'essayer.
    io.appendChild(el('button', {
      class: 'btn accent block', onclick: () => App.testPlay()
    }, '▶ Tester le parcours'));

    // Puis ce qu'on en sort, groupé par intention plutôt qu'en vrac.
    io.appendChild(el('div', { class: 'action-group' },
      el('div', { class: 'action-label' }, 'Emporter sur le terrain'),
      el('div', { class: 'action-pair' },
        el('button', { class: 'btn ghost', onclick: () => QR.printSheet(scn) }, 'Planche de QR'),
        el('button', { class: 'btn ghost', onclick: () => IO.exportZip() }, 'Exporter .zip')
      )
    ));
    io.appendChild(el('div', { class: 'action-group' },
      el('div', { class: 'action-label' }, 'Échanger un scénario'),
      el('div', { class: 'action-pair' },
        el('button', { class: 'btn ghost', onclick: () => IO.importZipDialog() }, 'Importer .zip'),
        el('button', { class: 'btn ghost', onclick: () => IO.exportJson() }, 'Exporter .json')
      )
    ));
    io.appendChild(el('div', { class: 'action-group danger-zone' },
      el('button', {
        class: 'btn ghost danger small', onclick: async () => {
          if (await Modal.confirm('Repartir d\'un scénario vierge ?', {
            titre: 'Nouveau scénario', valider: 'Repartir de zéro', danger: true,
            detail: 'Le scénario courant reste dans la bibliothèque, mais tu quittes ce que tu es en train de faire.'
          })) {
            Scenario.load(Scenario.blank());
            Editor.rebuild();
            Toast.ok('Nouveau scénario vierge');
          }
        }
      }, 'Repartir d\'un scénario vierge')
    ));
    frag.appendChild(io);

    // Cache de tuiles OSM
    const cacheSection = el('div', { class: 'inspector-section' });
    cacheSection.appendChild(el('h3', {}, 'Carte hors ligne'));

    // Sélecteur de fond de carte
    const providerId = scn.meta.tileProvider || DEFAULT_PROVIDER;
    const providerField = el('div', { class: 'field' });
    providerField.appendChild(el('label', { for: 'champ-fond-carte' }, 'Fond de carte'));
    const providerSelect = el('select', {
      onchange: e => Editor.setTileProvider(e.target.value)
    });
    Object.entries(TILE_PROVIDERS).forEach(([id, p]) => {
      const opt = el('option', { value: id }, p.name);
      if (id === providerId) opt.selected = true;
      providerSelect.appendChild(opt);
    });
    providerSelect.id = 'champ-fond-carte';
    providerField.appendChild(providerSelect);
    providerField.appendChild(el('div', { class: 'field-hint' },
      'Le fond choisi est celui que verront les joueurs, et celui qui sera téléchargé pour le hors ligne.'
    ));
    cacheSection.appendChild(providerField);

    cacheSection.appendChild(el('p', { style: { fontSize: '12px', color: 'var(--ink-soft)', marginBottom: '10px' } },
      'Télécharge les tuiles de la zone actuellement visible pour pouvoir jouer sans réseau.'
    ));
    const cacheStats = el('div', { class: 'storage-stats' }, 'Calcul des stats…');
    cacheSection.appendChild(cacheStats);
    Promise.all([
      TileCache.countFor(providerId),
      TileCache.countAll(),
      Offline.estimate(),
      navigator.storage?.persisted?.() ?? null
    ]).then(([nProv, nAll, est, persisted]) => {
      const zoom = Editor.map?.getZoom?.() || '?';
      cacheStats.innerHTML = '';
      cacheStats.appendChild(el('div', {},
        `${compte(nProv, 'tuile')} ${TILE_PROVIDERS[providerId].name} · ${nAll} au total · zoom carte : ${zoom}`));
      if (est && est.quota) {
        // Un nombre de tuiles ne dit rien de la place restante : c'est le
        // quota qui décide si le pré-cache tiendra jusqu'au bout.
        const pct = Math.min(100, Math.round((est.usage / est.quota) * 100));
        cacheStats.appendChild(el('div', { style: { marginTop: '4px' } },
          `${formatBytes(est.usage)} utilisés sur ${formatBytes(est.quota)} (${pct} %)`));
        cacheStats.appendChild(el('div', { class: 'quota-bar' },
          el('span', { style: { width: pct + '%' } })));
      }
      if (persisted === true) {
        cacheStats.appendChild(el('div', { class: 'storage-state ok' },
          'Stockage persistant : rien ne sera effacé sans ton accord.'));
      } else {
        // Ce n'est pas une statistique de plus : c'est le risque de perdre
        // ses scénarios la veille d'une sortie.
        cacheStats.appendChild(el('div', { class: 'storage-state warn' },
          'Stockage non garanti : si l\'appareil manque de place, le navigateur peut effacer scénarios et tuiles. Exporte un .zip avant de partir.'));
      }
    });
    cacheSection.appendChild(el('div', { class: 'btn-row' },
      el('button', { class: 'btn', onclick: () => Editor.precacheZone() }, 'Pré-cacher cette zone'),
      el('button', {
        class: 'btn ghost danger',
        onclick: async () => {
          if (await Modal.confirm('Vider entièrement le cache de tuiles ?', {
            titre: 'Vider le cache', valider: 'Vider', danger: true,
            detail: 'Il faudra retélécharger la zone avant de jouer hors ligne.'
          })) {
            await TileCache.clear();
            Toast.ok('Cache vidé');
            this.render();
          }
        }
      }, 'Vider le cache')
    ));
    frag.appendChild(cacheSection);

    // Statistiques : de la consultation, donc en fin de panneau.
    const stats = el('div', { class: 'inspector-section' });
    stats.appendChild(el('h3', {}, 'Statistiques'));
    const longueur = mainRouteDistance(scn);
    stats.appendChild(el('div', { class: 'stat-grid' },
      el('span', { class: 'chip' }, compte(scn.nodes.length, 'nœud')),
      el('span', { class: 'chip' }, compte(scn.links.length, 'lien')),
      el('span', { class: 'chip' }, compte(scn.assets.length, 'média')),
      // Un « 0 m » ne renseigne sur rien tant qu'aucun nœud n'est placé.
      longueur > 0
        ? el('span', { class: 'chip' }, longueur >= 1000 ? `${(longueur / 1000).toFixed(2)} km` : `${Math.round(longueur)} m`)
        : el('span', { class: 'chip muted' }, 'sans tracé')
    ));
    frag.appendChild(stats);

    return frag;
  },

  /**
   * Liste les anomalies du parcours. Sans elle, l'auteur ne les découvrait
   * que sur le terrain, avec son équipe.
   */
  _renderChecklist(scn) {
    const section = el('div', { class: 'inspector-section' });
    const anomalies = validateScenario(scn);
    const erreurs = anomalies.filter(a => a.severity === SEVERITES.ERREUR);
    const avertissements = anomalies.filter(a => a.severity === SEVERITES.AVERTISSEMENT);

    section.appendChild(el('h3', {}, 'Vérification'));

    if (!anomalies.length) {
      section.appendChild(el('div', { class: 'check-ok' },
        el('span', { class: 'icon' }, '✓'),
        'Le parcours est jouable de bout en bout.'
      ));
      return section;
    }

    section.appendChild(el('div', { class: 'check-summary' },
      erreurs.length
        ? el('span', { class: 'chip danger' }, compte(erreurs.length, 'erreur'))
        : el('span', { class: 'chip' }, 'aucune erreur'),
      avertissements.length
        ? el('span', { class: 'chip warn' }, compte(avertissements.length, 'avertissement'))
        : null
    ));

    const liste = el('div', { class: 'check-list' });
    for (const a of [...erreurs, ...avertissements]) {
      const ligne = el('div', { class: `check-item ${a.severity}` },
        el('span', { class: 'marker' }, a.severity === SEVERITES.ERREUR ? '!' : '·'),
        el('span', { class: 'texte' }, a.message)
      );
      if (a.nodeId && Scenario.getNode(a.nodeId)) {
        // Cliquable : on va droit au nœud fautif.
        ligne.classList.add('clickable');
        ligne.setAttribute('role', 'button');
        ligne.setAttribute('tabindex', '0');
        const aller = () => { Editor.selectNode(a.nodeId); Editor.centerOn(a.nodeId); };
        ligne.addEventListener('click', aller);
        ligne.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aller(); } });
      }
      liste.appendChild(ligne);
    }
    section.appendChild(liste);
    return section;
  },

  renderAssetsTab() {
    const frag = el('div');
    const scn = Scenario.current;

    frag.appendChild(el('div', { class: 'inspector-section' },
      el('h3', {}, 'Bibliothèque'),
      el('p', { style: { fontSize: '12px', color: 'var(--ink-soft)' } },
        'Images et sons vivent à côté du scénario, et partent avec lui dans le ZIP.')
    ));

    // Zone de dépôt
    const drop = el('div', { class: 'upload-drop' },
      el('strong', {}, 'Déposer ou cliquer'),
      'Images (JPG/PNG), audio (MP3)'
    );
    drop.addEventListener('click', () => this._pickAssets());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragging');
      this._addFiles(e.dataTransfer.files);
    });
    frag.appendChild(drop);

    // Liste
    if (scn.assets.length === 0) {
      frag.appendChild(el('p', { style: { fontSize: '12px', color: 'var(--ink-faint)', fontStyle: 'italic', textAlign: 'center', padding: '12px 0' } },
        'Aucun média pour le moment.'
      ));
    } else {
      const list = el('div', { class: 'asset-list' });
      scn.assets.forEach(a => {
        const isImage = a.type && a.type.startsWith('image/');
        const thumb = isImage
          ? AssetStore.bind(el('img', { class: 'thumb', alt: a.name }), a.id)
          : el('div', { class: 'thumb' }, a.type && a.type.startsWith('audio/') ? '♪' : '?');
        list.appendChild(el('div', { class: 'asset-item' },
          thumb,
          el('div', { class: 'info' },
            el('div', { class: 'name' }, a.name),
            el('div', { class: 'size' }, formatBytes(a.size || 0))
          ),
          el('button', {
            class: 'del',
            onclick: async () => {
              if (await Modal.confirm(`Supprimer « ${a.name} » ?`,
                                      { titre: 'Supprimer le média', valider: 'Supprimer', danger: true })) {
                AssetStore.remove(a.id).catch(console.error);
                Scenario.removeAsset(a.id);
                Inspector.render();
              }
            }
          }, '✕')
        ));
      });
      frag.appendChild(list);
    }

    return frag;
  },

  _pickAssets() {
    const input = el('input', {
      type: 'file',
      accept: 'image/*,audio/*',
      multiple: true,
      onchange: e => this._addFiles(e.target.files)
    });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  },

  async _addFiles(fileList) {
    for (const f of fileList) {
      if (!f.type.startsWith('image/') && !f.type.startsWith('audio/')) {
        Toast.warn(`"${f.name}" ignoré (type non supporté)`);
        continue;
      }
      try {
        // Le fichier est déjà un Blob : IndexedDB le stocke tel quel.
        // Le passer en base64 le gonflait d'un tiers et le collait au
        // document du scénario, réécrit à chaque sauvegarde.
        const asset = { id: uid('asset'), name: f.name, type: f.type, size: f.size };
        await AssetStore.put(Scenario.current.id, asset, f);
        Scenario.addAsset(asset);
      } catch (e) {
        console.error(e);
        Toast.error(`Échec de lecture de ${f.name}`);
      }
    }
    this.render();
  },

  _conditionLabel(c) {
    if (!c) return '∅';
    if (c.type === 'correct') return 'si correct';
    if (c.type === 'incorrect') return 'si incorrect';
    if (c.type === 'flag') return `si flag "${c.value}"`;
    return c.type;
  }
};

// ============================================================
// Editor — carte + graphe synchronisés
// ============================================================
const Editor = {
  container: null,
  mapEl: null,
  graphEl: null,
  paletteEl: null,
  inspectorEl: null,
  map: null,
  tileLayer: null,
  drawflow: null,
  markers: Object.create(null), // nodeId -> L.Marker
  drawflowIdByNodeId: Object.create(null), // nodeId -> drawflow id
  nodeIdByDrawflowId: Object.create(null), // drawflow id -> nodeId
  selectedNodeId: null,
  resizer: null,
  _suppressConnectionEvent: false,

  mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="palette" id="palette">
        <div class="palette-title">Palette</div>
        <div id="palette-items"></div>
        <div class="palette-tip">
          <strong style="font-style:normal;font-weight:600;color:var(--ink)">Créer</strong> · glisse un type vers le graphe ou la carte.<br><br>
          <strong style="font-style:normal;font-weight:600;color:var(--ink)">Relier</strong> · clique-maintiens sur le cercle noir (sortie) d'un nœud, glisse jusqu'au cercle blanc (entrée) du suivant.<br><br>
          <strong style="font-style:normal;font-weight:600;color:var(--ink)">Supprimer un lien</strong> · clique dessus, puis <kbd style="font-family:var(--font-mono);background:var(--paper-3);padding:0 4px;border-radius:2px;font-size:10px">Suppr</kbd>.
        </div>
      </div>
      <div class="center" id="center">
        <div class="pane" id="pane-map">
          <div class="pane-header"><span class="dot" aria-hidden="true"></span>Carte
            <span class="count" id="map-count" title="Nœuds positionnés sur la carte">0</span>
            <span class="route-info" id="route-info" title="Longueur du chemin principal"></span>
            <button class="pane-action" id="fit-btn" title="Cadrer sur le parcours" aria-label="Cadrer la carte sur le parcours">⤢</button>
          </div>
          <div id="map"></div>
        </div>
        <div class="resizer" id="resizer"></div>
        <div class="pane" id="pane-graph">
          <div class="pane-header"><span class="dot" style="background:var(--forest)" aria-hidden="true"></span>Graphe
            <span class="count" id="graph-count" title="Nœuds du scénario">0</span>
          </div>
          <div class="history-controls" id="history-controls">
            <button id="undo-btn" title="Annuler (Ctrl+Z)" aria-label="Annuler" disabled>↶</button>
            <button id="redo-btn" title="Rétablir (Ctrl+Maj+Z)" aria-label="Rétablir" disabled>↷</button>
          </div>
          <div id="graph" tabindex="0"></div>
        </div>
      </div>
      <div class="inspector-backdrop" id="inspector-backdrop"></div>
      <div class="inspector" id="inspector"></div>
      <button class="tuto-help-btn" id="tuto-help" aria-label="Ouvrir le tutoriel" title="Tutoriel">?</button>
      <div class="fab-group" id="fab-group">
        <button class="fab secondary" id="fab-inspector" aria-label="Ouvrir l'inspecteur">≡</button>
        <button class="fab" id="fab-add" aria-label="Ajouter un nœud">+</button>
      </div>
    `;

    this.paletteEl = $('#palette-items', container);
    this.mapEl = $('#map', container);
    this.graphEl = $('#graph', container);
    this.inspectorEl = $('#inspector', container);
    this.resizer = $('#resizer', container);
    this.backdropEl = $('#inspector-backdrop', container);

    // FAB mobile
    $('#fab-add', container).addEventListener('click', () => this._openPicker());
    $('#fab-inspector', container).addEventListener('click', () => this._openInspector());
    $('#tuto-help', container).addEventListener('click', () => Tutorial.start(true));
    this.backdropEl.addEventListener('click', () => this._closeInspector());

    // Annuler / rétablir
    $('#fit-btn', container).addEventListener('click', () => this.fitToRoute());

    const undoBtn = $('#undo-btn', container);
    const redoBtn = $('#redo-btn', container);
    undoBtn.addEventListener('click', () => this.annuler());
    redoBtn.addEventListener('click', () => this.retablir());
    const majBoutons = () => {
      undoBtn.disabled = !History.peutAnnuler;
      redoBtn.disabled = !History.peutRetablir;
    };
    this._unsubHistory = History.on(majBoutons);
    majBoutons();

    this._raccourcis = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const cible = e.target;
      // Dans un champ, Ctrl+Z appartient au navigateur.
      if (cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA' || cible.isContentEditable)) return;
      const touche = e.key.toLowerCase();
      if (touche === 'z' && !e.shiftKey) { e.preventDefault(); this.annuler(); }
      else if ((touche === 'z' && e.shiftKey) || touche === 'y') { e.preventDefault(); this.retablir(); }
    };
    document.addEventListener('keydown', this._raccourcis);

    this._buildPalette();
    this._initMap();
    this._initGraph();
    this._initResizer();

    Inspector.mount(this.inspectorEl);
    this.rebuild();

    // Auto-démarre le tuto au premier chargement
    setTimeout(() => Tutorial.start(false), 500);

    // Réagit aux changements de scénario. On garde la fonction de
    // désabonnement : sans elle, chaque montage laissait un abonné
    // derrière lui et `load` rejouait N reconstructions.
    this._unsubscribe = Scenario.on((evt) => {
      if (evt === 'load') { this.rebuild(); return; }
      // Le titre ou le pitch ne déplacent rien : redessiner le tracé à
      // chaque frappe coûtait une reconstruction de toutes les polylignes.
      // Seul le nœud de départ change la numérotation.
      if (evt === 'metaUpdated') {
        const depart = Scenario.current.meta.startNodeId;
        if (depart !== this._departConnu) {
          this._departConnu = depart;
          this._ordre = graphOrder(Scenario.current);
    this._departConnu = Scenario.current.meta.startNodeId;
          this._refreshNumbers();
        }
        return;
      }
      if (['nodeAdded', 'nodeRemoved', 'linkAdded', 'linkRemoved'].includes(evt)) {
        this._ordre = graphOrder(Scenario.current);
        this._refreshNumbers();
        this.drawRoute();
        this._updateCounts();
      }
    });
  },

  /** Contrepartie exacte de mount() : appelée par App.render() en sortie de vue. */
  annuler() {
    if (!History.annuler()) { Toast.info('Rien à annuler'); return; }
    Toast.info('Annulé');
  },

  retablir() {
    if (!History.retablir()) { Toast.info('Rien à rétablir'); return; }
    Toast.info('Rétabli');
  },

  unmount() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubHistory?.();
    this._unsubHistory = null;
    if (this._raccourcis) {
      document.removeEventListener('keydown', this._raccourcis);
      this._raccourcis = null;
    }
    this._exitPlacement();
    this._saveArea();
    if (this.map) {
      // Une animation de zoom en cours (« Centrer la carte », un clic dans
      // la vérification) se terminait après la destruction de la carte :
      // Leaflet cherchait alors la position d'un panneau disparu.
      try { this.map.stop(); } catch (e) { /* rien en cours */ }
      try { this.map.remove(); } catch (e) { /* déjà détruite */ }
      this.map = null;
    }
    this.tileLayer = null;
    this._routeLayer = null;
    this._ordre = null;
    // Drawflow 0.0.60 n'expose pas de destroy(). On coupe la référence :
    // les handlers d'une instance périmée sont neutralisés par le garde
    // d'identité posé dans _initGraph().
    this.drawflow = null;
    this.markers = Object.create(null);
    this.drawflowIdByNodeId = Object.create(null);
    this.nodeIdByDrawflowId = Object.create(null);
    this.selectedNodeId = null;
    this.container = null;
    this.mapEl = this.graphEl = this.paletteEl = this.inspectorEl = null;
    Inspector.unmount();
  },

  _saveArea() {
    if (!this._pendingArea || !Scenario.current) return;
    Scenario.current.meta.area = this._pendingArea;
    this._pendingArea = null;
    Scenario.touch();
  },

  _openInspector() {
    this.inspectorEl.classList.add('open');
    this.backdropEl.classList.add('open');
  },

  _closeInspector() {
    this.inspectorEl.classList.remove('open');
    this.backdropEl.classList.remove('open');
  },

  _buildPalette() {
    const types = [
      { t: 'etape',      icon: 'É', label: 'Étape',      desc: 'Point à atteindre' },
      { t: 'enigme',     icon: '?', label: 'Énigme',     desc: 'Question / réponse' },
      { t: 'checkpoint', icon: '✓', label: 'Checkpoint', desc: 'Condition de passage' },
      { t: 'intro',      icon: '▶', label: 'Intro',      desc: 'Démarrage' },
      { t: 'outro',      icon: '■', label: 'Outro',      desc: 'Fin' }
    ];
    types.forEach(({ t, icon, label, desc }) => {
      const item = el('div', {
        class: 'palette-item',
        'data-type': t,
        draggable: true
      },
        el('div', { class: 'icon' }, icon),
        el('div', {}, el('div', { class: 'label' }, label), el('span', { class: 'desc' }, desc))
      );

      item.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/parcours-type', t);
        e.dataTransfer.effectAllowed = 'copy';
        // fantôme visuel
        const ghost = el('div', { class: 'drag-ghost' }, `+ ${label}`);
        document.body.appendChild(ghost);
        this._ghost = ghost;
        const moveGhost = ev => { ghost.style.left = (ev.clientX + 10) + 'px'; ghost.style.top = (ev.clientY + 10) + 'px'; };
        document.addEventListener('dragover', moveGhost);
        item._moveGhost = moveGhost;
      });
      item.addEventListener('dragend', () => {
        if (this._ghost) { this._ghost.remove(); this._ghost = null; }
        if (item._moveGhost) { document.removeEventListener('dragover', item._moveGhost); delete item._moveGhost; }
      });

      this.paletteEl.appendChild(item);
    });
  },

  _initMap() {
    const scn = Scenario.current;
    const center = scn.meta.area?.center || [48.8566, 2.3522];
    const zoom   = scn.meta.area?.zoom   || 13;
    this.map = L.map(this.mapEl, { zoomControl: true }).setView(center, zoom);
    const providerId = Scenario.current.meta.tileProvider || DEFAULT_PROVIDER;
    this.tileLayer = createCachedTileLayer(providerId).addTo(this.map);

    // Le cadrage de la carte n'est pas du contenu : le persister à chaque
    // `moveend` réécrivait le scénario entier — médias compris — à chaque
    // panoramique. On le retient en mémoire et on l'enregistre en sortie.
    this.map.on('moveend zoomend', () => {
      if (!this.map) return;
      const c = this.map.getCenter();
      this._pendingArea = { center: [c.lat, c.lng], zoom: this.map.getZoom() };
    });

    // Click carte : placer un nœud si mode placement
    this.map.on('click', (e) => {
      if (!this._placementType) return;
      const type = this._placementType;
      const node = Scenario.addNode(type, {
        position: { lat: e.latlng.lat, lng: e.latlng.lng },
        graphPos: { x: 100 + (Scenario.current.nodes.length * 30) % 400, y: 80 + (Scenario.current.nodes.length * 40) % 300 }
      });
      this._addToMap(node);
      this._addToGraph(node);
      this.selectNode(node.id);
      this._exitPlacement();
      Toast.ok(`${typeLabel(type)} placé`);
    });

    // Drop depuis palette
    this.mapEl.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/parcours-type')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.mapEl.classList.add('drop-hover');
    });
    this.mapEl.addEventListener('dragleave', e => {
      if (!this.mapEl.contains(e.relatedTarget)) this.mapEl.classList.remove('drop-hover');
    });
    this.mapEl.addEventListener('drop', e => {
      const type = e.dataTransfer.getData('text/parcours-type');
      if (!type) return;
      e.preventDefault();
      this.mapEl.classList.remove('drop-hover');
      const rect = this.mapEl.getBoundingClientRect();
      const containerPoint = L.point(e.clientX - rect.left, e.clientY - rect.top);
      const latlng = this.map.containerPointToLatLng(containerPoint);
      const node = Scenario.addNode(type, {
        position: (type === 'intro' || type === 'outro') ? null : { lat: latlng.lat, lng: latlng.lng },
        graphPos: { x: 100 + (Scenario.current.nodes.length * 30) % 400, y: 80 + (Scenario.current.nodes.length * 40) % 300 }
      });
      this._addToMap(node);
      this._addToGraph(node);
      this.selectNode(node.id);
      Toast.ok(`Nouveau nœud : ${node.title}`);
    });
  },

  _initGraph() {
    // Drawflow attache son handler clavier à son conteneur, pas au document.
    // Sans focus possible sur #graph, la suppression au clavier — pourtant
    // enseignée par le tutoriel et la palette — n'atteignait jamais le code.
    this.graphEl.addEventListener('pointerdown', () => this.graphEl.focus({ preventScroll: true }));

    this.drawflow = new Drawflow(this.graphEl);
    // Drawflow n'a pas de destroy() : une instance abandonnée peut encore
    // émettre. Ce garde fait ignorer tout événement qui ne vient pas de
    // l'instance courante.
    const df = this.drawflow;
    this.drawflow.reroute = true;
    this.drawflow.reroute_fix_curvature = true;
    this.drawflow.force_first_input = false;
    this.drawflow.start();

    // Events Drawflow
    this.drawflow.on('nodeSelected', dfId => {
      if (this.drawflow !== df) return;
      const nodeId = this.nodeIdByDrawflowId[dfId];
      if (nodeId) this.selectNode(nodeId);
    });
    this.drawflow.on('nodeUnselected', () => {
      // ne fait rien : on garde la sélection de l'inspecteur
    });
    this.drawflow.on('nodeMoved', dfId => {
      if (this.drawflow !== df) return;
      const nodeId = this.nodeIdByDrawflowId[dfId];
      if (!nodeId) return;
      const dfNode = this.drawflow.getNodeFromId(dfId);
      Scenario.updateNode(nodeId, { graphPos: { x: dfNode.pos_x, y: dfNode.pos_y } });
    });
    this.drawflow.on('connectionCreated', info => {
      if (this.drawflow !== df) return;
      if (this._suppressConnectionEvent) return;
      const sourceNodeId = this.nodeIdByDrawflowId[info.output_id];
      const targetNodeId = this.nodeIdByDrawflowId[info.input_id];
      if (sourceNodeId && targetNodeId) {
        Scenario.addLink(sourceNodeId, targetNodeId);
        Inspector.render();
      }
    });
    this.drawflow.on('connectionRemoved', info => {
      if (this.drawflow !== df) return;
      if (this._suppressConnectionEvent) return;
      const sourceNodeId = this.nodeIdByDrawflowId[info.output_id];
      const targetNodeId = this.nodeIdByDrawflowId[info.input_id];
      const link = Scenario.current.links.find(l => l.source === sourceNodeId && l.target === targetNodeId);
      if (link) {
        Scenario.removeLink(link.id);
        Inspector.render();
      }
    });
    this.drawflow.on('nodeRemoved', dfId => {
      if (this.drawflow !== df) return;
      // Déclenché quand l'utilisateur appuie sur Suppr dans le graphe.
      // Le nœud doit disparaître du scénario aussi, sinon il reste sur la
      // carte et réapparaît au prochain rebuild().
      const nodeId = this.nodeIdByDrawflowId[dfId];
      if (!nodeId) return;
      const title = Scenario.getNode(nodeId)?.title || 'Nœud';
      this.removeNode(nodeId, { fromGraph: true });
      Toast.info(`« ${title} » supprimé`);
    });

    // Click graphe : placer un nœud si mode placement (ne pas interférer avec les clics sur nœuds)
    this.graphEl.addEventListener('click', (e) => {
      if (!this._placementType) return;
      if (e.target.closest('.drawflow-node')) return;
      if (e.target.closest('.connection')) return;
      const type = this._placementType;
      const rect = this.graphEl.getBoundingClientRect();
      const scale = this.drawflow.zoom || 1;
      const x = (e.clientX - rect.left - this.drawflow.canvas_x) / scale;
      const y = (e.clientY - rect.top - this.drawflow.canvas_y) / scale;
      const node = Scenario.addNode(type, {
        graphPos: { x, y },
        position: null
      });
      this._addToGraph(node);
      this.selectNode(node.id);
      this._exitPlacement();
      Toast.ok(`${typeLabel(type)} créé dans le graphe`);
    });

    // Drop depuis palette vers graphe
    this.graphEl.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/parcours-type')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.graphEl.classList.add('drop-hover');
    });
    this.graphEl.addEventListener('dragleave', e => {
      if (!this.graphEl.contains(e.relatedTarget)) this.graphEl.classList.remove('drop-hover');
    });
    this.graphEl.addEventListener('drop', e => {
      const type = e.dataTransfer.getData('text/parcours-type');
      if (!type) return;
      e.preventDefault();
      this.graphEl.classList.remove('drop-hover');
      const rect = this.graphEl.getBoundingClientRect();
      // Position en tenant compte du zoom / pan de Drawflow
      const scale = this.drawflow.zoom || 1;
      const x = (e.clientX - rect.left - this.drawflow.canvas_x) / scale;
      const y = (e.clientY - rect.top - this.drawflow.canvas_y) / scale;

      const node = Scenario.addNode(type, {
        graphPos: { x, y },
        position: null // reste à placer sur la carte
      });
      this._addToGraph(node);
      // si c'est un type qui a une position, on ne le met pas encore sur la carte (pas de coordonnées)
      this.selectNode(node.id);
      if (node.type !== 'intro' && node.type !== 'outro') {
        Toast.info('Nœud créé dans le graphe. Place-le maintenant sur la carte.');
      } else {
        Toast.ok(`Nouveau nœud : ${node.title}`);
      }
    });
  },

  _initResizer() {
    const center = $('#center', this.container);
    let resizing = false;

    this.resizer.addEventListener('pointerdown', e => {
      resizing = true;
      this.resizer.setPointerCapture?.(e.pointerId);
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });
    this.resizer.addEventListener('pointermove', e => {
      if (!resizing) return;
      const rect = center.getBoundingClientRect();
      const isH = center.classList.contains('horizontal');
      if (isH) {
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        if (pct > 15 && pct < 85)
          center.style.gridTemplateColumns = `${pct}% 10px ${100 - pct}%`;
      } else {
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        if (pct > 15 && pct < 85)
          center.style.gridTemplateRows = `${pct}% 10px ${100 - pct}%`;
      }
      this.map?.invalidateSize();
    });
    const stopResize = (e) => {
      if (resizing) {
        resizing = false;
        document.body.style.cursor = '';
        this.resizer.releasePointerCapture?.(e.pointerId);
      }
    };
    this.resizer.addEventListener('pointerup', stopResize);
    this.resizer.addEventListener('pointercancel', stopResize);

    // Double-click / double-tap sur resizer -> bascule orientation
    this.resizer.addEventListener('dblclick', () => {
      center.classList.toggle('horizontal');
      center.style.gridTemplateRows = '';
      center.style.gridTemplateColumns = '';
      setTimeout(() => this.map?.invalidateSize(), 50);
    });
  },

  // --- Reconstruction complète à partir du scénario (ex: chargement) ---
  rebuild() {
    // L'éditeur peut recevoir un `load` alors qu'il n'est plus monté
    // (import d'un ZIP depuis l'accueil) : il n'y a alors rien à rebâtir.
    if (!this.map || !this.drawflow) return;

    this._ordre = graphOrder(Scenario.current);

    // Clear markers
    Object.values(this.markers).forEach(m => m.remove());
    this.markers = Object.create(null);

    // Clear drawflow
    this.drawflow.clear();
    this.drawflowIdByNodeId = Object.create(null);
    this.nodeIdByDrawflowId = Object.create(null);

    // Re-centrer carte
    const area = Scenario.current.meta.area;
    // Reconstruction : on repositionne sèchement, sans transition. Une
    // animation lancée ici pouvait s'achever après la destruction de la carte.
    if (area?.center) this.map.setView(area.center, area.zoom || 13, { animate: false });

    // Re-ajouter nœuds
    Scenario.current.nodes.forEach(n => {
      this._addToMap(n);
      this._addToGraph(n);
    });

    // Re-ajouter liens (Drawflow)
    this._suppressConnectionEvent = true;
    this._addConnectionsBatched(Scenario.current.links);
    this._suppressConnectionEvent = false;

    this.drawRoute();
    this._updateCounts();
    Inspector.render();
  },

  /**
   * Recrée toutes les connexions du graphe.
   *
   * `addConnection` insère un SVG puis recalcule aussitôt la géométrie des
   * deux nœuds concernés, en lisant leurs `getBoundingClientRect()`. Comme
   * une insertion DOM vient de se produire, chaque lecture force un
   * recalcul de mise en page : sur un parcours de 150 nœuds, cette seule
   * phase pesait 375 ms des 578 du rebuild.
   *
   * On diffère donc le calcul géométrique, puis on le fait en une passe,
   * sans insertion entre les mesures.
   */
  _addConnectionsBatched(links) {
    const df = this.drawflow;
    const original = df.updateConnectionNodes;
    if (typeof original !== 'function') return this._addConnectionsSimple(links);

    let differe = true;
    df.updateConnectionNodes = function (id) {
      if (!differe) return original.call(this, id);
    };
    try {
      this._addConnectionsSimple(links);
    } finally {
      differe = false;
      df.updateConnectionNodes = original;
    }
    for (const dfId of Object.values(this.drawflowIdByNodeId)) {
      try { df.updateConnectionNodes('node-' + dfId); } catch (e) { /* nœud disparu */ }
    }
  },

  _addConnectionsSimple(links) {
    for (const l of links) {
      const sid = this.drawflowIdByNodeId[l.source];
      const tid = this.drawflowIdByNodeId[l.target];
      if (!sid || !tid) continue;
      try { this.drawflow.addConnection(sid, tid, 'output_1', 'input_1'); }
      catch (e) { /* déjà présente */ }
    }
  },

  /**
   * Trace le parcours sur la carte. Sans lui, l'auteur ne voyait que des
   * marqueurs isolés : ni l'ordre, ni les distances, ni ce que son
   * itinéraire donne réellement sur le terrain.
   */
  drawRoute() {
    if (!this.map) return;
    if (this._routeLayer) { this.map.removeLayer(this._routeLayer); this._routeLayer = null; }

    const segments = routeSegments(Scenario.current);
    if (!segments.length) { this._updateRouteInfo(0); return; }

    const layer = L.layerGroup();
    for (const seg of segments) {
      // Trait plein pour le chemin normal, pointillé pour les branches
      // conditionnelles : elles ne seront pas parcourues à chaque partie.
      L.polyline(seg.coords, {
        color: seg.conditional ? cssVar('--ink-faint', '#615748') : cssVar('--forest', '#4a6b3d'),
        weight: seg.conditional ? 2 : 3,
        opacity: seg.conditional ? 0.55 : 0.75,
        dashArray: seg.conditional ? '4 6' : null,
        interactive: false
      }).addTo(layer);
    }
    layer.addTo(this.map);
    this._routeLayer = layer;
    // La couche du tracé passe sous les marqueurs.
    layer.eachLayer(l => l.bringToBack?.());
    this._updateRouteInfo(mainRouteDistance(Scenario.current));
  },

  _updateRouteInfo(metres) {
    const el2 = $('#route-info', this.container);
    if (!el2) return;
    if (!metres) { el2.textContent = ''; return; }
    el2.textContent = metres >= 1000
      ? `${(metres / 1000).toFixed(2)} km`
      : `${Math.round(metres)} m`;
  },

  _addToMap(node) {
    if (!hasPosition(node)) return;
    if (node.type === 'intro' || node.type === 'outro') return;

    // Le numéro vient de l'ordre de parcours, pas de l'ordre de création :
    // celui du tableau se décalait à la première suppression et n'apprenait
    // rien à l'auteur.
    const idx = this._ordre?.get(node.id) ?? (Scenario.current.nodes.indexOf(node) + 1);
    const icon = L.divIcon({
      className: `node-marker type-${node.type}`,
      html: String(idx),
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    const marker = L.marker([node.position.lat, node.position.lng], {
      icon, draggable: true, title: node.title
    }).addTo(this.map);

    marker.on('click', () => this.selectNode(node.id));
    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      Scenario.updateNode(node.id, { position: { lat: ll.lat, lng: ll.lng } });
      this.drawRoute();
      Inspector.render();
    });

    this.markers[node.id] = marker;
  },

  _addToGraph(node) {
    const html = `
      <div class="node-inner">
        <div class="node-type">${escapeHtml(typeLabel(node.type))}</div>
        <div class="node-title" data-title-for="${node.id}">${escapeHtml(node.title)}</div>
      </div>
    `;
    const hasInput  = node.type !== 'intro';
    const hasOutput = node.type !== 'outro';
    const dfId = this.drawflow.addNode(
      node.type,
      hasInput ? 1 : 0,
      hasOutput ? 1 : 0,
      node.graphPos?.x ?? 100,
      node.graphPos?.y ?? 100,
      `type-${node.type}`,
      { nodeId: node.id },
      html
    );
    this.drawflowIdByNodeId[node.id] = dfId;
    this.nodeIdByDrawflowId[dfId] = node.id;
  },

  // --- API publique ---
  refreshNode(nodeId, opts = {}) {
    const node = Scenario.getNode(nodeId);
    if (!node) return;
    // Map
    if (this.markers[nodeId]) {
      if (!hasPosition(node)) {
        this.markers[nodeId].remove();
        delete this.markers[nodeId];
      } else {
        this.markers[nodeId].setLatLng([node.position.lat, node.position.lng]);
        this.markers[nodeId].options.title = node.title;
      }
    } else if (hasPosition(node)) {
      this._addToMap(node);
    }
    // Graph — update title inline
    const titleEl = this.graphEl.querySelector(`[data-title-for="${nodeId}"]`);
    if (titleEl) titleEl.textContent = node.title;
    // Sélection visuelle marker
    Object.entries(this.markers).forEach(([id, m]) => {
      const icon = m._icon;
      if (icon) icon.classList.toggle('selected', id === this.selectedNodeId);
    });
    if (opts.route !== false) this.drawRoute();
  },

  /** Réécrit le numéro affiché sur chaque marqueur. */
  _refreshNumbers() {
    for (const [id, marker] of Object.entries(this.markers)) {
      const icone = marker._icon;
      if (icone) icone.textContent = String(this._ordre?.get(id) ?? '');
    }
  },

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    Inspector.setSelection(nodeId);

    // Sélection visuelle markers
    Object.entries(this.markers).forEach(([id, m]) => {
      const icon = m._icon;
      if (icon) icon.classList.toggle('selected', id === nodeId);
    });
    // Sélection dans le graphe
    if (nodeId && this.drawflowIdByNodeId[nodeId]) {
      document.querySelectorAll('.drawflow-node').forEach(n => n.classList.remove('selected'));
      const node = document.getElementById('node-' + this.drawflowIdByNodeId[nodeId]);
      if (node) node.classList.add('selected');
    }
    // Sur mobile : ouvre automatiquement l'inspecteur
    if (nodeId && isMobile()) {
      this._openInspector();
    }
  },

  // --------- Mode placement (mobile / tap-to-place) ---------
  _placementType: null,

  _openPicker() {
    const types = [
      { t: 'etape',      icon: 'É', label: 'Étape',      desc: 'Point à atteindre' },
      { t: 'enigme',     icon: '?', label: 'Énigme',     desc: 'Question / réponse' },
      { t: 'checkpoint', icon: '✓', label: 'Checkpoint', desc: 'Condition' },
      { t: 'intro',      icon: '▶', label: 'Intro',      desc: 'Démarrage' },
      { t: 'outro',      icon: '■', label: 'Outro',      desc: 'Fin' }
    ];
    Modal.show((modal, close) => {
      modal.appendChild(el('h3', {}, 'Ajouter un nœud'));
      modal.appendChild(el('p', { class: 'sub' }, 'Choisis le type à créer'));
      const grid = el('div', { class: 'picker-grid' });
      types.forEach(({ t, icon, label, desc }) => {
        const btn = el('button', {
          class: `picker-item type-${t}`,
          onclick: () => { close(); this.enterPlacement(t); }
        },
          el('div', { class: 'picker-icon' }, icon),
          el('div', { class: 'picker-label' }, label),
          el('div', { class: 'picker-desc' }, desc)
        );
        grid.appendChild(btn);
      });
      modal.appendChild(grid);
      modal.appendChild(el('div', { class: 'btn-row', style: { justifyContent: 'center', marginTop: '16px' } },
        el('button', { class: 'btn ghost', onclick: close }, 'Annuler')
      ));
    });
  },

  enterPlacement(type) {
    // Intro / outro n'ont pas besoin de position : création directe dans le graphe
    if (type === 'intro' || type === 'outro') {
      const node = Scenario.addNode(type, {
        graphPos: { x: 80 + (Scenario.current.nodes.length * 25) % 300, y: 80 }
      });
      this._addToGraph(node);
      this.selectNode(node.id);
      Toast.ok(`${typeLabel(type)} créé`);
      return;
    }
    // Sinon : mode placement actif
    this._placementType = type;
    document.body.classList.add('placing');
    this._showPlacementBanner(type);
  },

  _exitPlacement() {
    this._placementType = null;
    document.body.classList.remove('placing');
    this._hidePlacementBanner();
  },

  _showPlacementBanner(type) {
    this._hidePlacementBanner();
    const banner = el('div', { class: 'placement-banner' },
      el('span', {}, `Touche la carte ou le graphe · ${typeLabel(type)}`),
      el('button', {
        class: 'cancel',
        'aria-label': 'Annuler',
        onclick: () => this._exitPlacement()
      }, '✕')
    );
    banner.id = 'placement-banner';
    document.body.appendChild(banner);
  },

  _hidePlacementBanner() {
    document.getElementById('placement-banner')?.remove();
  },



  /**
   * Cadre la carte sur l'ensemble des nœuds positionnés.
   *
   * L'éditeur restaurait le dernier cadrage enregistré, sans jamais offrir
   * de revenir au parcours : après un déplacement, retrouver ses points
   * demandait de zoomer à la main.
   */
  fitToRoute() {
    if (!this.map) return;
    const points = Scenario.current.nodes
      .filter(hasPosition)
      .map(n => [n.position.lat, n.position.lng]);
    if (!points.length) { Toast.info('Aucun nœud n\'est encore placé sur la carte'); return; }
    if (points.length === 1) {
      this.map.setView(points[0], Math.max(this.map.getZoom(), 16), { animate: false });
      return;
    }
    this.map.fitBounds(L.latLngBounds(points), { padding: [48, 48], animate: false, maxZoom: 17 });
  },

  centerOn(nodeId) {
    const node = Scenario.getNode(nodeId);
    if (!hasPosition(node)) { Toast.warn('Ce nœud n\'a pas encore de position'); return; }
    // Sans animation : le mouvement se termine parfois après un changement
    // de vue, et Leaflet cherche alors la position d'une carte détruite.
    this.map.setView([node.position.lat, node.position.lng],
                     Math.max(this.map.getZoom(), 16), { animate: false });
  },

  setTileProvider(providerId) {
    if (!this.map || !TILE_PROVIDERS[providerId]) return;
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = createCachedTileLayer(providerId).addTo(this.map);
    Scenario.updateMeta({ tileProvider: providerId });
    Toast.ok(`Fond : ${TILE_PROVIDERS[providerId].name}`);
  },

  async precacheZone() {
    if (!this.map) return;
    const providerId = Scenario.current.meta.tileProvider || DEFAULT_PROVIDER;
    const provider = TILE_PROVIDERS[providerId];
    const b = this.map.getBounds();
    const bounds = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
    const currentZoom = Math.round(this.map.getZoom());
    const minZ = Math.max(10, currentZoom - 1);
    const maxZ = Math.min(provider.maxZoom || 18, currentZoom + 3);
    const est = TileCache.estimate(bounds, minZ, maxZ);

    // Quatre requêtes en vol : l'estimation suit le débit réel.
    const minutes = Math.max(0.1, Math.round(est * 0.12 / 4 / 60 * 10) / 10);
    const ok = await Modal.confirm(
      `${est} tuiles à télécharger (zooms ${minZ} à ${maxZ}) via « ${provider.name} ».`,
      {
        titre: 'Pré-cacher la zone',
        valider: est > 3000 ? 'Télécharger quand même' : 'Télécharger',
        detail: est > 3000
          ? `Durée estimée : ~${minutes} min. C'est beaucoup — dézoomer un peu ciblerait une zone plus petite.`
          : `Durée estimée : ~${minutes} min.`
      });
    if (!ok) return;

    let cancelled = false;
    Modal.show((modal, close) => {
      modal.appendChild(el('h3', {}, 'Téléchargement des tuiles'));
      modal.appendChild(el('p', { class: 'sub' }, `${provider.name} · zooms ${minZ} à ${maxZ}`));
      const progress = el('div', { class: 'play-progress', style: { marginBottom: '16px' } },
        el('span', { class: 'progress-done' }, '0'),
        el('span', { class: 'bar', style: { '--pct': '0%' } }),
        el('span', { class: 'progress-total' }, String(est))
      );
      modal.appendChild(progress);
      const stats = el('div', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-soft)', marginBottom: '14px' } },
        '0 téléchargé · 0 déjà en cache · 0 erreur');
      modal.appendChild(stats);
      modal.appendChild(el('div', { class: 'btn-row', style: { justifyContent: 'flex-end' } },
        el('button', { class: 'btn ghost', onclick: () => { cancelled = true; close(); } }, 'Annuler')
      ));
      modal._update = ({ done, total, skipped, errors }) => {
        const dl = done - skipped;
        progress.querySelector('.progress-done').textContent = String(done);
        progress.querySelector('.progress-total').textContent = String(total);
        progress.querySelector('.bar').style.setProperty('--pct', ((done / total) * 100) + '%');
        stats.textContent = `${compte(dl, 'téléchargée')} · ${skipped} déjà en cache · ${compte(errors, 'erreur')}`;
      };
      modal._close = close;
    });

    const modalEl = document.querySelector('.modal-backdrop .modal');
    const res = await TileCache.precache(providerId, bounds, minZ, maxZ, {
      isCancelled: () => cancelled,
      onProgress: (p) => modalEl?._update?.(p)
    });
    modalEl?._close?.();

    if (cancelled) Toast.warn(`Annulé après ${res.done}/${res.total} tuiles`);
    else if (res.errors > 0 && res.errors === res.total - res.skipped) Toast.error(`Toutes les requêtes ont échoué. Essaie un autre fond de carte.`);
    else Toast.ok(`${compte(res.done - res.skipped, 'tuile')} en cache${res.errors ? ', ' + compte(res.errors, 'erreur') : ''}`);

    Inspector.render();
  },

  /**
   * @param {{fromGraph?: boolean}} opts  fromGraph : Drawflow a déjà retiré
   *   le nœud de son canvas, il ne faut pas le lui redemander.
   */
  removeNode(nodeId, opts = {}) {
    const dfId = this.drawflowIdByNodeId[nodeId];
    if (dfId) {
      if (!opts.fromGraph) {
        try { this.drawflow.removeNodeId('node-' + dfId); } catch (e) { /* ignore */ }
      }
      delete this.drawflowIdByNodeId[nodeId];
      delete this.nodeIdByDrawflowId[dfId];
    }
    if (this.markers[nodeId]) {
      this.markers[nodeId].remove();
      delete this.markers[nodeId];
    }
    Scenario.removeNode(nodeId);
    if (this.selectedNodeId === nodeId) {
      this.selectedNodeId = null;
      Inspector.setSelection(null);
    }
    this._updateCounts();
  },

  removeLink(linkId) {
    const link = Scenario.current.links.find(l => l.id === linkId);
    if (!link) return;
    const sid = this.drawflowIdByNodeId[link.source];
    const tid = this.drawflowIdByNodeId[link.target];
    if (sid && tid) {
      this._suppressConnectionEvent = true;
      try { this.drawflow.removeSingleConnection(sid, tid, 'output_1', 'input_1'); } catch (e) {}
      this._suppressConnectionEvent = false;
    }
    Scenario.removeLink(linkId);
    Inspector.render();
  },

  editLinkCondition(linkId) {
    const link = Scenario.current.links.find(l => l.id === linkId);
    if (!link) return;
    Modal.conditionEditor(link, (newCond) => {
      Scenario.updateLink(linkId, { condition: newCond });
      Inspector.render();
    });
  },

  _updateCounts() {
    const mapCount = $('#map-count');
    const graphCount = $('#graph-count');
    if (!mapCount || !graphCount) return; // l'éditeur n'est plus monté
    mapCount.textContent = Scenario.current.nodes.filter(hasPosition).length;
    graphCount.textContent = Scenario.current.nodes.length;
  }
};

// ============================================================
// Modal — dialogues
// ============================================================
const Modal = {
  show(contentFn, opts = {}) {
    const renduAvant = document.activeElement;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
    backdrop.appendChild(modal);

    const close = (resultat) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      // On rend le focus à ce qui a ouvert la boîte : sans cela, la
      // navigation au clavier repart du début du document.
      if (renduAvant?.isConnected) renduAvant.focus?.();
      opts.onClose?.(resultat);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      // Piège à focus : tant que la boîte est ouverte, la tabulation
      // tourne à l'intérieur.
      const cibles = $$('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])', modal)
        .filter(n => n.offsetParent !== null || n === document.activeElement);
      if (!cibles.length) { e.preventDefault(); return; }
      const premier = cibles[0], dernier = cibles[cibles.length - 1];
      if (e.shiftKey && document.activeElement === premier) { e.preventDefault(); dernier.focus(); }
      else if (!e.shiftKey && document.activeElement === dernier) { e.preventDefault(); premier.focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
    contentFn(modal, close);

    const premierChamp = $('input, textarea, select, button', modal);
    (premierChamp || modal).focus?.();
    return close;
  },

  /**
   * Remplace `confirm()` : celui-ci bloque le fil d'exécution, casse le
   * design et se fait ignorer dans certains contextes embarqués.
   * @returns {Promise<boolean>}
   */
  confirm(message, { titre = 'Confirmer', valider = 'Confirmer', danger = false, detail = null } = {}) {
    return new Promise(resolve => {
      let reponse = false;
      this.show((modal, close) => {
        modal.appendChild(el('h3', {}, titre));
        modal.appendChild(el('p', { class: 'sub' }, message));
        if (detail) modal.appendChild(el('p', { style: { fontSize: '12.5px', color: 'var(--ink-soft)' } }, detail));
        modal.appendChild(el('div', { class: 'btn-row', style: { marginTop: '18px', justifyContent: 'flex-end' } },
          el('button', { class: 'btn ghost', onclick: () => close() }, 'Annuler'),
          el('button', {
            class: 'btn ' + (danger ? 'ghost danger' : 'accent'),
            onclick: () => { reponse = true; close(); }
          }, valider)
        ));
      }, { onClose: () => resolve(reponse) });
    });
  },

  conditionEditor(link, onSave) {
    this.show((modal, close) => {
      const source = Scenario.getNode(link.source);
      const target = Scenario.getNode(link.target);

      const current = link.condition?.type || 'always';

      const select = el('select', { style: { width: '100%' } },
        el('option', { value: 'always' }, 'Toujours (lien inconditionnel)'),
        el('option', { value: 'correct' }, 'Si la réponse est correcte'),
        el('option', { value: 'incorrect' }, 'Si la réponse est incorrecte'),
        el('option', { value: 'flag' }, 'Si un flag est actif')
      );
      select.value = current;

      const flagWrap = el('div', { class: 'field', style: { marginTop: '10px' } });
      const flagInput = el('input', { type: 'text', placeholder: 'nom du flag' });
      flagInput.value = link.condition?.value || '';
      flagInput.id = 'champ-nom-flag';
      flagWrap.appendChild(el('label', { for: 'champ-nom-flag' }, 'Nom du flag'));
      flagWrap.appendChild(flagInput);

      const refreshFlagVisibility = () => {
        flagWrap.style.display = select.value === 'flag' ? 'block' : 'none';
      };
      select.addEventListener('change', refreshFlagVisibility);

      modal.appendChild(el('h3', {}, 'Condition du lien'));
      modal.appendChild(el('p', { class: 'sub' },
        `${source?.title || '?'} → ${target?.title || '?'}`
      ));
      select.id = 'champ-type-condition';
      modal.appendChild(el('div', { class: 'field' },
        el('label', { for: 'champ-type-condition' }, 'Type de condition'),
        select
      ));
      modal.appendChild(flagWrap);
      refreshFlagVisibility();

      modal.appendChild(el('div', { class: 'btn-row', style: { marginTop: '18px', justifyContent: 'flex-end' } },
        el('button', { class: 'btn ghost', onclick: close }, 'Annuler'),
        el('button', {
          class: 'btn accent',
          onclick: () => {
            const type = select.value;
            let cond = null;
            if (type === 'correct' || type === 'incorrect') cond = { type };
            else if (type === 'flag') cond = { type, value: flagInput.value.trim() };
            onSave(cond);
            close();
            Toast.ok('Condition mise à jour');
          }
        }, 'Enregistrer')
      ));
    });
  }
};

// ============================================================
// QR — génération et planche à imprimer
// ============================================================
const QR = {
  /** Alphabet sans caractères ambigus : ni O/0, ni I/1/l. */
  ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',

  /**
   * Code aléatoire pour un point de contrôle. « eglise » se devine ;
   * un code tiré au sort, non.
   */
  code(longueur = 6) {
    const octets = crypto.getRandomValues(new Uint8Array(longueur));
    return [...octets].map(o => this.ALPHABET[o % this.ALPHABET.length]).join('');
  },

  /** QR en SVG : net à l'impression, quelle que soit la taille. */
  svg(texte, { taille = 150, marge = 4 } = {}) {
    const q = qrcode(0, 'M');   // version auto, correction moyenne
    q.addData(String(texte));
    q.make();
    const n = q.getModuleCount();
    const total = n + marge * 2;

    let chemin = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (q.isDark(y, x)) chemin += `M${x + marge},${y + marge}h1v1h-1z`;
      }
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    svg.setAttribute('width', taille);
    svg.setAttribute('height', taille);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `QR code : ${texte}`);
    svg.innerHTML =
      `<rect width="${total}" height="${total}" fill="#fff"/>` +
      `<path d="${chemin}" fill="#000" shape-rendering="crispEdges"/>`;
    return svg;
  },

  /** Nœuds dont la validation attend un QR. */
  nodesToPrint(scn) {
    const ordre = graphOrder(scn);
    return scn.nodes
      .filter(n => n.validation?.type === 'qr')
      .sort((a, b) => (ordre.get(a.id) || 0) - (ordre.get(b.id) || 0))
      .map(n => ({ node: n, numero: ordre.get(n.id) }));
  },

  /**
   * Planche A4 prête à imprimer. L'auteur devait jusqu'ici sortir de
   * l'application, trouver un générateur en ligne et produire ses codes
   * un par un — en espérant n'avoir pas fait de faute de frappe.
   */
  printSheet(scn) {
    const aImprimer = this.nodesToPrint(scn);
    if (!aImprimer.length) {
      Toast.warn('Aucun nœud ne valide par QR code');
      return;
    }
    const sansValeur = aImprimer.filter(({ node }) => !String(node.validation.value || '').trim());
    if (sansValeur.length) {
      Toast.warn(`${compte(sansValeur.length, 'nœud')} sans contenu de QR : ${sansValeur.length > 1 ? 'ignorés' : 'ignoré'}`);
    }
    const prets = aImprimer.filter(({ node }) => String(node.validation.value || '').trim());
    if (!prets.length) return;

    document.getElementById('qr-sheet')?.remove();
    const sheet = el('div', { id: 'qr-sheet', class: 'qr-sheet' });
    sheet.appendChild(el('div', { class: 'qr-sheet-header' },
      el('h1', {}, scn.meta.title || 'Parcours'),
      el('p', {}, `${compte(prets.length, 'point')} à poser · imprimé le ${formatDate(Date.now())}`)
    ));

    const grille = el('div', { class: 'qr-grid' });
    for (const { node, numero } of prets) {
      const valeur = String(node.validation.value).trim();
      grille.appendChild(el('div', { class: 'qr-card' },
        el('div', { class: 'qr-num' }, `${numero}`),
        this.svg(valeur, { taille: 190 }),
        el('div', { class: 'qr-title' }, node.title),
        el('div', { class: 'qr-value' }, valeur),
        hasPosition(node)
          ? el('div', { class: 'qr-coords' }, `${node.position.lat.toFixed(5)}, ${node.position.lng.toFixed(5)}`)
          : el('div', { class: 'qr-coords' }, 'sans position')
      ));
    }
    sheet.appendChild(grille);
    document.body.appendChild(sheet);
    document.body.classList.add('printing');

    const nettoyer = () => {
      document.body.classList.remove('printing');
      sheet.remove();
      window.removeEventListener('afterprint', nettoyer);
    };
    window.addEventListener('afterprint', nettoyer);
    // Repli si afterprint ne se déclenche pas (certains navigateurs mobiles).
    setTimeout(() => { if (document.body.classList.contains('printing')) nettoyer(); }, 60000);

    window.print();
  }
};

// ============================================================
// IO — import/export ZIP + JSON
// ============================================================
const IO = {
  /** @param scenario  celui de l'éditeur par défaut ; explicite depuis la bibliothèque. */
  async exportZip(scenario = null) {
    if (!window.JSZip) { Toast.error('JSZip indisponible'); return; }
    try {
      const zip = new JSZip();
      const scn = scenario || Scenario.current;
      // Scénario sans les dataURL inline (les assets sont mis dans /assets/)
      const exported = JSON.parse(JSON.stringify(scn));
      exported.assets = exported.assets.map(a => ({
        id: a.id, name: a.name, type: a.type, size: a.size,
        path: `assets/${a.id}_${a.name}`
      }));
      zip.file('scenario.json', JSON.stringify(exported, null, 2));

      // Les médias sont lus un par un depuis leur store : on ne charge
      // jamais l'ensemble de la bibliothèque en mémoire d'un coup.
      let manquants = 0;
      for (const a of scn.assets) {
        const blob = await AssetStore.getBlob(a.id);
        if (!blob) { manquants++; continue; }
        zip.file(`assets/${a.id}_${a.name}`, blob);
      }
      if (manquants) Toast.warn(`${compte(manquants, 'média')} introuvable${manquants > 1 ? 's' : ''} : exporté${manquants > 1 ? 's' : ''} sans contenu`);

      const blob = await zip.generateAsync({ type: 'blob' });
      const filename = `${slugify(scn.meta.title)}.zip`;
      this._download(blob, filename);
      Toast.ok('Scénario exporté en ZIP');
    } catch (e) {
      console.error(e);
      Toast.error('Échec de l\'export');
    }
  },

  importZipDialog() {
    const input = el('input', {
      type: 'file',
      accept: '.zip',
      onchange: async e => {
        const f = e.target.files[0];
        if (!f) return;
        const ok = await this.importZip(f);
        // Depuis l'accueil, un import réussi n'aboutissait nulle part.
        if (ok && (location.hash.slice(1) || 'home') === 'home') location.hash = 'editor';
      }
    });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  },

  async importZip(file) {
    if (!window.JSZip) { Toast.error('JSZip indisponible'); return false; }

    // Lecture du fichier : c'est le seul endroit où « ZIP corrompu » est
    // un diagnostic honnête. Tout ce qui suit relève de l'application.
    let json;
    const pendingAssets = [];
    try {
      const zip = await JSZip.loadAsync(file);
      const scnFile = zip.file('scenario.json');
      if (!scnFile) { Toast.error('scenario.json manquant dans le ZIP'); return false; }
      json = JSON.parse(await scnFile.async('string'));
      // Les binaires vont directement dans leur store, indexés par le
      // scénario auquel ils appartiennent.
      const declared = Array.isArray(json.assets) ? json.assets : [];
      const scenarioId = typeof json.id === 'string' && json.id ? json.id : null;
      const kept = [];
      for (const a of declared) {
        if (!a || typeof a.id !== 'string') continue;
        const entry = zip.file(a.path || `assets/${a.id}_${a.name}`);
        if (!entry) { kept.push(a); continue; }
        const blob = await entry.async('blob');
        pendingAssets.push({
          asset: { id: a.id, name: a.name || a.id, type: a.type || blob.type || '' },
          blob, scenarioId
        });
        kept.push({ id: a.id, name: a.name || a.id, type: a.type || blob.type || '', size: blob.size });
      }
      json.assets = kept;
    } catch (e) {
      console.error(e);
      Toast.error('ZIP illisible ou corrompu');
      return false;
    }

    // migrateScenario() répare ou écarte ce qui ne tient pas debout, donc
    // ce chargement ne peut plus faire échouer l'import.
    Scenario.load(json);
    const scenarioId = Scenario.current.id;
    for (const { asset, blob } of pendingAssets) {
      try { await AssetStore.put(scenarioId, asset, blob); }
      catch (e) { console.error('[import] média non enregistré :', asset.name, e); }
    }
    Storage.setCurrent(scenarioId);
    Editor.rebuild(); // no-op si l'éditeur n'est pas monté
    Toast.ok(`« ${Scenario.current.meta.title || 'Scénario'} » importé`);
    return true;
  },

  exportJson() {
    const blob = new Blob([JSON.stringify(Scenario.current, null, 2)], { type: 'application/json' });
    this._download(blob, `${slugify(Scenario.current.meta.title)}.json`);
    Toast.ok('JSON exporté');
  },

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
};

// ============================================================
// PlayerState — état de partie persistant
// ============================================================
const PlayerState = {
  _key(scenarioId) { return `parcours.play.${scenarioId}`; },

  create(scenario, teamName, testMode = false) {
    return {
      scenarioId: scenario.id,
      scenarioTitle: scenario.meta.title || 'Parcours',
      teamName: teamName || (testMode ? 'Test' : 'Équipe'),
      testMode,
      startedAt: Date.now(),
      currentNodeId: null,
      history: [],           // [{ nodeId, title, type, enteredAt, completedAt, attempts, lastAnswer }]
      answers: {},
      flags: [],
      lastAnswerCorrect: null,
      ended: false,
      endedAt: null
    };
  },

  save(state) {
    if (state.testMode) return; // on ne persiste pas l'état de test
    try { localStorage.setItem(this._key(state.scenarioId), JSON.stringify(state)); } catch (e) {}
  },

  load(scenarioId) {
    try {
      const raw = localStorage.getItem(this._key(scenarioId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  clear(scenarioId) {
    try { localStorage.removeItem(this._key(scenarioId)); } catch (e) {}
  }
};

// ============================================================
// Player — runtime de jeu
// ============================================================
const Player = {
  container: null,
  scenario: null,
  state: null,
  geoWatchId: null,
  qrStream: null,
  qrAnimFrame: null,

  mount(container, opts = {}) {
    this.cleanup();
    this.container = container;
    this.scenario = Scenario.current;
    this._routeLength = null;

    if (!this.scenario || !this.scenario.nodes || this.scenario.nodes.length === 0) {
      this._renderEmpty(opts);
      return;
    }

    const testMode = !!opts.test;

    // En mode test on part toujours frais
    if (testMode) {
      this._renderStart({ test: true });
      return;
    }

    // En mode jeu, propose de reprendre si progression existante
    const saved = PlayerState.load(this.scenario.id);
    if (saved && !saved.ended) {
      this._renderResume(saved);
    } else {
      this._renderStart({ test: false });
    }
  },

  unmount() { this.cleanup(); },

  cleanup() {
    if (this.geoWatchId != null) {
      try { navigator.geolocation.clearWatch(this.geoWatchId); } catch (e) {}
      this.geoWatchId = null;
    }
    if (this.qrStream) {
      this.qrStream.getTracks().forEach(t => t.stop());
      this.qrStream = null;
    }
    if (this.qrAnimFrame) {
      cancelAnimationFrame(this.qrAnimFrame);
      this.qrAnimFrame = null;
    }
    if (this._playerMap) {
      try { this._playerMap.stop(); } catch (e) {}
      try { this._playerMap.remove(); } catch (e) {}
      this._playerMap = null;
    }
    if (this._playerMapWatchId != null) {
      try { navigator.geolocation.clearWatch(this._playerMapWatchId); } catch (e) {}
      this._playerMapWatchId = null;
    }
  },

  // ---------- Écrans ----------
  _renderEmpty(opts) {
    this.container.innerHTML = '';
    const w = el('div', { class: 'play-wrapper solo' });
    w.appendChild(el('div', { class: 'play-start-card' },
      el('div', { class: 'kicker' }, opts.test ? 'Test impossible' : 'Aucun scénario'),
      el('h1', {}, opts.test ? 'Rien à ' : 'Charger un ', el('em', {}, opts.test ? 'tester' : 'parcours')),
      el('p', { class: 'pitch' },
        opts.test
          ? 'Ce scénario n\'a pas encore de nœud. Retourne dans l\'éditeur pour en ajouter.'
          : 'Importe un fichier .zip de parcours, ou crée-en un dans l\'éditeur.'
      ),
      el('div', { class: 'btn-row', style: { justifyContent: 'center' } },
        !opts.test && el('button', {
          class: 'btn accent',
          onclick: () => {
            const input = el('input', {
              type: 'file', accept: '.zip',
              onchange: async e => {
                const f = e.target.files[0];
                if (f && await IO.importZip(f)) this.mount(this.container, opts);
              }
            });
            input.click();
          }
        }, 'Charger un ZIP'),
        el('button', { class: 'btn ghost', onclick: () => location.hash = 'editor' }, 'Ouvrir l\'éditeur')
      )
    ));
    this.container.appendChild(w);
  },

  _renderStart(opts) {
    const scn = this.scenario;
    this.container.innerHTML = '';
    const w = el('div', { class: 'play-wrapper solo' });

    const teamInput = el('input', {
      type: 'text',
      class: 'big-input',
      placeholder: opts.test ? 'Test' : 'Nom de l\'équipe',
      value: opts.test ? 'Test' : ''
    });
    if (opts.test) teamInput.style.display = 'none';

    const hasStart = !!scn.meta.startNodeId && !!Scenario.getNode(scn.meta.startNodeId);

    w.appendChild(el('div', { class: 'play-start-card' },
      el('div', { class: 'kicker' }, opts.test ? 'Mode test' : 'Au départ'),
      el('h1', {},
        scn.meta.title ? scn.meta.title.split(' ').slice(0, -1).join(' ') + ' ' : 'Nouveau ',
        el('em', {}, scn.meta.title ? scn.meta.title.split(' ').slice(-1).join(' ') : 'parcours')
      ),
      scn.meta.description && el('p', { class: 'pitch' }, scn.meta.description),
      el('div', { class: 'info-row' },
        el('span', { class: 'chip' }, compte(scn.nodes.length, 'nœud')),
        scn.meta.duration && el('span', { class: 'chip' }, `~${scn.meta.duration} min`),
        scn.meta.difficulty && el('span', { class: 'chip' }, scn.meta.difficulty),
        scn.meta.author && el('span', { class: 'chip' }, scn.meta.author)
      ),
      !opts.test && teamInput,
      !hasStart && el('div', { class: 'play-status warn' },
        'Aucun nœud de départ défini dans le scénario.'
      ),
      el('button', {
        class: 'btn-huge accent',
        disabled: !hasStart,
        onclick: () => {
          const team = opts.test ? 'Test' : (teamInput.value.trim() || 'Équipe');
          this._startGame(team, opts.test);
        }
      }, opts.test ? '▶ Lancer le test' : '▶ Commencer'),
      opts.test && el('button', {
        class: 'btn ghost',
        style: { width: '100%', marginTop: '10px' },
        onclick: () => location.hash = 'editor'
      }, '← Retour à l\'éditeur')
    ));

    this.container.appendChild(w);
    if (!opts.test) setTimeout(() => teamInput.focus(), 100);
  },

  _renderResume(saved) {
    this.container.innerHTML = '';
    const w = el('div', { class: 'play-wrapper solo' });
    const current = Scenario.getNode(saved.currentNodeId);
    const progress = saved.history.length;

    w.appendChild(el('div', { class: 'play-start-card' },
      el('div', { class: 'kicker' }, 'Partie en cours'),
      el('h1', {}, 'Reprendre l\'', el('em', {}, 'aventure')),
      el('p', { class: 'pitch' },
        `${saved.teamName} · ${compte(progress, 'étape')} · en cours à « ${current?.title || '?'} »`
      ),
      el('button', {
        class: 'btn-huge accent',
        onclick: () => { this.state = saved; this._renderNode(); }
      }, '▶ Reprendre'),
      el('button', {
        class: 'btn-huge',
        style: { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line)' },
        onclick: async () => {
          if (await Modal.confirm('Recommencer depuis le début ?', {
            titre: 'Repartir à zéro', valider: 'Recommencer', danger: true,
            detail: 'La progression en cours sera effacée.'
          })) {
            PlayerState.clear(this.scenario.id);
            this._renderStart({ test: false });
          }
        }
      }, 'Recommencer à zéro')
    ));
    this.container.appendChild(w);
  },

  _startGame(teamName, testMode) {
    this.state = PlayerState.create(this.scenario, teamName, testMode);
    const startId = this.scenario.meta.startNodeId || this.scenario.nodes[0]?.id;
    if (!startId) { Toast.error('Aucun nœud de départ'); return; }
    this._enterNode(startId);
  },

  _enterNode(nodeId) {
    const node = Scenario.getNode(nodeId);
    if (!node) { Toast.error('Nœud introuvable'); this._endGame(); return; }
    this.state.currentNodeId = nodeId;
    this.state.history.push({
      nodeId, title: node.title, type: node.type,
      enteredAt: Date.now(), completedAt: null,
      attempts: 0, lastAnswer: null
    });
    PlayerState.save(this.state);
    this._renderNode();
  },

  _completeNode(answer = null, correct = true, flagsSupplementaires = []) {
    const last = this.state.history[this.state.history.length - 1];
    if (last) {
      last.completedAt = Date.now();
      last.lastAnswer = answer;
      last.attempts = (last.attempts || 0) + 1;
    }
    this.state.lastAnswerCorrect = correct;
    if (answer != null) this.state.answers[this.state.currentNodeId] = answer;
    // Les flags déclarés sur le nœud sont posés ici : c'est ce qui rendait
    // les conditions « si flag » et les checkpoints inertes jusqu'ici.
    const aPoser = [...flagsSetBy(Scenario.getNode(this.state.currentNodeId)), ...flagsSupplementaires];
    const nouveaux = aPoser.filter(f => !this.state.flags.includes(f));
    nouveaux.forEach(f => this.state.flags.push(f));
    if (nouveaux.length) Toast.ok(`Acquis : ${nouveaux.join(', ')}`);
    PlayerState.save(this.state);

    const currentNode = Scenario.getNode(this.state.currentNodeId);
    if (currentNode?.type === 'outro') { this._endGame(); return; }

    const { targetId, reason } = pickNextNode(
      Scenario.getLinksFrom(this.state.currentNodeId),
      { correct: this.state.lastAnswerCorrect, flags: this.state.flags }
    );
    if (reason === 'rescue') {
      // Aucune condition ne correspond et l'auteur n'a pas prévu de repli.
      // On avance quand même : abandonner une équipe sur l'écran de fin,
      // au milieu du parcours, est le pire des deux maux.
      console.warn('Aucun lien praticable depuis', this.state.currentNodeId, '— repli sur le premier.');
    }
    if (targetId) this._enterNode(targetId);
    else this._endGame();
  },

  /** Une tentative infructueuse qui ne fait pas avancer le joueur. */
  _registerAttempt(answer) {
    const last = this.state.history[this.state.history.length - 1];
    if (last) {
      last.attempts = (last.attempts || 0) + 1;
      last.lastAnswer = answer;
    }
    this.state.lastAnswerCorrect = false;
    PlayerState.save(this.state);
    return last?.attempts || 1;
  },

  /**
   * Aiguillage après une réponse. Sur `retry`, le joueur reste sur place :
   * c'est le défaut, parce qu'avancer sur une mauvaise réponse rendait
   * l'énigme décorative — ou terminait la partie en silence.
   */
  _submitAnswer(node, answer, correct, { onRetry } = {}) {
    if (correct) { this._completeNode(answer, true); return; }
    if (onWrongBehaviour(node) === ON_WRONG.CONTINUE) { this._completeNode(answer, false); return; }
    const attempts = this._registerAttempt(answer);
    onRetry?.(attempts);
  },

  _endGame() {
    this.cleanup();
    this.state.ended = true;
    this.state.endedAt = Date.now();
    PlayerState.save(this.state);
    this._renderEnd();
  },

  // ---------- Rendu du nœud ----------
  _renderNode() {
    this.cleanup();
    const node = Scenario.getNode(this.state.currentNodeId);
    if (!node) { this._endGame(); return; }

    this.container.innerHTML = '';
    const w = el('div', { class: 'play-wrapper' });

    // Meta bar
    const meta = el('div', { class: 'play-meta' },
      el('span', {}, this.scenario.meta.title || 'Parcours'),
      el('span', { class: 'team' },
        this.state.testMode ? el('span', { class: 'test-flag' }, 'Test') : this.state.teamName
      )
    );
    w.appendChild(meta);

    // Progression : le dénominateur est la longueur du chemin, pas le
    // nombre de nœuds — avec des branches, ce dernier est faux par
    // construction (12 nœuds dont 4 variantes affichaient « 8 / 12 »).
    const total = this._routeLength ??= mainRouteLength(this.scenario);
    const current = this.state.history.length;
    const prog = el('div', { class: 'play-progress' },
      el('span', {}, `Étape ${current}`),
      el('span', { class: 'bar', style: { '--pct': Math.min(100, (current / Math.max(total, current)) * 100) + '%' } }),
      el('span', {}, `${Math.max(total, current)}`)
    );
    w.appendChild(prog);

    // Carte du nœud
    const card = el('div', { class: 'play-card' });
    card.appendChild(el('span', { class: `play-type type-${node.type}` }, typeLabel(node.type)));
    card.appendChild(el('h1', { class: 'play-title' }, node.title));

    // Image
    if (node.media?.image) {
      const a = this.scenario.assets.find(x => x.id === node.media.image);
      if (a) card.appendChild(AssetStore.bind(el('img', { class: 'play-media', alt: '' }), a.id));
    }
    // Description
    if (node.description) card.appendChild(el('p', { class: 'play-desc' }, node.description));
    // Audio
    if (node.media?.audio) {
      const a = this.scenario.assets.find(x => x.id === node.media.audio);
      if (a) card.appendChild(AssetStore.bind(el('audio', { class: 'play-audio', controls: true }), a.id));
    }
    // Énigme : question en exergue
    if (node.type === 'enigme' && node.question) {
      card.appendChild(el('div', { class: 'play-question' }, node.question));
    }

    // Zone validation
    const valWrap = el('div', { class: 'play-validation' });

    if (node.type === 'intro') {
      valWrap.appendChild(el('button', {
        class: 'btn-huge accent',
        onclick: () => this._completeNode(null, true)
      }, "C'est parti !"));
    } else if (node.type === 'outro') {
      valWrap.appendChild(el('button', {
        class: 'btn-huge accent',
        onclick: () => this._endGame()
      }, 'Terminer'));
    } else if (node.type === 'checkpoint' && missingFlags(node, this.state.flags).length) {
      this._buildCheckpointBlocked(valWrap, node);
    } else if (node.type === 'enigme') {
      this._buildEnigmeUI(valWrap, node);
    } else {
      const valType = node.validation?.type || 'none';
      if (valType === 'qr')        this._buildQRUI(valWrap, node);
      else if (valType === 'gps')  this._buildGPSUI(valWrap, node);
      else if (valType === 'code') this._buildCodeUI(valWrap, node);
      else                         this._buildNoneUI(valWrap, node);
    }
    // Mini-carte si activée et nœud positionné
    if (this.scenario.meta.showMapToPlayers && hasPosition(node)) {
      const mapSection = el('div', { class: 'play-map-section' },
        el('div', { class: 'map-label' }, 'Destination'),
        el('div', { class: 'play-node-map', id: 'play-node-map-el' })
      );
      card.appendChild(mapSection);
    }

    card.appendChild(valWrap);

    // Panneau test
    if (this.state.testMode) {
      card.appendChild(this._buildTestPanel(node));
    }

    w.appendChild(card);

    // Sortie
    const exitRow = el('div', { class: 'btn-row', style: { justifyContent: 'center', marginTop: '20px' } },
      this.state.testMode
        ? el('button', { class: 'btn ghost', onclick: () => location.hash = 'editor' }, '← Retour à l\'éditeur')
        : el('button', {
          class: 'btn ghost',
          onclick: async () => {
            if (await Modal.confirm('Quitter la partie ?', {
              titre: 'Quitter', valider: 'Quitter',
              detail: 'La progression est sauvegardée : tu pourras reprendre où tu en étais.'
            })) {
              this.cleanup();
              location.hash = 'home';
            }
          }
        }, 'Quitter')
    );
    w.appendChild(exitRow);

    this.container.appendChild(w);

    // Initialiser la mini-carte après injection dans le DOM
    if (this.scenario.meta.showMapToPlayers && hasPosition(node)) {
      this._buildNodeMap(document.getElementById('play-node-map-el'), node);
    }
  },

  _buildNodeMap(mapEl, node) {
    if (!mapEl) return;
    const providerId = this.scenario.meta.tileProvider || DEFAULT_PROVIDER;
    const { lat, lng } = node.position;

    const map = L.map(mapEl, { zoomControl: true }).setView([lat, lng], 15);
    this._playerMap = map;
    createCachedTileLayer(providerId).addTo(map);

    const icon = L.divIcon({
      className: `node-marker type-${node.type}`,
      html: '★',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    L.marker([lat, lng], { icon, title: node.title }).addTo(map);

    // Position du joueur si GPS dispo
    if (navigator.geolocation && window.isSecureContext) {
      let playerMarker = null;
      this._playerMapWatchId = navigator.geolocation.watchPosition(
        pos => {
          const ll = [pos.coords.latitude, pos.coords.longitude];
          if (!playerMarker) {
            // Même raison qu'ailleurs : un token CSS ne se résout pas
            // dans un attribut SVG.
            const rust = cssVar('--rust', '#b0613a');
            playerMarker = L.circleMarker(ll, {
              radius: 7,
              color: rust,
              fillColor: rust,
              fillOpacity: 0.85,
              weight: 2
            }).addTo(map);
          } else {
            playerMarker.setLatLng(ll);
          }
        },
        null,
        { enableHighAccuracy: true, maximumAge: 4000 }
      );
    }
  },

  // ---------- Validations ----------

  /**
   * Un checkpoint dont les prérequis manquent ne se franchit pas. On dit
   * lesquels manquent : une équipe bloquée sans explication abandonne.
   */
  _buildCheckpointBlocked(container, node) {
    const manquants = missingFlags(node, this.state.flags);
    container.appendChild(el('div', { class: 'play-status warn' },
      `Il manque ${manquants.length === 1 ? 'un élément' : `${manquants.length} éléments`} pour passer.`
    ));
    const liste = el('div', { class: 'checkpoint-flags' });
    for (const f of flagsRequiredBy(node)) {
      const acquis = this.state.flags.includes(f);
      liste.appendChild(el('div', { class: 'flag-line' + (acquis ? ' acquis' : '') },
        el('span', { class: 'coche' }, acquis ? '✓' : '○'),
        el('span', {}, f)
      ));
    }
    container.appendChild(liste);

    const revenir = Scenario.getLinksTo(node.id).length > 0;
    container.appendChild(el('button', {
      class: 'btn-huge',
      onclick: () => {
        // On renvoie l'équipe au nœud précédent de son propre historique.
        const precedent = [...this.state.history].reverse().find(h => h.nodeId !== node.id);
        if (precedent && Scenario.getNode(precedent.nodeId)) this._enterNode(precedent.nodeId);
        else Toast.info('Va chercher ce qu\'il te manque, puis reviens.');
      }
    }, revenir ? '← Retourner en arrière' : 'Compris'));
  },

  _buildNoneUI(container, node) {
    container.appendChild(el('button', {
      class: 'btn-huge forest',
      onclick: () => this._completeNode(null, true)
    }, '✓ Continuer'));
  },

  _buildCodeUI(container, node) {
    const input = el('input', { type: 'text', class: 'big-input', placeholder: 'Entre le code' });
    const btn = el('button', { class: 'btn-huge accent' }, 'Valider');
    const retryNote = el('div', { class: 'play-status warn', style: { display: 'none' } });
    const submit = () => {
      const val = input.value.trim();
      if (!val) { Toast.warn('Saisis un code'); return; }
      const correct = answersMatch(val, node.validation?.value);
      if (correct) Toast.ok('Code correct !');
      else Toast.error('Code incorrect');
      this._submitAnswer(node, val, correct, {
        onRetry: (attempts) => {
          retryNote.style.display = '';
          retryNote.textContent = `Ce n'est pas le bon code. Essai ${attempts} — réessaie.`;
          input.value = '';
          input.focus();
        }
      });
    };
    btn.onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    container.appendChild(input);
    container.appendChild(btn);
    container.appendChild(retryNote);
    setTimeout(() => input.focus(), 80);
  },

  _buildEnigmeUI(container, node) {
    const input = el('textarea', { class: 'big-input', rows: 2, placeholder: 'Ta réponse…' });
    const btn = el('button', { class: 'btn-huge accent' }, 'Répondre');
    const retryNote = el('div', { class: 'play-status warn', style: { display: 'none' } });
    const submit = () => {
      const val = input.value.trim();
      if (!val) { Toast.warn('Donne une réponse'); return; }
      const correct = answersMatch(val, node.answer);
      if (correct) Toast.ok('Bonne réponse !');
      else Toast.warn('Ce n\'est pas la bonne réponse');
      this._submitAnswer(node, val, correct, {
        onRetry: (attempts) => {
          retryNote.style.display = '';
          retryNote.textContent = `Essai ${attempts} — reprends l'énoncé et retente.`;
          input.value = '';
          input.focus();
        }
      });
    };
    btn.onclick = submit;
    container.appendChild(input);
    container.appendChild(btn);
    container.appendChild(retryNote);
    setTimeout(() => input.focus(), 80);
  },

  _buildGPSUI(container, node) {
    const wrap = el('div', { class: 'play-gps' });
    const distEl = el('div', { class: 'gps-distance' }, '—', el('span', { class: 'unit' }, 'm'));
    const threshEl = el('div', { class: 'gps-threshold' },
      `Seuil : ${node.validation?.radius || 20} m`
    );
    const status = el('div', { class: 'play-status' }, 'Acquisition GPS…');
    const btn = el('button', { class: 'btn-huge forest', disabled: true }, 'Je suis arrivé');

    wrap.appendChild(distEl);
    wrap.appendChild(threshEl);
    wrap.appendChild(status);
    wrap.appendChild(btn);
    container.appendChild(wrap);

    const target = node.position;
    const radius = node.validation?.radius || 20;

    if (!hasPosition(node)) {
      status.textContent = 'Ce nœud n\'a pas de position définie.';
      status.classList.add('warn');
      return;
    }
    if (!navigator.geolocation) {
      status.textContent = 'Géolocalisation non supportée par ce navigateur.';
      status.classList.add('warn');
      this._appendGPSFallback(container, node);
      return;
    }

    // Vérifier le contexte sécurisé (HTTPS / localhost)
    const isSecure = window.isSecureContext;
    if (!isSecure) {
      status.innerHTML = 'Le GPS nécessite <strong>HTTPS</strong>. Ouvre l\'app via une URL sécurisée ou <code>localhost</code>.';
      status.classList.add('warn');
      this._appendGPSFallback(container, node);
      return;
    }

    let lastDist = null;
    const startWatch = () => {
      status.textContent = 'Acquisition GPS…';
      status.classList.remove('warn');
      // Clean previous watch if retrying
      if (this.geoWatchId != null) {
        try { navigator.geolocation.clearWatch(this.geoWatchId); } catch (e) {}
      }
      this.geoWatchId = navigator.geolocation.watchPosition(
        pos => {
          const d = haversine(pos.coords.latitude, pos.coords.longitude, target.lat, target.lng);
          lastDist = d;
          distEl.firstChild.textContent = d < 1000 ? Math.round(d) : (d / 1000).toFixed(1);
          distEl.querySelector('.unit').textContent = d < 1000 ? 'm' : 'km';
          status.textContent = `Précision ±${Math.round(pos.coords.accuracy)} m`;
          const near = d <= radius;
          wrap.classList.toggle('gps-near', near);
          btn.disabled = !near;
          if (near) {
            status.textContent = '✓ Tu es à destination';
            status.classList.add('ok');
            status.classList.remove('warn');
          } else {
            status.classList.remove('ok');
          }
        },
        err => {
          let msg = '';
          // Codes standard : 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
          if (err.code === 1) {
            msg = 'Permission refusée. Clique sur l\'icône cadenas dans la barre d\'adresse → Autoriser la localisation, puis recharge la page.';
          } else if (err.code === 2) {
            msg = 'Position indisponible. Vérifie que le GPS de ton appareil est activé et que tu es dans un endroit avec réception.';
          } else if (err.code === 3) {
            msg = 'Délai dépassé. Le GPS met du temps à accrocher un signal, essaie de ressortir à l\'air libre et réessaie.';
          } else {
            msg = 'Erreur GPS : ' + (err.message || 'inconnue');
          }
          status.textContent = msg;
          status.classList.add('warn');
          // Affiche le bouton réessayer + fallback manuel
          if (!container.querySelector('.gps-retry')) {
            const retryRow = el('div', { class: 'gps-retry', style: { marginTop: '10px' } },
              el('button', {
                class: 'btn ghost',
                style: { width: '100%' },
                onclick: () => {
                  // Supprime les fallbacks existants pour réessayer proprement
                  container.querySelectorAll('.gps-retry, .gps-fallback').forEach(n => n.remove());
                  startWatch();
                }
              }, '↻ Réessayer')
            );
            container.appendChild(retryRow);
            this._appendGPSFallback(container, node, lastDist);
          }
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
    };

    startWatch();

    btn.onclick = () => {
      this._completeNode({ type: 'gps_arrived', distance: lastDist }, true);
    };
  },

  _appendGPSFallback(container, node, lastDist = null) {
    const wrap = el('div', { class: 'gps-fallback' });
    wrap.appendChild(el('div', {
      style: {
        textAlign: 'center', margin: '14px 0 8px',
        color: 'var(--ink-faint)', fontSize: '11px',
        textTransform: 'uppercase', letterSpacing: '0.1em',
        fontFamily: 'var(--font-mono)'
      }
    }, 'ou valider manuellement'));
    wrap.appendChild(el('p', {
      style: { fontSize: '12.5px', color: 'var(--ink-soft)', textAlign: 'center', margin: '0 0 10px', fontStyle: 'italic' }
    }, `Coordonnées cibles : ${node.position.lat.toFixed(5)}, ${node.position.lng.toFixed(5)}`));
    wrap.appendChild(el('button', {
      class: 'btn-huge',
      onclick: async () => {
        if (await Modal.confirm('Valider manuellement l\'arrivée à ce point ?', {
          titre: 'Validation manuelle', valider: 'Je confirme',
          detail: 'À n\'utiliser que si le GPS ne répond pas : la validation sera notée comme manuelle.'
        })) {
          this._completeNode({ type: 'gps_manual', distance: lastDist }, true);
        }
      }
    }, '✓ Je confirme être arrivé'));
    container.appendChild(wrap);
  },

  async _buildQRUI(container, node) {
    const wrap = el('div', { class: 'play-qr' });
    const video = el('video', { autoplay: true, playsinline: true, muted: true });
    const frame = el('div', { class: 'scan-frame' });
    wrap.appendChild(video);
    wrap.appendChild(frame);
    container.appendChild(wrap);

    const status = el('div', { class: 'play-status' }, 'Démarrage de la caméra…');
    container.appendChild(status);

    const fallback = el('div', {},
      el('div', { style: { textAlign: 'center', margin: '12px 0', color: 'var(--ink-faint)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--font-mono)' } },
        'ou saisir manuellement'
      ),
      this._manualQRInput(node)
    );
    container.appendChild(fallback);

    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'Caméra non supportée. Utilise la saisie manuelle.';
      status.classList.add('warn');
      return;
    }

    try {
      this.qrStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      video.srcObject = this.qrStream;
      await new Promise(r => { video.onloadedmetadata = r; });
      video.play().catch(() => {});

      status.textContent = 'Vise un QR code avec la caméra';

      // Beaucoup de QR sont posés en intérieur sombre ou à l'ombre.
      const track = this.qrStream.getVideoTracks()[0];
      if (track?.getCapabilities?.().torch) {
        let on = false;
        const torch = el('button', { class: 'btn ghost small qr-torch' }, '🔦 Lampe');
        torch.onclick = async () => {
          on = !on;
          try {
            await track.applyConstraints({ advanced: [{ torch: on }] });
            torch.classList.toggle('active', on);
          } catch (e) { Toast.warn('Lampe indisponible'); }
        };
        wrap.appendChild(torch);
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const expected = node.validation?.value || '';
      // Analyser 1920×1080 soixante fois par seconde, c'est deux millions
      // de pixels par image pour rien : jsQR lit très bien à 480 px de
      // large, et la batterie est la ressource critique sur le terrain.
      const SCAN_WIDTH = 480;
      const SCAN_INTERVAL = 100; // ms — 10 analyses par seconde suffisent
      let lastScan = 0;

      const scan = (now = 0) => {
        if (!this.qrStream) return;
        if (now - lastScan >= SCAN_INTERVAL &&
            video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
          lastScan = now;
          const scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
          canvas.width  = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) {
              if (answersMatch(code.data, expected)) {
                status.textContent = '✓ QR valide !';
                status.classList.add('ok');
                this.cleanup();
                setTimeout(() => this._completeNode(code.data, true), 400);
                return;
              } else {
                status.textContent = `QR détecté (mais ce n\'est pas le bon) : ${code.data.slice(0, 30)}`;
                status.classList.add('warn');
              }
            }
          } catch (e) { /* ignore frames trop grandes */ }
        }
        this.qrAnimFrame = requestAnimationFrame(scan);
      };
      this.qrAnimFrame = requestAnimationFrame(scan);
    } catch (e) {
      status.textContent = 'Caméra inaccessible : ' + (e.message || e.name || 'refusée');
      status.classList.add('warn');
    }
  },

  _manualQRInput(node) {
    const input = el('input', { type: 'text', class: 'big-input', placeholder: 'Contenu du QR' });
    const btn = el('button', { class: 'btn-huge' }, 'Valider manuellement');
    const retryNote = el('div', { class: 'play-status warn', style: { display: 'none' } });
    btn.onclick = () => {
      const val = input.value.trim();
      if (!val) { Toast.warn('Saisis le contenu du QR'); return; }
      // Même règle de comparaison que le scan et que les codes saisis :
      // un espace de trop côté éditeur ne doit pas bloquer une équipe.
      const correct = answersMatch(val, node.validation?.value);
      if (correct) Toast.ok('QR valide !');
      else Toast.error('Mauvais QR');
      if (correct || onWrongBehaviour(node) === ON_WRONG.CONTINUE) this.cleanup();
      this._submitAnswer(node, val, correct, {
        onRetry: (attempts) => {
          retryNote.style.display = '';
          retryNote.textContent = `Contenu inattendu. Essai ${attempts} — vérifie le code.`;
          input.value = '';
          input.focus();
        }
      });
    };
    return el('div', {}, input, btn, retryNote);
  },

  _buildTestPanel(node) {
    const panel = el('div', { class: 'test-panel' });
    panel.appendChild(el('div', { class: 'label' }, '⚑ Panneau test'));

    const actions = el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn small accent',
        onclick: () => this._completeNode(null, true)
      }, '✓ Passer (correct)'),
      el('button', {
        class: 'btn small ghost',
        onclick: () => this._completeNode(null, false)
      }, '✗ Passer (incorrect)')
    );
    panel.appendChild(actions);

    // Sauteur vers un autre nœud
    const jumpSelect = el('select', { onchange: e => {
      const id = e.target.value;
      if (id) {
        this.cleanup();
        this._enterNode(id);
      }
    } });
    jumpSelect.appendChild(el('option', { value: '' }, '— Sauter vers un nœud —'));
    this.scenario.nodes.forEach(n => {
      const opt = el('option', { value: n.id }, `[${typeLabel(n.type)}] ${n.title}`);
      if (n.id === this.state.currentNodeId) opt.selected = true;
      jumpSelect.appendChild(opt);
    });
    panel.appendChild(jumpSelect);

    // Flags détenus — sans cela on teste un branchement à l'aveugle.
    const tousFlags = allFlags(this.scenario);
    if (tousFlags.length) {
      const ligne = el('div', { class: 'test-flags' });
      ligne.appendChild(el('span', { class: 'etiquette' }, 'Flags :'));
      for (const f of tousFlags) {
        const actif = this.state.flags.includes(f);
        ligne.appendChild(el('button', {
          class: 'flag-toggle' + (actif ? ' actif' : ''),
          title: actif ? 'Retirer ce flag' : 'Poser ce flag',
          onclick: () => {
            this.state.flags = actif ? this.state.flags.filter(x => x !== f) : [...this.state.flags, f];
            PlayerState.save(this.state);
            this._renderNode();
          }
        }, f));
      }
      panel.appendChild(ligne);
    }

    // Infos liens sortants
    const outLinks = Scenario.getLinksFrom(node.id);
    if (outLinks.length) {
      const info = el('div', { style: { fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-soft)', marginTop: '8px', lineHeight: '1.5' } });
      outLinks.forEach(l => {
        const target = Scenario.getNode(l.target);
        const cond = l.condition ? ` [${l.condition.type}${l.condition.value ? ':' + l.condition.value : ''}]` : '';
        info.appendChild(el('div', {}, `→ ${target?.title || '?'}${cond}`));
      });
      panel.appendChild(info);
    } else {
      panel.appendChild(el('div', { style: { fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--rust-dark)', marginTop: '8px' } },
        '⚠ Aucun lien sortant — ce sera la fin.'
      ));
    }

    return panel;
  },

  // ---------- Fin de partie ----------
  _renderEnd() {
    this.container.innerHTML = '';
    const w = el('div', { class: 'play-wrapper' });

    const durSec = Math.round((this.state.endedAt - this.state.startedAt) / 1000);
    const durMin = Math.floor(durSec / 60);
    const durRem = durSec % 60;
    const correctCount = this.state.history.filter(h => h.attempts > 0).length;
    const totalAttempts = this.state.history.reduce((a, h) => a + (h.attempts || 0), 0);

    const results = this._buildResults();

    const endCard = el('div', { class: 'play-end-card' });
    endCard.appendChild(el('div', { class: 'kicker' }, this.state.testMode ? 'Test terminé' : 'Parcours terminé'));
    endCard.appendChild(el('h1', {}, this.state.testMode ? 'Test ' : 'Bravo ', el('em', {}, this.state.teamName)));
    endCard.appendChild(el('p', { class: 'end-sub' }, this.scenario.meta.title || ''));

    endCard.appendChild(el('div', { class: 'play-end-stats' },
      el('div', { class: 'end-stat' },
        el('div', { class: 'v' }, durMin ? `${durMin}'${String(durRem).padStart(2, '0')}` : `${durRem}s`),
        el('div', { class: 'l' }, 'Durée')
      ),
      el('div', { class: 'end-stat' },
        el('div', { class: 'v' }, this.state.history.length),
        el('div', { class: 'l' }, 'Étapes')
      ),
      el('div', { class: 'end-stat' },
        el('div', { class: 'v' }, totalAttempts),
        el('div', { class: 'l' }, 'Essais')
      )
    ));

    const recap = el('div', { class: 'end-recap' });
    recap.appendChild(el('h3', {}, 'Parcours suivi'));
    this.state.history.forEach((h, i) => {
      const t = h.completedAt ? Math.round((h.completedAt - h.enteredAt) / 1000) : null;
      recap.appendChild(el('div', { class: 'recap-row' },
        el('span', { class: 'num' }, (i + 1) + '.'),
        el('span', { class: 'title' }, h.title || '(sans titre)'),
        h.attempts > 1 && el('span', { class: 'attempts' }, `${h.attempts}×`),
        el('span', { class: 'time' }, t != null ? `${t}s` : '—')
      ));
    });
    endCard.appendChild(recap);

    // Une action principale, le reste en retrait. Quatre boutons de trois
    // styles différents ne disaient pas ce qu'on est censé faire ensuite.
    const partage = el('div', { class: 'end-actions' },
      el('button', { class: 'btn-huge accent', onclick: () => this._shareWhatsApp(results) },
        'Partager le résultat'),
      el('div', { class: 'btn-row secondaires' },
        el('button', { class: 'btn ghost', onclick: () => this._exportResults(results) },
          'Exporter le fichier'),
        el('button', { class: 'btn ghost', onclick: () => location.hash = 'results' },
          'Comparer les équipes'),
        el('button', {
          class: 'btn ghost',
          onclick: async () => {
            if (this.state.testMode) {
              location.hash = 'editor';
            } else if (await Modal.confirm('Recommencer une nouvelle partie ?',
                                           { titre: 'Nouvelle partie', valider: 'Recommencer' })) {
              PlayerState.clear(this.scenario.id);
              this.mount(this.container, { test: false });
            }
          }
        }, this.state.testMode ? 'Retour à l\'éditeur' : 'Nouvelle partie')
      )
    );
    endCard.appendChild(partage);
    endCard.appendChild(el('p', { class: 'end-hint' },
      'Le fichier exporté sert à l\'organisateur : il y compare les équipes.'));

    w.appendChild(endCard);
    this.container.appendChild(w);
  },

  _buildResults() {
    return {
      version: APP_VERSION,
      scenarioId: this.state.scenarioId,
      scenarioTitle: this.state.scenarioTitle,
      teamName: this.state.teamName,
      testMode: this.state.testMode,
      startedAt: new Date(this.state.startedAt).toISOString(),
      endedAt: new Date(this.state.endedAt).toISOString(),
      durationSec: Math.round((this.state.endedAt - this.state.startedAt) / 1000),
      totalSteps: this.state.history.length,
      totalAttempts: this.state.history.reduce((a, h) => a + (h.attempts || 0), 0),
      flags: this.state.flags.slice(),
      path: this.state.history.map(h => ({
        nodeId: h.nodeId,
        title: h.title,
        type: h.type,
        enteredAt: new Date(h.enteredAt).toISOString(),
        completedAt: h.completedAt ? new Date(h.completedAt).toISOString() : null,
        durationSec: h.completedAt ? Math.round((h.completedAt - h.enteredAt) / 1000) : null,
        attempts: h.attempts || 0,
        answer: h.lastAnswer
      }))
    };
  },

  _exportResults(results) {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
    IO._download(blob, `resultats-${slugify(results.teamName + '-' + results.scenarioTitle)}.json`);
    Toast.ok('Résultats exportés');
  },

  _shareWhatsApp(results) {
    const mins = Math.floor(results.durationSec / 60);
    const secs = results.durationSec % 60;
    const time = mins ? `${mins}min${String(secs).padStart(2, '0')}` : `${secs}s`;
    const lines = [
      `🎯 ${results.scenarioTitle || 'Parcours'}`,
      `👥 ${results.teamName}`,
      `⏱ ${time} · ${results.totalSteps} étapes · ${results.totalAttempts} essais`,
      '',
      ...results.path.map((h, i) => {
        const t = h.durationSec != null ? `${h.durationSec}s` : '';
        const a = h.attempts > 1 ? ` (${h.attempts}×)` : '';
        return `${i + 1}. ${h.title}${a} · ${t}`;
      })
    ];
    const txt = lines.join('\n');
    const url = `https://wa.me/?text=${encodeURIComponent(txt)}`;
    window.open(url, '_blank');
  },

  // ---------- Helpers ----------
};

// ============================================================
// Results — comparer les copies de plusieurs équipes
// ============================================================
const Results = {
  mount(container) {
    this.container = container;
    this.classement = null;
    this.render();
  },

  render() {
    this.container.innerHTML = '';
    const w = el('div', { class: 'results-wrapper' });

    w.appendChild(el('div', { class: 'home-hero', style: { marginBottom: '28px' } },
      el('h1', {}, 'Comparer les ', el('em', {}, 'copies')),
      el('p', { class: 'subtitle' },
        'Dépose les fichiers de résultats exportés par chaque équipe : le classement se construit ici, hors ligne.')
    ));

    const drop = el('div', { class: 'upload-drop' },
      el('strong', {}, 'Déposer ou cliquer'),
      'Fichiers .json exportés en fin de partie'
    );
    drop.addEventListener('click', () => this._choisirFichiers());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragging');
      this._lireFichiers(e.dataTransfer.files);
    });
    w.appendChild(drop);

    if (this.classement) w.appendChild(this._renderClassement());
    this.container.appendChild(w);
  },

  _choisirFichiers() {
    const input = el('input', {
      type: 'file', accept: '.json,application/json', multiple: true,
      onchange: e => this._lireFichiers(e.target.files)
    });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  },

  async _lireFichiers(fileList) {
    const lus = [];
    for (const f of fileList) {
      try { lus.push(JSON.parse(await f.text())); }
      catch (e) { Toast.warn(`« ${f.name} » n'est pas un JSON lisible`); }
    }
    if (!lus.length) return;
    this.classement = buildRanking(lus);
    if (!this.classement.equipes.length) {
      Toast.error('Aucun résultat exploitable dans ces fichiers');
      this.classement = null;
    } else {
      if (this.classement.ignores) Toast.info(`${compte(this.classement.ignores, 'fichier')} ignoré${this.classement.ignores > 1 ? 's' : ''}`);
      if (this.classement.melange) Toast.warn('Ces résultats ne viennent pas tous du même parcours');
    }
    this.render();
  },

  _renderClassement() {
    const c = this.classement;
    const frag = el('div', { class: 'results-body' });

    frag.appendChild(el('h2', { class: 'results-title' },
      c.scenarioTitle || 'Résultats',
      el('span', { class: 'count' }, compte(c.equipes.length, 'équipe'))
    ));

    const table = el('div', { class: 'ranking' });
    table.appendChild(el('div', { class: 'ranking-head' },
      el('span', {}, 'Rang'), el('span', {}, 'Équipe'),
      el('span', {}, 'Temps'), el('span', {}, 'Étapes'), el('span', {}, 'Erreurs')
    ));
    for (const e of c.equipes) {
      table.appendChild(el('div', { class: 'ranking-row' + (e.rang === 1 ? ' premier' : '') },
        el('span', { class: 'rang' }, String(e.rang)),
        el('span', { class: 'equipe' }, e.teamName),
        el('span', { class: 'nombre' }, this._duree(e.durationSec)),
        el('span', { class: 'nombre' }, String(e.totalSteps)),
        el('span', { class: 'nombre' }, e.erreurs ? String(e.erreurs) : '—')
      ));
    }
    frag.appendChild(table);

    // Là où ça a bloqué : c'est ce qui sert à retoucher le parcours.
    const stats = stepStats(c).sort((a, b) => b.dureeMoyenne - a.dureeMoyenne);
    if (stats.length) {
      frag.appendChild(el('h3', { class: 'results-subtitle' }, 'Où les équipes ont buté'));
      const liste = el('div', { class: 'step-stats' });
      const pire = stats[0].dureeMoyenne || 1;
      for (const st of stats) {
        liste.appendChild(el('div', { class: 'step-row' },
          el('span', { class: 'titre' }, st.title || '(sans titre)'),
          el('span', { class: 'barre' }, el('span', { style: { width: (st.dureeMoyenne / pire * 100) + '%' } })),
          el('span', { class: 'nombre' }, this._duree(st.dureeMoyenne)),
          el('span', { class: 'essais' }, st.essaisMoyens > 1 ? `${st.essaisMoyens}× en moyenne` : '')
        ));
      }
      frag.appendChild(liste);
    }

    frag.appendChild(el('div', { class: 'btn-row', style: { marginTop: '20px' } },
      el('button', { class: 'btn ghost', onclick: () => { this.classement = null; this.render(); } }, 'Vider'),
      el('button', { class: 'btn', onclick: () => this._exporterCsv() }, '⬇ Export CSV')
    ));
    return frag;
  },

  _exporterCsv() {
    const lignes = [['rang', 'equipe', 'duree_sec', 'etapes', 'essais', 'erreurs'].join(';')];
    for (const e of this.classement.equipes) {
      lignes.push([e.rang, `"${e.teamName.replace(/"/g, '""')}"`, e.durationSec, e.totalSteps, e.totalAttempts, e.erreurs].join(';'));
    }
    const blob = new Blob(['\ufeff' + lignes.join('\n')], { type: 'text/csv;charset=utf-8' });
    IO._download(blob, `classement-${slugify(this.classement.scenarioTitle || 'parcours')}.csv`);
    Toast.ok('Classement exporté');
  },

  _duree(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}'${String(s).padStart(2, '0')}` : `${s}s`;
  }
};

// ============================================================
// App — routeur + cycle de vie
// ============================================================
const App = {
  root: null,
  dirty: false,

  async init() {
    this.root = $('#app');
    Toast.init();
    Storage.init();

    // Charge depuis la bibliothèque (ou migre l'ancien localStorage, ou crée vierge)
    let saved = await Storage.loadLast();
    if (!saved) saved = await Storage.migrateLegacy();
    if (!saved) {
      const list = await Library.list();
      if (list.length) saved = await Library.get(list[0].id);
    }
    Scenario.load(saved || Scenario.blank());

    // Autosave sur tout changement
    Scenario.on(() => {
      if (Storage.save) Storage.save();
      this.updateStatus();
    });

    window.addEventListener('hashchange', () => this.route());
    // IndexedDB n'a pas d'écriture synchrone : on force le vidage du
    // debounce au moment où l'onglet passe en arrière-plan — le seul
    // point d'accroche fiable sur mobile — et on prévient si ça n'a pas suivi.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.dirty) Storage.flush();
    });
    window.addEventListener('beforeunload', (e) => {
      if (!this.dirty) return;
      Storage.flush();
      e.preventDefault();
      e.returnValue = '';
    });

    if (!location.hash) location.hash = 'home';
    this.route();

    // Après le premier rendu : rien de tout cela ne doit retarder l'affichage.
    Offline.registerServiceWorker();
    Offline.requestPersistence().then(granted => {
      if (granted === false) {
        console.warn('[offline] stockage non persistant : le navigateur peut évincer les données.');
      }
    });
  },

  markDirty() {
    this.dirty = true;
    this.updateStatus();
  },
  markClean() {
    this.dirty = false;
    this.updateStatus();
  },

  updateStatus() {
    const dot = $('.status-dot', this.root);
    const lbl = $('.status-label', this.root);
    if (!dot || !lbl) return;
    if (this.dirty) {
      dot.classList.add('dirty');
      lbl.textContent = 'Enregistrement…';
    } else {
      dot.classList.remove('dirty');
      lbl.textContent = `Sauvegardé · ${new Date(Scenario.current.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    }
  },

  route() {
    const view = (location.hash.slice(1) || 'home').split('?')[0];
    this.render(view);
  },

  render(view) {
    // Cleanup vue précédente
    try { Player.unmount?.(); } catch (e) { console.error(e); }
    if (this._currentView === 'editor') {
      try { Editor.unmount(); } catch (e) { console.error(e); }
    }

    this.root.innerHTML = '';
    this._currentView = view;

    // Topbar
    const topbar = el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, 'Parcours', el('small', {}, 'v' + APP_VERSION)),
      el('nav', { class: 'nav' },
        el('a', { href: '#home', class: view === 'home' ? 'active' : '' }, 'Accueil'),
        el('a', { href: '#editor', class: view === 'editor' ? 'active' : '' }, 'Éditeur'),
        el('a', { href: '#player', class: view === 'player' ? 'active' : '' }, 'Jouer'),
        el('a', { href: '#results', class: view === 'results' ? 'active' : '' }, 'Résultats')
      ),
      el('div', { class: 'status' },
        el('span', { class: 'status-dot' }),
        el('span', { class: 'status-label' }, 'Sauvegardé')
      )
    );
    this.root.appendChild(topbar);

    if (view === 'home') {
      const v = el('div', { class: 'view-home' });
      this.root.appendChild(v);
      this._renderHome(v);
    } else if (view === 'editor') {
      const v = el('div', { class: 'view-editor' });
      this.root.appendChild(v);
      Editor.mount(v);
    } else if (view === 'results') {
      const v = el('div', { class: 'view-results' });
      this.root.appendChild(v);
      Results.mount(v);
    } else if (view === 'player' || view === 'test') {
      const v = el('div', { class: 'view-player' });
      this.root.appendChild(v);
      Player.mount(v, { test: view === 'test' });
    } else {
      location.hash = 'home';
      return;
    }

    this.updateStatus();
  },

  async _renderHome(container) {
    const scn = Scenario.current;
    container.innerHTML = '';

    container.appendChild(el('div', { class: 'home-hero' },
      el('h1', {}, 'Un carnet pour ', el('em', {}, 'tracer'), ' des parcours.'),
      el('p', { class: 'subtitle' },
        'Conçois des courses d\'orientation et des escape games outdoor, puis lance-les hors ligne sur le terrain.'),
      el('p', { style: { marginTop: '-24px', marginBottom: '40px', fontSize: '13px' } },
        el('a', {
          href: '#editor',
          onclick: (e) => {
            e.preventDefault();
            location.hash = 'editor';
            setTimeout(() => Tutorial.start(true), 300);
          },
          style: {
            color: 'var(--rust-dark)', textDecoration: 'none',
            fontFamily: 'var(--font-mono)', fontSize: '11px',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            borderBottom: '1px dashed var(--rust)', paddingBottom: '2px'
          }
        }, '→ Prendre en main l\'éditeur en 2 min')
      )
    ));

    // Le scénario courant ne vaut d'être « continué » que s'il contient
    // quelque chose : sur une première visite, la carte « Continuer »
    // proposait de reprendre un parcours vide, et portait le même titre
    // que « Créer ». Les libellés disent l'action, pas un rang : ces
    // quatre entrées ne forment pas une séquence.
    const aDuTravail = scn.nodes.length > 0;
    const actions = el('div', { class: 'home-actions' });

    if (aDuTravail) {
      actions.appendChild(el('button', { class: 'home-card primary', onclick: () => location.hash = 'editor' },
        el('div', { class: 'num' }, 'Reprendre'),
        el('h3', {}, scn.meta.title || 'Scénario courant'),
        el('p', {}, `${compte(scn.nodes.length, 'nœud')}, ${compte(scn.links.length, 'lien')} · modifié le ${formatDate(scn.updatedAt)}`)
      ));
    }

    actions.appendChild(el('button', {
      class: 'home-card' + (aDuTravail ? '' : ' primary'),
      onclick: async () => {
        if (Storage.save) Storage.save();
        const blank = Scenario.blank();
        Scenario.load(blank);
        await Library.put(blank);
        Storage.setCurrent(blank.id);
        location.hash = 'editor';
        Toast.ok('Nouveau scénario');
      }
    },
      el('div', { class: 'num' }, 'Créer'),
      el('h3', {}, 'Nouveau parcours'),
      el('p', {}, 'Partir d\'une page blanche, poser le premier jalon.')
    ));

    actions.appendChild(el('button', { class: 'home-card', onclick: () => IO.importZipDialog() },
      el('div', { class: 'num' }, 'Importer'),
      el('h3', {}, 'Ouvrir un ZIP'),
      el('p', {}, 'Reprendre un scénario partagé par un·e coéquipier·ère.')
    ));

    actions.appendChild(el('button', {
      class: 'home-card',
      onclick: () => location.hash = aDuTravail ? 'player' : 'results'
    },
      el('div', { class: 'num' }, aDuTravail ? 'Jouer' : 'Comparer'),
      el('h3', {}, aDuTravail ? 'Lancer une partie' : 'Résultats d\'équipes'),
      el('p', {}, aDuTravail
        ? 'Une équipe, un scénario, une aventure hors ligne.'
        : 'Déposer les fichiers rapportés par les équipes pour les classer.')
    ));

    container.appendChild(actions);

    // Bibliothèque
    const library = await Library.list();
    const libSection = el('div', { class: 'home-recent' });
    libSection.appendChild(el('h2', { class: 'library-title' },
      `Bibliothèque (${library.length})`,
      el('span', { class: 'library-note' }, 'stockée dans ce navigateur')
    ));

    if (library.length === 0) {
      libSection.appendChild(el('p', { style: { fontSize: '13px', color: 'var(--ink-faint)', fontStyle: 'italic', padding: '12px 0' } },
        'Aucun scénario enregistré. Les modifications de l\'éditeur y seront sauvegardées automatiquement.'
      ));
    } else {
      library.forEach(entry => {
        const isCurrent = entry.id === scn.id;
        const row = el('div', { class: 'library-item' + (isCurrent ? ' current' : '') },
          el('div', { class: 'lib-main', onclick: async () => {
            if (isCurrent) { location.hash = 'editor'; return; }
            const full = await Library.get(entry.id);
            if (full) {
              Scenario.load(full);
              Storage.setCurrent(full.id);
              location.hash = 'editor';
            }
          } },
            el('div', { class: 'recent-title' }, entry.title || 'Sans titre'),
            el('div', { class: 'recent-meta' },
              `${compte(entry.nodeCount, 'nœud')} · ${compte(entry.linkCount, 'lien')} · ${compte(entry.assetCount, 'média')} · modifié le ${formatDate(entry.updatedAt || 0)}`,
              isCurrent && el('span', { class: 'chip', style: { marginLeft: '8px', borderColor: 'var(--rust)', color: 'var(--rust-dark)' } }, 'courant')
            )
          ),
          el('div', { class: 'lib-actions' },
            el('button', {
              class: 'btn small ghost',
              title: 'Lancer une partie avec ce scénario',
              onclick: async (e) => {
                e.stopPropagation();
                // Sur le téléphone d'un joueur, passer par l'éditeur pour
                // lancer une partie n'a aucun sens.
                if (!isCurrent) {
                  const full = await Library.get(entry.id);
                  if (!full) return;
                  Scenario.load(full);
                  Storage.setCurrent(full.id);
                }
                location.hash = 'player';
              }
            }, '▶ Jouer'),
            el('button', {
              class: 'btn small ghost',
              onclick: async (e) => {
                e.stopPropagation();
                // Permuter Scenario.current le temps de l'export exposait
                // l'autosave debouncé : il pouvait écrire le mauvais scénario.
                const full = await Library.get(entry.id);
                if (full) await IO.exportZip(full);
              }
            }, 'Exporter'),
            !isCurrent && el('button', {
              class: 'btn small ghost danger',
              onclick: async (e) => {
                e.stopPropagation();
                if (await Modal.confirm(`Supprimer « ${entry.title} » de la bibliothèque ?`, {
                  titre: 'Supprimer le scénario', valider: 'Supprimer', danger: true,
                  detail: 'Cette suppression est définitive : pense à exporter le ZIP avant, si tu veux le garder.'
                })) {
                  await AssetStore.removeForScenario(entry.id);
                  await Library.delete(entry.id);
                  this._renderHome(container);
                  Toast.ok('Scénario supprimé');
                }
              }
            }, '✕')
          )
        );
        libSection.appendChild(row);
      });
    }

    container.appendChild(libSection);
  },

  testPlay() {
    location.hash = 'test';
  }
};

// ============================================================
// Démarrage
// ============================================================
function checkDeps() {
  const missing = [];
  if (typeof L === 'undefined')        missing.push('vendor/leaflet.js (carte)');
  if (typeof Drawflow === 'undefined') missing.push('vendor/drawflow.min.js (graphe)');
  if (typeof JSZip === 'undefined')    missing.push('vendor/jszip.min.js (export ZIP)');
  if (typeof jsQR === 'undefined')     missing.push('vendor/jsQR.js (lecture QR)');
  return missing;
}

function showDepsError(missing) {
  document.body.innerHTML = `
    <div style="max-width:560px;margin:80px auto;padding:32px;font-family:'IBM Plex Sans',sans-serif;color:#2a2520;background:#f4ecdf;border:1px solid #c9b896;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,.1)">
      <h1 style="font-family:'Fraunces',serif;font-weight:500;margin:0 0 12px;font-size:28px">Fichiers manquants</h1>
      <p style="color:#5a4f42;margin:0 0 16px">Ces bibliothèques, pourtant livrées avec l'application, n'ont pas pu être chargées&nbsp;:</p>
      <ul style="color:#b0613a;font-family:'IBM Plex Mono',monospace;font-size:13px">
        ${missing.map(m => `<li>${m}</li>`).join('')}
      </ul>
      <p style="color:#5a4f42;font-size:13px;margin-top:20px">
        L'application n'a besoin d'aucun réseau pour démarrer&nbsp;: si ces fichiers manquent,
        c'est que le dossier <code>vendor/</code> n'a pas été déployé, ou que la page est
        ouverte en <code>file://</code> — elle doit être servie en HTTP.
      </p>
    </div>`;
}

window.Parcours = { App, Scenario, Editor, Inspector, Player, PlayerState, IO, Library, Storage,
                    TileCache, AssetStore, Offline, History, Modal, QR, Results, Toast };

function boot() {
  const missing = checkDeps();
  if (missing.length) { showDepsError(missing); return; }
  App.init();
}

// Un module est différé : DOMContentLoaded peut déjà être passé.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

