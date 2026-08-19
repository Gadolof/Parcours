# Parcours

Éditeur et moteur de jeu pour courses d'orientation et escape games outdoor.
Application web autonome : on conçoit un parcours (carte + graphe), on l'exporte
en `.zip`, on le joue sur le terrain.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Balisage minimal : conteneurs et chargement des dépendances |
| `styles.css` | Feuille de style unique — design « carnet de terrain » |
| `src/core.js` | Logique pure : routage du joueur, comparaison des réponses, géométrie, migration des scénarios. **Sans DOM** — c'est ce qui est testé |
| `src/app.js` | Application : éditeur, inspecteur, moteur de jeu, stockage, import/export |
| `sw.js` | Service worker : met l'application en cache pour l'ouvrir sans réseau |
| `manifest.json`, `icons/` | Installation sur l'écran d'accueil |
| `vendor/` | Leaflet, Drawflow, JSZip, jsQR et les polices — **embarqués**, aucun CDN |
| `test/core.test.js` | Tests du noyau |
| `test/browser/` | Suites de bout en bout pilotant Chromium |

`src/app.js` est un module ES : la page doit être servie en HTTP, pas ouverte
en `file://`.

## Tests

```sh
npm test            # noyau — node --test, aucune dépendance à installer
npm run test:browser # bout en bout — nécessite playwright-core et un Chromium
```

Les suites navigateur servent le dépôt tel quel et vérifient notamment que
l'application démarre **hors ligne**, réseau coupé.

## Développement local

```sh
python3 -m http.server 8000
# puis http://127.0.0.1:8000
```

La géolocalisation et la caméra exigent un contexte sécurisé : `localhost` ou HTTPS.

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

## État connu

Voir [`docs/AUDIT.md`](docs/AUDIT.md) pour l'inventaire des constats et la
trajectoire. Jalons 1 et 2 livrés. Restent surtout des manques fonctionnels :
pas de génération des QR codes à imprimer, pas de vérification du parcours
avant export, pas d'annuler/rétablir, et le tracé n'apparaît pas sur la carte.
