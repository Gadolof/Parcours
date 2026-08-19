# Parcours — audit technique et axes d'amélioration

> Revue complète de `index.html` (5 612 lignes : CSS + SPA vanilla JS) à l'état du commit `0fbb3e2`.
>
> **Mise à jour — jalons 1 et 2 livrés.** Les constats B1 à B7 sont corrigés, le code est
> découpé (`styles.css`, `src/core.js`, `src/app.js`) et le noyau est couvert par
> 43 tests. La vérification en navigateur qui a suivi a invalidé la prémisse de B4
> (voir ci-dessous) et fait apparaître trois défauts d'affichage que la lecture
> statique n'avait pas vus : ils sont ajoutés en §01 bis et corrigés.
>
> Le jalon 2 rend la promesse hors ligne réelle : dépendances embarquées,
> service worker, manifest, médias en Blob, index sur les tuiles. Vérifié
> réseau coupé — 46 contrôles de bout en bout dans Chromium, en plus des
> 43 tests du noyau.

---

## 0. Ce que le projet fait bien

Avant les critiques, ce qui est solide et mérite d'être conservé tel quel :

- **L'idée produit est juste.** Éditeur split-screen carte / graphe, avec l'axiome « la carte dit *où*, le graphe dit *dans quel ordre* ». C'est la bonne abstraction pour une course d'orientation scénarisée, et elle est tenue de bout en bout.
- **Le modèle de données est propre.** `Scenario` = `{meta, nodes, links, assets}` avec un bus d'événements minimal (`on`/`emit`). Les mutations passent toutes par des méthodes (`addNode`, `addLink`, `updateMeta`…) qui appellent `touch()`. C'est une base saine sur laquelle greffer undo/redo et validation.
- **Le design « carnet de terrain »** est cohérent, assumé, et pas générique. Les tokens CSS sont bien nommés et centralisés.
- **Le tutoriel intégré** avec spotlight `clip-path` est une vraie attention portée à l'onboarding — rare dans un projet perso.
- **Les fallbacks joueur** (GPS refusé → saisie manuelle, caméra indispo → saisie manuelle du QR, messages d'erreur GPS différenciés par `err.code`) montrent que le terrain a été anticipé.
- **Le cache de tuiles par provider** avec migration des scénarios pré-multi-providers est un détail de maturité.

Le problème n'est donc pas la conception : c'est qu'il manque le passage au banc d'essai. Ce qui suit est ce que ce passage aurait révélé.

---

## 1. Bugs bloquants (à corriger avant toute autre chose)

### B1 — Importer un ZIP depuis l'accueil échoue avec un message mensonger

**Chemin :** accueil → carte « 03 — Importer » → choisir un `.zip`.

`App.render()` détruit la carte de l'éditeur en quittant la vue (`Editor.map.remove(); Editor.map = null;`), **mais le listener enregistré dans `Editor.mount()` reste abonné à `Scenario`**. Donc :

```
IO.importZip()
  → Scenario.load(json)
      → emit('load')
          → listener Editor → this.rebuild()
              → this.drawflow.clear()      // drawflow null si l'éditeur n'a jamais été monté
              → this.map.setView(...)      // this.map === null  → TypeError
  → catch → Toast.error("ZIP illisible ou corrompu")
```

Le scénario **est** chargé, mais l'utilisateur lit « ZIP illisible ou corrompu » et reste sur l'accueil, dont la liste n'est même pas rafraîchie. Le parcours d'usage numéro 3 de la page d'accueil est cassé, et il l'est d'une façon qui pousse à croire que le fichier est en cause.

**Correctif :** `Editor.mount()` doit conserver la fonction de désabonnement retournée par `Scenario.on()` et l'appeler dans un `Editor.unmount()` invoqué par `App.render()`. Et `rebuild()` doit sortir tôt si `!this.map`.

### B2 — Impossible de taper dans l'inspecteur : le focus est perdu à chaque caractère

`FormBuilder._renderField` appelle `onChange` sur **chaque `input`**. Or dans `Inspector.renderNodeTab()` :

```js
const onChange = () => { …; this._updateHeaderOnly(); };   // → this.render()
```

et `_updateHeaderOnly()` fait un `render()` complet, qui commence par `this.root.innerHTML = ''`. L'`<input>` en cours de saisie est détruit après **la première lettre**. Idem dans `renderScenarioTab()` où `onChange = () => { this.render(); }`.

Concrètement : renommer un nœud ou saisir le pitch du scénario est impossible sans recliquer dans le champ à chaque lettre. C'est le premier geste que fait n'importe quel utilisateur.

**Correctif :** ne re-rendre que ce qui dépend de la valeur. Mettre à jour le `<h2>` de l'en-tête via `textContent` (le nœud DOM est déjà connu), et réserver `render()` aux changements de structure (type de validation, ajout/suppression de lien, sélection d'un média). Un `onStructuralChange` distinct de `onValueChange` dans le schéma de `FormBuilder` suffit.

### B3 — Fuite de listeners à chaque montage de l'éditeur

Corollaire de B1 : chaque aller-retour accueil ↔ éditeur ajoute un abonné à `Scenario.listeners`. Après cinq navigations, un `load` déclenche cinq `rebuild()` successifs — reconstruction complète de la carte et du graphe, cinq fois. Même chose pour les compteurs `_updateCounts()`, qui plantent (`$('#map-count')` → `null`) si un événement arrive alors qu'on n'est plus dans l'éditeur.

### B4 — La suppression au clavier ne fonctionnait pas du tout

> **Correction du constat initial.** J'avais écrit que <kbd>Suppr</kbd> supprimait le
> nœud du graphe sans le retirer du scénario. La vérification dans Chromium montre
> autre chose : Drawflow attache son handler `keydown` à **son conteneur**
> (`container.addEventListener('keydown', …)`), pas au document. Or `#graph`
> n'avait pas de `tabindex` : il ne pouvait jamais recevoir le focus, donc la touche
> n'atteignait jamais Drawflow. Le geste enseigné par le tutoriel *et* par la
> palette — « clique sur le lien, puis <kbd>Suppr</kbd> » — était **inerte**.
> Drawflow ignore par ailleurs déjà la touche quand la saisie vient d'un `INPUT`
> ou d'un `TEXTAREA`, donc le risque d'effacement accidentel n'existait pas non plus.
>
> Le correctif rend `#graph` focusable (et lui donne le focus au clic), ce qui fait
> enfin marcher le geste documenté — et c'est *à partir de là* que la désynchronisation
> décrite ci-dessous devient réelle. Le câblage `nodeRemoved` → suppression dans le
> scénario est donc nécessaire, mais pour une raison différente de celle annoncée.

Le handler `nodeRemoved` du projet ne tirait les conséquences d'une suppression qu'à moitié :

```js
this.drawflow.on('nodeRemoved', dfId => {
  const nodeId = this.nodeIdByDrawflowId[dfId];
  if (nodeId) {
    delete this.drawflowIdByNodeId[nodeId];
    delete this.nodeIdByDrawflowId[dfId];
    // On ne supprime pas dans Scenario …
  }
});
```

Le nœud disparaît du graphe mais **reste dans `Scenario.nodes`**, reste sur la carte, reste source/cible de liens — et réapparaît au prochain `rebuild()`. Le commentaire dans le code montre que l'hésitation était identifiée mais non tranchée.

**Correctif :** router ce handler vers `Editor.removeNode(nodeId)` (avec un garde de réentrance), ou désactiver le raccourci clavier de Drawflow pour les nœuds et n'autoriser la suppression que depuis l'inspecteur.

### B5 — Les *flags* sont une fonctionnalité morte

`_completeNode(answer, correct, flagsToSet = [])` accepte des flags, `_pickNextNode()` sait les évaluer, `PlayerState` les persiste, l'export les inclut. Mais **aucun des onze appels à `_completeNode` ne passe le troisième argument**. Aucune UI ne pose de flag. La condition « si un flag est actif » proposée dans l'éditeur de condition ne peut donc **jamais** être vraie : le lien correspondant est un cul-de-sac garanti.

**Correctif :** soit exposer « poser un flag » dans l'inspecteur du nœud (case à cocher « à la complétion, poser le flag *X* »), soit retirer l'option de la boîte de dialogue tant qu'elle n'est pas implémentée. La laisser visible est un piège pour l'auteur du parcours.

### B6 — Une mauvaise réponse fait avancer comme une bonne

Dans `_buildEnigmeUI` et `_buildCodeUI`, une réponse fausse déclenche `_completeNode(val, false)` : le joueur passe au nœud suivant. **Il n'y a aucune possibilité de réessayer.** Deux conséquences sur le terrain :

- si l'auteur n'a mis qu'un lien inconditionnel, se tromper n'a strictement aucune conséquence — l'énigme est décorative ;
- si l'auteur n'a mis qu'un lien « si correct », `_pickNextNode()` ne trouve rien et **la partie se termine silencieusement** sur une mauvaise réponse. Une équipe se retrouve sur l'écran de fin au milieu du parc.

C'est le défaut le plus coûteux en conditions réelles.

**Correctif :** distinguer trois comportements par nœud (choix de l'auteur) : *réessayer sur place* (défaut), *avancer quand même*, *router selon correct/incorrect*. Et dans `_pickNextNode()`, ne jamais terminer la partie sur une absence de correspondance — retomber sur le premier lien disponible et journaliser l'anomalie.

### B7 — Ouvrir l'onglet Nœud crée une position fantôme

```js
if (!node.position) node.position = { lat: null, lng: null };
```

Ce simple affichage de l'inspecteur mute le nœud. `node.position` devient *truthy*, donc `_updateCounts()` — qui fait `filter(n => n.position)` — compte ce nœud comme positionné. Le compteur « Carte » se met à mentir dès qu'on regarde un nœud, et les positions vides partent dans l'export.

**Correctif :** ne pas muter, ou compter `n.position?.lat != null`.

### B8 — Fuite d'URLs blob dans les tuiles

`createCachedTileLayer` fait `URL.createObjectURL(blob)` pour chaque tuile et **ne révoque jamais**. Leaflet détruit les tuiles hors écran, mais les blobs restent référencés : la mémoire croît linéairement avec le panoramique. Une session d'édition d'une heure sur une grande zone peut faire tomber l'onglet mobile.

**Correctif :** `layer.on('tileunload', e => URL.revokeObjectURL(e.tile.src))`.

### B9 — L'export depuis la bibliothèque peut corrompre la sauvegarde

```js
const savedScn = Scenario.current;
Scenario.current = full;      // ← swap
await IO.exportZip();         // ← await, plusieurs centaines de ms
Scenario.current = savedScn;
```

Si l'autosave debouncé (800 ms) se déclenche pendant la fenêtre, `Library.put(Scenario.current)` écrit le **mauvais** scénario et `localStorage[lastId]` pointe ailleurs. Peu probable, pas impossible, et silencieux.

**Correctif :** donner à `exportZip(scenario = Scenario.current)` un paramètre explicite plutôt que de manipuler l'état global.

### B10 — Numérotation des marqueurs incohérente

`_addToMap` calcule le numéro affiché avec `Scenario.current.nodes.indexOf(node) + 1`, c'est-à-dire la position dans le tableau. Après une suppression, tous les marqueurs suivants portent un numéro faux jusqu'au prochain `rebuild()`. Et surtout, ce numéro **ne correspond pas à l'ordre de parcours** — il ne veut rien dire pour l'auteur. Le numéro devrait venir d'un parcours du graphe depuis le nœud de départ (voir §3).

---

## 1 bis. Ce que la lecture du source ne pouvait pas montrer

Trois défauts d'affichage, tous corrigés, qu'une revue statique manque par construction — il fallait ouvrir la page.

### B11 — L'inspecteur était inutilisable sur desktop

`.view-editor` est une grille `200px 1fr 320px`. Ses enfants sont, dans l'ordre :
`.palette`, `.center`, `.inspector-backdrop`, `.inspector`. Le backdrop n'a de
règle **que** dans la media query mobile : sur desktop il restait un élément de
flux normal et s'emparait de la troisième colonne. L'inspecteur basculait alors
à la ligne 2, par-dessus la palette, tronqué et à moitié hors écran — état
reproduit à l'identique sur le commit d'origine, donc présent depuis toujours.

Une déclaration manquait : `.inspector-backdrop { display: none; }` hors mobile.
C'est le défaut le plus visible de tout cet audit, et le moins coûteux à réparer.

### B12 — La bulle du tutoriel sortait de l'écran sur mobile

La media query fixe `left: 16px !important` et une largeur pleine, mais
`_positionBubble()` applique `transform: translate(-50%, -50%)` pour le centrage.
Le `!important` gagnait sur `left`, pas sur le `transform` : la bulle était
décalée d'une demi-largeur vers la gauche et amputée. C'est le tout premier
écran que voit un nouvel utilisateur sur téléphone.

### B13 — Les couches passaient sous la carte

Leaflet place ses panneaux de contrôle à `z-index: 1000`. Or `--z-modal` valait
`900` et l'overlay du tutoriel `950` : l'attribution et les boutons de zoom
passaient **au-dessus** des modales et du tutoriel. L'échelle est réordonnée
au-dessus de 1000 (`--z-modal: 1200`, `--z-tuto: 1300`, `--z-toast: 1400`).

Dans la même famille : la feuille de Drawflow repeint le nœud sélectionné en
rouge vif (`background: red`), ce que la règle du projet ne surchargeait pas —
chaque clic sur un nœud produisait un aplat criard au milieu du carnet.

## 2. Le trou principal : « hors ligne » n'existe pas — *résolu*

> **Livré.** Les quatre bibliothèques et les polices sont désormais dans
> `vendor/`, un service worker précache la coquille (30 entrées), un manifest
> permet l'installation, et `navigator.storage.persist()` est demandé au
> démarrage. Le test de bout en bout coupe le réseau, recharge la page et
> vérifie que l'application démarre, que les quatre bibliothèques sont là,
> que la feuille de style s'applique et que l'éditeur reste utilisable.
>
> Une réserve à retenir : **`VERSION` dans `sw.js` doit être incrémentée à
> chaque déploiement**, sans quoi les installations existantes gardent
> l'ancienne version. Une bannière propose le rechargement quand une mise à
> jour est prête.

Le constat initial :

- il n'y a **ni `manifest.json` ni service worker** ;
- l'application charge **quatre scripts CDN** (Leaflet, Drawflow, JSZip, jsQR), **deux feuilles CSS CDN** et **Google Fonts** ;
- `checkDeps()` remplace la page par un écran d'erreur si l'une manque.

Donc : une équipe qui arrive sur le terrain sans réseau **n'ouvre pas l'application du tout**. Le cache de tuiles, qui est le morceau de code le plus travaillé du projet, ne peut jamais servir dans le seul scénario pour lequel il a été écrit.

**C'est le chantier numéro un.** Le correctif est bien balisé :

1. **Vendorer les dépendances** dans `vendor/` (les quatre libs + les CSS + les `.woff2` des polices). Cela supprime aussi la dépendance à la disponibilité de jsDelivr et le risque d'un `@0.0.60` réécrit côté CDN.
2. **Ajouter un service worker** qui précache l'*app shell* (`index.html`, `vendor/*`) en *cache-first*, avec un numéro de version bumpé au déploiement.
3. **Ajouter un `manifest.json`** (`display: standalone`, icônes, `theme-color` déjà présent en meta) pour l'installation sur l'écran d'accueil — indispensable pour un usage terrain.
4. **Appeler `navigator.storage.persist()`** au premier enregistrement. Sans cela, le navigateur peut évincer IndexedDB sous pression de stockage — précisément le scénario d'un téléphone plein un jour d'événement.
5. **Afficher le quota** (`navigator.storage.estimate()`) à côté des compteurs de tuiles, qui n'indiquent aujourd'hui qu'un nombre — sans lien avec l'espace réellement consommé.

Tant que ce point n'est pas traité, tout le reste est secondaire.

---

## 3. Trous fonctionnels

Classés par rapport valeur / effort décroissant.

### 3.1 Pas de génération de QR codes

L'auteur saisit « contenu du QR attendu », puis… doit sortir de l'application, trouver un générateur en ligne, produire les codes un par un, les imprimer, et espérer n'avoir pas fait de faute de frappe. C'est le maillon manquant le plus flagrant du flux de travail.

**Proposition :** un bouton « Planche de QR à imprimer » qui génère une page A4 (une bibliothèque QR pèse ~10 ko, ou un encodeur maison suffit) avec, pour chaque nœud à validation QR : le code, le titre du nœud, et une marge de découpe. Export PDF via `window.print()` et une feuille de style `@media print`. Bonus : proposer des valeurs de QR aléatoires non devinables plutôt que laisser l'auteur écrire « eglise ».

### 3.2 Pas de vérification du parcours avant export

Rien n'empêche d'exporter un scénario cassé, et l'auteur ne le découvre que sur le terrain. Un panneau « Vérifier » listant les anomalies serait peu coûteux et très rentable :

- nœud de départ non défini ou pointant vers un nœud supprimé ;
- nœuds **inatteignables** depuis le départ (parcours en profondeur sur `links`) ;
- **impasses** : nœud non-outro sans lien sortant ;
- énigme sans réponse, validation `qr`/`code` sans valeur attendue ;
- nœud `etape`/`checkpoint` sans position alors que sa validation est `gps` ;
- lien conditionnel « si flag » (cf. B5) ou branche `si correct` sans branche `si incorrect` ;
- assets référencés manquants, assets orphelins (poids mort dans le ZIP).

Chaque anomalie cliquable pour sélectionner le nœud fautif.

### 3.3 Pas d'annuler / rétablir

Pour un éditeur, c'est une lacune structurelle. Le modèle s'y prête bien : toutes les mutations passent par `Scenario`. Un historique de patchs (ou de snapshots JSON pour commencer — les scénarios sont petits hors assets) branché sur `touch()`, avec <kbd>Ctrl</kbd>+<kbd>Z</kbd>, est un travail d'une demi-journée qui change la sensation de l'outil. Prérequis : sortir les assets du document versionné (§4.1).

### 3.4 `checkpoint` est un type mort

Il existe dans la palette, dans les libellés, dans le CSS — et se comporte exactement comme `etape`. Soit lui donner un sens (par exemple : *ne s'ouvre que si tous les flags/nœuds requis sont acquis*, ce qui fournirait enfin un usage aux flags et permettrait les parcours en étoile où l'ordre est libre), soit le retirer. Le laisser ainsi crée une attente que le moteur ne tient pas.

### 3.5 Le parcours n'est pas visible sur la carte

La carte n'affiche que des marqueurs isolés. Un auteur de course d'orientation veut voir **le tracé** : polylignes entre nœuds liés (pointillé pour les liens conditionnels), distance de chaque segment, longueur totale, et la numérotation dans l'ordre du graphe et non l'ordre du tableau (cf. B10). `_haversine` existe déjà côté joueur ; le calcul est immédiat.

C'est probablement l'amélioration qui rendrait l'éditeur le plus agréable, pour un coût modeste.

### 3.6 Barre de progression trompeuse

`Étape N / scenario.nodes.length`. Avec des branches, le dénominateur est faux par construction : un parcours de 12 nœuds dont 4 sont des variantes affichera « 8 / 12 » à l'arrivée. Et `history.length` compte les revisites. Il faudrait soit le plus court chemin depuis le départ jusqu'à un outro, soit renoncer au dénominateur et n'afficher que le numéro d'étape.

### 3.7 Le joueur n'a ni indice, ni score, ni chronomètre visible

Trois classiques du genre, absents : indice révélable avec pénalité de temps, score, et compte à rebours si `meta.duration` a un sens. `meta.duration` n'est aujourd'hui qu'une décoration sur l'écran de départ.

### 3.8 Rien pour l'organisateur multi-équipes

Le partage WhatsApp est une bonne idée pragmatique. Mais un organisateur avec six équipes n'a aucun moyen d'agréger : pas de classement, pas d'import de plusieurs JSON de résultats, pas de vue comparative. Un écran « Résultats » acceptant N fichiers exportés et produisant un tableau serait un ajout autonome et simple.

### 3.9 On ne peut jouer que le scénario ouvert dans l'éditeur

`Player` lit `Scenario.current`. Pour jouer un scénario de la bibliothèque, il faut d'abord le charger dans l'éditeur. Sur le téléphone d'un joueur, ce détour n'a aucun sens : la bibliothèque devrait proposer « Jouer » directement.

---

## 4. Performance et données

### 4.1 Les assets sont des dataURL réécrits en entier à chaque frappe

`assets[].dataUrl` est une chaîne base64 (**+33 %** de volume), stockée dans le **même** enregistrement IndexedDB que le scénario. Conséquence : `Library.put(Scenario.current)` sérialise et réécrit **l'intégralité des médias** à chaque autosave — c'est-à-dire toutes les 800 ms pendant la frappe, et **à chaque déplacement de la carte** (voir 4.2). Avec 20 Mo de photos, l'éditeur devient inutilisable.

**Correctif :** un object store `assets` séparé, contenant des `Blob` (IndexedDB les gère nativement, sans base64), le scénario ne conservant que les identifiants. Les `dataUrl` sont alors résolus en `URL.createObjectURL()` à l'affichage (et révoqués). Gain : volume, vitesse d'écriture, et undo/redo devient envisageable.

### 4.2 Chaque panoramique de carte écrit le scénario complet

```js
this.map.on('moveend zoomend', () => {
  Scenario.updateMeta({ area: { center: [...], zoom: ... } });
});
```

`updateMeta` → `touch()` → `markDirty()` → autosave. Déplacer la carte dix fois = dix réécritures complètes. Par ailleurs `rebuild()` fait `map.setView(...)`, qui redéclenche `moveend` — l'événement se rejoue à chaque reconstruction.

**Correctif :** ne persister la zone qu'en sortie d'éditeur ou avec un debounce long dédié, et ne pas marquer le document *sale* pour un simple déplacement de vue.

### 4.3 Compter les tuiles charge tous les blobs en mémoire

```js
async countFor(provider) {
  const all = await IDB.getAll('tiles');           // ← tous les blobs
  return all.filter(t => t.key?.startsWith(provider + '/')).length;
}
```

Idem dans `clearProvider`. Avec 5 000 tuiles à ~20 ko, c'est **100 Mo** chargés pour obtenir un entier — et cet appel est déclenché à chaque rendu de l'onglet Scénario.

**Correctif :** créer un index sur `provider` (`store.createIndex('provider','provider')`) et utiliser `index.count(provider)` / un curseur pour la suppression. Ou compter via `IDBKeyRange.bound(provider+'/', provider+'/￿')` sur la clé primaire.

Note : cela impose de passer `DB_VERSION` à `2` et d'écrire le `onupgradeneeded` correspondant — le wrapper actuel est figé en v1 sans stratégie de migration.

### 4.4 Le précache est séquentiel

Une tuile à la fois, `await` du `fetch` **puis** 120 ms de pause. Pour 3 000 tuiles : plus de six minutes de plancher incompressible, écran modal bloqué, et un simple verrouillage du téléphone interrompt tout. Un pool de 3–4 requêtes concurrentes avec le même throttle global respecte tout autant les fournisseurs de tuiles et divise le temps par trois ou quatre.

À noter aussi : `precache` ne vérifie pas le quota disponible et ne reprend pas après interruption.

### 4.5 Le scan QR tourne à pleine résolution

`scan()` est appelé à chaque `requestAnimationFrame`, dessine la vidéo **en résolution native** (souvent 1920×1080) dans un canvas, puis passe ~2 M de pixels à `jsQR`. Sur un téléphone, au soleil, c'est 60 fps de traitement d'image inutile : ça chauffe et ça vide la batterie — pendant une activité où la batterie est la ressource critique.

**Correctif :** limiter à ~10 analyses par seconde, et réduire à une largeur de 400–500 px (jsQR détecte très bien à cette taille). Ajouter aussi la torche (`track.applyConstraints({advanced:[{torch:true}]})`) pour les QR en intérieur sombre.

### 4.6 Comparaisons de QR incohérentes

Le scan compare `code.data === expected` sans normalisation, la saisie manuelle compare `val === expected.trim()`, tandis que codes et énigmes passent par `_normalize()` (casse, accents, espaces). Trois règles différentes pour la même intention. Un espace en fin de valeur saisie dans l'éditeur, et le QR ne valide jamais.

---

## 5. Robustesse et sécurité

### 5.1 Aucune validation du ZIP importé

`Scenario.load(json)` accepte n'importe quelle structure. Un `scenario.json` sans `nodes` fait planter l'éditeur ; sans `meta`, les accès `meta.title` explosent ; un `version` futur est ignoré silencieusement. Comme un ZIP est **fait pour circuler entre personnes**, c'est aussi une surface d'attaque.

**Correctif :** un `validateScenario(json)` qui vérifie les champs obligatoires, coerce les types, filtre les liens pointant vers des nœuds inexistants, borne les tailles, et refuse proprement avec un message utile. Et honorer `version` avec une chaîne de migrations explicite plutôt que les deux `if` ad hoc actuels dans `load()`.

### 5.2 Injection HTML via `node.type`

```js
const html = `
  <div class="node-type">${({etape:'Étape',…})[node.type] || node.type}</div>
  …`;
this.drawflow.addNode(node.type, …, `type-${node.type}`, …, html);
```

`node.title` est correctement échappé par `_escape`, mais **`node.type` ne l'est pas** — ni dans le corps HTML, ni dans l'attribut `class`. Un scénario importé avec `"type": "<img src=x onerror=…>"` exécute du script dans le contexte de l'application, avec accès à IndexedDB, à la caméra et à la géolocalisation déjà autorisées.

**Correctif :** valider `node.type` contre la liste blanche des cinq types connus à l'import (ce que ferait 5.1), et échapper de toute façon.

### 5.3 Pas de SRI sur les CDN

Les quatre `<script src="…cdn…">` n'ont ni `integrity` ni `crossorigin`. `cdn.jsdelivr.net/gh/jerosoler/Drawflow@0.0.60/` sert depuis un tag Git, qui peut être déplacé. Le vendoring recommandé au §2 règle le problème à la racine ; en attendant, ajouter les hachages est gratuit.

Dans la même veine : aucune `Content-Security-Policy`. Une CSP stricte (`default-src 'self'`) devient possible une fois les dépendances vendorées et le CSS/JS sortis des balises inline.

### 5.4 `beforeunload` ne sauvegarde rien

```js
window.addEventListener('beforeunload', () => {
  // Best-effort : sauvegarde synchrone impossible avec IDB, on se repose sur le debounce
});
```

Un handler vide. Avec un debounce de 800 ms, fermer l'onglet juste après une modification la perd. Il est certes impossible d'écrire dans IndexedDB de façon synchrone — mais on peut : (a) déclencher `Storage.save.flush()` sur `visibilitychange`, ce qui est le point d'accroche fiable sur mobile ; (b) retourner une chaîne dans `beforeunload` si `App.dirty` pour au moins prévenir l'utilisateur.

### 5.5 Le déploiement publie tout le dépôt

`upload-pages-artifact` avec `path: .` embarque `.git` exclus mais aussi `.github/` et tout futur fichier de travail. Restreindre à un dossier de sortie (ou lister explicitement) évite les surprises quand le projet grossira.

---

## 6. Accessibilité et confort mobile

- **`maximum-scale=1, user-scalable=no`** *(corrigé)* dans le viewport : le zoom par pincement est désactivé sur toute l'application. Sur une application de terrain, avec une carte, potentiellement pour des utilisateurs presbytes, c'est doublement pénalisant — et c'est ignoré par Safari iOS depuis longtemps, donc le bénéfice escompté n'existe même pas. À retirer ; le `font-size: 16px` déjà présent sur les inputs suffit à empêcher le zoom automatique iOS.
- **Contrastes insuffisants.** *(corrigé)* `--ink-faint` (#8a7f70) sur `--paper` (#f4ecdf) donnait **3,35:1**, `--rust` **3,88:1** — sous le seuil WCAG AA de 4,5:1. Or ces couleurs portent presque toutes les métadonnées, à 10–12 px. `--ink-faint` passe à `#615748` (6,04 / 5,47 / 4,84 sur les trois fonds papier) et un token dédié `--rust-text: #8d4926` (5,75 / 5,21 / 4,61) prend le petit texte accentué ; `--rust` reste l'accent de marque pour les aplats et les grands italiques, où le seuil est de 3:1.
- **`confirm()` et `alert()` natifs** pour toutes les confirmations destructrices (suppression de nœud, de lien, d'asset, vidage du cache, reset). Cela casse le design, bloque le thread, et est ignoré dans certains contextes embarqués. `Modal` existe déjà : il suffit d'y ajouter un `Modal.confirm()`.
- **Modales sans piège de focus, sans <kbd>Échap</kbd>, sans `role="dialog"` / `aria-modal`.** Navigation au clavier impossible.
- **`#app { height: 100vh }`** alors que les media queries mobiles utilisent `100dvh`. Sur iOS/Android avec barre d'outils rétractable, le fond de l'éditeur passe sous la chrome du navigateur. Uniformiser sur `100dvh` avec repli `100vh`.
- **Pas de gestion du clavier virtuel** : sur l'écran joueur, le champ de réponse peut être masqué par le clavier (`visualViewport` non écouté).
- **Aucune annonce ARIA sur les toasts** (`role="status"` / `aria-live="polite"` manquants) : les messages de succès et d'erreur sont invisibles pour un lecteur d'écran.
- **Le tutoriel n'est pas interruptible au clavier** et son `clip-path` n'est pas recalculé au défilement (seulement au `resize`).

---

## 7. Architecture et outillage

**État :** un fichier de 5 612 lignes, ~1 950 de HTML/CSS et ~3 500 de JavaScript, **zéro test, zéro build, zéro linter**. Cela a permis d'aller vite — c'est le bon choix pour un prototype — mais c'est aujourd'hui le facteur limitant : impossible de refactorer les points ci-dessus en confiance.

**Trajectoire proposée, par ordre de coût croissant :**

1. **Extraire CSS et JS** en `styles.css` et `app.js`. Coût nul, bénéfice immédiat sur la lisibilité des diffs Git — aujourd'hui, tout changement touche le même fichier de 180 ko.
2. **Passer en modules ES** (`<script type="module">`) et découper selon les frontières déjà présentes dans les bandeaux de commentaires : `idb.js`, `tiles.js`, `scenario.js`, `editor.js`, `player.js`, `io.js`, `ui.js`. Les objets sont déjà des singletons bien séparés ; le découpage est presque mécanique. Attention aux quelques dépendances circulaires implicites (`Scenario` ↔ `App`, `Editor` ↔ `Inspector`) — à casser via le bus d'événements existant.
3. **Ajouter un bundle esbuild** (une ligne de commande) produisant `dist/` avec les dépendances vendorées inlinées. C'est ce qui rend le service worker du §2 sain.
4. **Tester le noyau** — le code le plus critique est aussi le plus facile à tester, car pur : `_pickNextNode`, `_normalize`, `_haversine`, `TileCache.estimate`, `_latLngToTile`, le futur `validateScenario`, et les migrations. Vitest + une trentaine de cas couvrent l'essentiel des bugs de logique de branchement.
5. **Une action GitHub `lint + test`** en garde-fou avant le déploiement Pages, qui aujourd'hui publie sans aucun contrôle.

---

## 8. Ordre de bataille suggéré

**Jalon 1 — « ça marche vraiment » (quelques jours)**
B1 (import cassé), B2 (focus dans l'inspecteur), B3 (fuite de listeners), B4 (désync Suppr), B6 (mauvaise réponse), B7 (position fantôme). Puis extraire CSS/JS et écrire les premiers tests sur `_pickNextNode`.
*Sans ces correctifs, toute session de test utilisateur se heurtera au mur avant d'atteindre le contenu.*

**Jalon 2 — « ça marche sur le terrain » (une à deux semaines)**
Vendoring + service worker + manifest + `storage.persist()` (§2). Blobs au lieu de dataURL (4.1). Throttle du `moveend` (4.2). Index sur les tuiles (4.3). Révocation des object URLs (B8). Optimisation du scan QR (4.5). Correction des contrastes et retrait de `user-scalable=no` (§6).
*C'est ce jalon qui rend la promesse produit réelle.*

**Jalon 3 — « ça fait gagner du temps à l'auteur » (à la carte)**
Génération des planches de QR (3.1), panneau de vérification (3.2), tracé et distances sur la carte (3.5), annuler/rétablir (3.3). Puis trancher le sort des flags et de `checkpoint` (B5, 3.4), et l'agrégation multi-équipes (3.8).

---

## 9. Récapitulatif

| # | Point | Gravité | Effort | État |
|---|-------|---------|--------|------|
| B1 | Import ZIP depuis l'accueil cassé + message trompeur | Bloquant | Faible | ✅ corrigé |
| B2 | Perte de focus à chaque frappe dans l'inspecteur | Bloquant | Faible | ✅ corrigé |
| §2 | Aucun support hors ligne réel (ni SW, ni manifest, CDN) | Bloquant | Moyen | ✅ corrigé |
| B6 | Mauvaise réponse = avance, ou fin de partie silencieuse | Élevée | Faible | ✅ corrigé |
| B4 | Désynchronisation graphe/données sur Suppr | Élevée | Faible | ✅ corrigé |
| B3 | Fuite de listeners entre navigations | Élevée | Faible | ✅ corrigé |
| 4.1 | Assets en dataURL réécrits à chaque autosave | Élevée | Moyen | ✅ corrigé |
| B5 | Flags : fonctionnalité morte exposée dans l'UI | Élevée | Faible | ⏳ jalon 3 |
| 4.3 | `getAll('tiles')` pour compter (100 Mo en RAM) | Élevée | Faible | ✅ corrigé |
| 5.1 / 5.2 | ZIP non validé, XSS via `node.type` | Élevée | Moyen | ✅ corrigé |
| 3.1 | Pas de génération de QR codes | Élevée (produit) | Moyen | ⏳ jalon 3 |
| B8 | Object URLs de tuiles jamais révoqués | Moyenne | Faible | ✅ corrigé |
| 4.2 | Autosave complet à chaque panoramique | Moyenne | Faible | ✅ corrigé |
| 4.5 | Scan QR pleine résolution à 60 fps | Moyenne | Faible | ✅ corrigé |
| B7 | Position fantôme créée par l'inspecteur | Moyenne | Faible | ✅ corrigé |
| §6 | Contrastes < AA, zoom désactivé | Moyenne | Faible | ✅ corrigé |
| §6 | `confirm()` natifs, modales sans piège de focus | Moyenne | Faible | ⏳ jalon 3 |
| 3.2 | Pas de vérification du parcours avant export | Moyenne (produit) | Moyen | ⏳ jalon 3 |
| 3.5 | Parcours non tracé sur la carte | Moyenne (produit) | Moyen | ⏳ jalon 3 |
| 3.3 | Pas d'annuler/rétablir | Moyenne (produit) | Moyen | ⏳ jalon 3 |
| B9 | Race à l'export depuis la bibliothèque | Faible | Faible | ✅ corrigé |
| B10 | Numérotation des marqueurs sans signification | Faible | Faible | ⏳ jalon 3 |
| B11 | Inspecteur hors écran sur desktop | Bloquant | Faible | ✅ corrigé |
| B12 | Bulle du tutoriel amputée sur mobile | Élevée | Faible | ✅ corrigé |
| B13 | Modales et tutoriel sous les contrôles Leaflet | Moyenne | Faible | ✅ corrigé |
| §7 | Fichier unique, aucun test, aucun build | Structurelle | Progressif | ◐ découpé, testé |

---

*Audit réalisé par lecture statique intégrale du source, puis vérifié dans Chromium
(dépendances servies localement, 19 contrôles de bout en bout). C'est cette
vérification qui a corrigé B4 et fait apparaître B11 à B13 : la lecture seule ne
voit pas une grille CSS mal peuplée.*
