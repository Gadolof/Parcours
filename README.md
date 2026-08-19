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
| `test/core.test.js` | Tests du noyau |

`src/app.js` est un module ES : la page doit être servie en HTTP, pas ouverte
en `file://`.

## Tests

```sh
npm test        # node --test, aucune dépendance à installer
```

## Développement local

```sh
python3 -m http.server 8000
# puis http://127.0.0.1:8000
```

La géolocalisation et la caméra exigent un contexte sécurisé : `localhost` ou HTTPS.

## Déploiement

`main` est publié sur GitHub Pages par `.github/workflows/pages.yml`, qui ne
déploie qu'après le passage des tests.

## État connu

Voir [`docs/AUDIT.md`](docs/AUDIT.md) pour l'inventaire des constats et la
trajectoire prévue. Le point ouvert le plus important : **le jeu hors ligne
n'est pas encore réel** — les dépendances viennent de CDN et il n'y a ni service
worker ni manifest, donc l'application ne s'ouvre pas sans réseau.
