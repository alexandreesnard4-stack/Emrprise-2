# Le Panthéon — travail à donner au chantier du serveur multijoueur

L'écran du Panthéon (classement des 100 premiers Commandants de la Légende) existe
déjà dans le client. Il lit **un seul document**, `classement/top100`, d'un `getDoc`
à chaque ouverture — jamais d'écoute, jamais de requête sur la collection des
joueurs. Tant que ce document n'existe pas, l'écran affiche son état vide
(« La Légende attend ses premiers noms. ») et vit très bien ainsi.

Ce fichier décrit ce que le serveur devra faire pour le remplir.

## Ce que le serveur écrit

Toutes les **15 à 30 minutes** (une fonction planifiée suffit, Cloud Scheduler +
Cloud Function par exemple) :

1. Interroger la collection `users` avec le SDK **admin** :
   `where("trophees", ">=", 2500).orderBy("trophees", "desc").limit(100)`.
   Le seuil de 2500 est celui de la ligue Légende (`LEAGUES`, dernier échelon).
2. Réécrire entièrement le document `classement/top100` :

```json
{
  "maj": "<serverTimestamp>",
  "lignes": [
    {
      "uid": "<uid du Commandant>",
      "pseudo": "<son pseudo>",
      "trophees": 2870,
      "ordre": "<clé de son Ordre le plus joué, ex. maudits>",
      "titre": "<son titre de style, ex. L'Or Corrompu, sinon chaîne vide>"
    }
  ]
}
```

- Au plus **100 entrées**, déjà triées par trophées décroissants — le client
  affiche dans l'ordre du tableau, il ne retrie pas.
- `ordre` et `titre` viennent des données de profil que le serveur possède.
  S'il ne les connaît pas encore, les laisser vides : le client affiche alors
  un médaillon neutre et pas de ligne de titre.
- Le client tronque de toute façon à 100 lignes et repasse chaque pseudo par
  son filtre de noms : le serveur n'a pas besoin de filtrer, mais rien ne
  l'empêche de le faire aussi.

## La règle Firestore

Déjà posée dans `firestore.rules` (section « Le Panthéon »), **à publier** :

```
match /classement/{document} {
  allow get: if connecte();
  allow list: if false;
  allow write: if false;
}
```

Lecture pour tout joueur authentifié, écriture pour **personne** côté client.
Le serveur passe par le SDK admin, qui ignore ces règles — c'est précisément
pour cela qu'aucune écriture client n'est ouverte : un classement modifiable
par un client est un classement falsifiable.

Tant que la règle n'est pas publiée, la lecture est refusée et l'écran affiche
« Le Panthéon est momentanément hors d'atteinte » : publier la règle suffit à
faire apparaître l'état vide, sans redéployer le jeu.

## Rappel anti-triche

Aujourd'hui les trophées sont écrits par le client dans son propre document
`users/{uid}` : n'importe qui peut donc s'inventer 9999 trophées et, dès que le
serveur remplira le document, trôner au sommet du Panthéon. Le classement ne
vaudra que ce que valent les trophées : leur attribution devra passer **côté
serveur** (au même titre que le `isValidMove` déjà prévu au chantier), le client
perdant le droit d'écrire `trophees` dans les règles à ce moment-là.

## Budget de lectures

- Client : **1 lecture** par ouverture de l'écran, quel que soit le nombre de
  Commandants classés. Cent consultations = cent lectures, pas dix mille.
- Serveur : 100 lectures par rafraîchissement, soit ~4 800 à 9 600 par jour
  selon la cadence — sur le quota admin, pas celui des clients.
