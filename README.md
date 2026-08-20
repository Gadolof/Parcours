# Parcours

Éditeur et moteur de jeu pour courses d'orientation et escape games outdoor.
Application web autonome : on conçoit un parcours (carte + graphe), on l'exporte
en `.zip`, on le joue sur le terrain.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Balisage minimal : conteneurs et chargement des dépendances |
| `styles.css` | Feuille de style unique — design « carnet de terrain » |
| `src/core.js` | Logique pure : routage du joueur, analyse du graphe, vérification du parcours, classement, géométrie, migration des scénarios. **Sans DOM** — c'est ce qui est testé |
| `src/app.js` | Application : éditeur, inspecteur, moteur de jeu, stockage, import/export |
| `sw.js` | Service worker : met l'application en cache pour l'ouvrir sans réseau |
| `manifest.json`, `icons/` | Installation sur l'écran d'accueil |
| `vendor/` | Leaflet, Drawflow, JSZip, jsQR, qrcode-generator et les polices — **embarqués**, aucun CDN |
| `test/core.test.js`, `test/graph.test.js` | Tests du noyau |
| `test/browser/` | Suites de bout en bout pilotant Chromium, dont une suite mobile et une suite de charge |

`src/app.js` est un module ES : la page doit être servie en HTTP, pas ouverte
en `file://`.

## Tests

```sh
npm test            # noyau — node --test, aucune dépendance à installer
npm run test:browser # bout en bout — nécessite playwright-core et un Chromium
```

Les suites navigateur servent le dépôt tel quel et vérifient notamment que
l'application démarre **hors ligne** réseau coupé, que les QR produits se
relisent avec le décodeur qu'utilise le joueur, que l'interface tactile tient
sur un écran de 390 px, et qu'un parcours de 120 étapes se reconstruit sous la
seconde.

## Développement local

```sh
python3 -m http.server 8000
# puis http://127.0.0.1:8000
```

La géolocalisation et la caméra exigent un contexte sécurisé : `localhost` ou HTTPS.

## Ce que fait l'éditeur

- **Split-screen carte / graphe.** La carte dit *où*, le graphe dit *dans quel
  ordre*. Le parcours est tracé sur la carte (pointillé pour les branches
  conditionnelles), avec sa longueur.
- **Vérification avant export.** Un panneau liste les anomalies — départ
  manquant, impasse, nœud inatteignable, énigme sans réponse, QR sans valeur,
  flag jamais posé, média orphelin. Chaque ligne mène au nœud fautif.
- **Planche de QR à imprimer.** Une page A4 avec, pour chaque point, le QR, son
  numéro, son titre, le code en clair (pour la saisie manuelle) et ses
  coordonnées. Un bouton tire des codes aléatoires non devinables.
- **Annuler / rétablir** (<kbd>Ctrl</kbd>+<kbd>Z</kbd>).
- **Flags.** Un nœud peut en poser ; un lien peut en tester un ; un
  `checkpoint` peut en exiger, et reste fermé tant qu'ils manquent.

## Ce que fait le moteur de jeu

Validation par QR, code saisi, proximité GPS ou simple confirmation ; réponse
fausse au choix de l'auteur (réessayer sur place ou avancer) ; reprise d'une
partie interrompue ; export des résultats et écran **Résultats** pour comparer
plusieurs équipes et voir où elles ont buté.

## Hors ligne

Toutes les dépendances sont dans `vendor/` : la page ne fait aucune requête
externe au chargement. Le service worker met la coquille en cache, et les
tuiles de carte ont leur propre cache IndexedDB, alimenté depuis l'éditeur
(« Carte hors ligne » → *Pré-cacher cette zone*).

**En déployant, il faut incrémenter `VERSION` dans `sw.js`.** C'est cette
constante qui déclenche la mise à jour du cache chez les personnes ayant déjà
installé l'application ; sans elle, elles continueraient d'utiliser l'ancienne
version. Une bannière leur propose alors de recharger.

## Déploiement

`main` est publié sur GitHub Pages par `.github/workflows/pages.yml`, qui ne
déploie qu'après le passage des tests du noyau.

## Documentation

| Document | Pour qui |
|---|---|
| [`docs/notice.html`](docs/notice.html) | Notice d'utilisation — construire un parcours, le vérifier, l'emporter, en relever les résultats |
| [`docs/presentation.html`](docs/presentation.html) | Présentation d'une page — à quoi sert l'outil et ce qui le distingue |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Inventaire technique des constats et de la trajectoire |

Les deux pages HTML sont autonomes&nbsp;: elles s'ouvrent directement dans un
navigateur et s'impriment proprement. La notice cite les libellés exacts de
l'interface — quand ceux-ci changent, elle change avec eux.

## État connu

Voir [`docs/AUDIT.md`](docs/AUDIT.md) pour l'inventaire des constats et la
trajectoire. Les trois jalons de l'audit sont livrés.

Deux limites à connaître :

- **Le contenu d'un QR doit rester en ASCII.** Un QR accentué s'encode, mais le
  décodeur embarqué le relit vide : le scan ne correspondrait jamais. La
  vérification refuse ces valeurs plutôt que de laisser l'auteur le découvrir
  sur le terrain.
- Les suites navigateur ont montré un échec intermittent (une fois sur dix
  environ, non reproduit) qui ressemble à une contention de ressources. Les
  tests du noyau, eux, sont déterministes.
- Le rebuild de l'éditeur reste le point coûteux sur les gros parcours
  (~250 ms pour 120 étapes) : il diffère désormais le calcul géométrique des
  connexions, mais Drawflow recalcule toujours nœud par nœud.
