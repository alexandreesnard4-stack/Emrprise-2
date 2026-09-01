# SPEC — Rotation de la boutique (24 h, cycle de 8 jours)

Écrit pour Claude Code. À lire en entier avant de toucher au code.
Objectif : la boutique ne montre plus tout le catalogue d'un coup. Elle montre une
sélection qui change toutes les 24 h, sur un cycle de 8 jours, IDENTIQUE POUR TOUS
LES JOUEURS au même instant.

---

## 1. Le principe

- Le temps est découpé en journées de 24 h qui basculent à **00:00 UTC**.
- Une date de référence fixe est posée dans le code :
  `const BOUTIQUE_REFERENCE = Date.UTC(2026, 8, 1);` (1er septembre 2026, 00:00 UTC).
- `jourAbsolu   = Math.floor((Date.now() - BOUTIQUE_REFERENCE) / 86400000)`
- `numeroCycle  = Math.floor(jourAbsolu / 8)`
- `jourDuCycle  = ((jourAbsolu % 8) + 8) % 8`   (0 à 7 ; le modulo double protège
  d'une horloge réglée avant la date de référence)

Aucun tirage aléatoire à l'exécution, aucune écriture en base : la sélection se
CALCULE. Deux joueurs, deux appareils, le même résultat.

## 2. Le générateur déterministe

Un petit générateur pseudo-aléatoire à graine, écrit à la main (aucune dépendance) :

```js
function graineBoutique(n) {
  // mulberry32
  let a = (n >>> 0) + 0x6D2B79F5;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Mélange de Fisher-Yates alimenté par ce générateur :

```js
function melangeDeterministe(liste, graine) {
  const t = [...liste];
  const rnd = graineBoutique(graine);
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}
```

## 3. La répartition sur les 8 jours

Pour UNE famille d'articles (voir §4), avec `quota` articles par jour :

1. `slots = quota * 8` — le nombre total de places sur le cycle.
2. On construit une file en concaténant des mélanges COMPLETS et DISTINCTS du
   catalogue de la famille, jusqu'à atteindre au moins `slots` éléments :
   mélange n°0 avec la graine `numeroCycle * 1000 + familleIndex * 10 + 0`,
   mélange n°1 avec `... + 1`, etc. Puis on tronque à `slots`.
   Chaque article apparaît ainsi un nombre de fois presque égal — c'est ce qui
   garantit que rien n'est jamais oublié pendant un cycle entier.
3. On découpe la file en 8 tranches consécutives de `quota` éléments.
   La tranche d'indice `jourDuCycle` est la sélection du jour.
4. **Correction des doublons** : si une tranche contient deux fois le même article
   (ça n'arrive qu'à la jointure entre deux mélanges), on échange le second avec
   un article de la tranche suivante qui n'est pas déjà dans la tranche courante.
   Faire cette correction sur les 8 tranches, dans l'ordre, avant de choisir celle
   du jour — sinon deux appareils pourraient corriger différemment.

Ce calcul est fait UNE fois par rendu (ou mémoïsé sur `jourAbsolu`), jamais dans
une boucle de rendu.

## 4. Les familles et leurs quotas

`familleIndex` sert de décalage de graine, il doit rester stable dans le temps :
ne jamais réordonner cette liste.

| # | Famille | Catalogue retenu | Quota/jour | Stock actuel |
|---|---------|------------------|-----------|--------------|
| 0 | Plateaux | PLATEAUX avec `prix > 0` | 2 | 8 |
| 1 | Dos en pièces | DOS_CARTES avec `prix > 0` | 4 | 19 |
| 2 | Dos en gemmes | DOS_CARTES avec `prixGemmes` | 2 | 8 |
| 3 | Bannières pas chères | BANNIERES `source: "pieces"` et `prix <= 2000` | 2 | 7 |
| 4 | Bannières chères | BANNIERES `source: "pieces"` et `prix > 2000` | 2 | 8 |
| 5 | Bannières en gemmes | BANNIERES avec `prixGemmes` | 2 | 8 |

Les seuils de prix ne doivent PAS être écrits en dur article par article : ils se
lisent sur les entrées. Un article ajouté au catalogue entre donc dans la rotation
tout seul, sans toucher à ce code.

Rayons **hors rotation**, inchangés : les packs de gemmes, Le Changeur, et le rayon
Hérauts (un Héraut se gagne en terminant son chapitre, il n'a rien à faire dans un
tirage). Les médaillons ne sont plus en boutique.

## 5. Ce que voit le joueur

- Les rayons gardent leur forme actuelle ; seul leur CONTENU se réduit à la
  sélection du jour. Les deux rayons de bannières en pièces (pas chères / chères)
  peuvent rester un seul rayon "Bannières" affichant les 4 du jour.
- Un article déjà possédé qui sort en rotation reste affiché, marqué comme
  aujourd'hui (Acquis / Choisi) — la boutique est la même pour tout le monde.
- **Un article hors sélection du jour n'est pas achetable.** Vérifier que le
  chemin d'achat refuse un article absent de la sélection : sans ça, la rotation
  n'est qu'un décor.
- En tête de boutique, un minuteur : « Nouvelle sélection dans 6 h 12 min ».
  Il se met à jour à la minute, pas à la seconde (une seconde de plus, un rendu
  de plus, pour rien). Il se calcule sur le prochain 00:00 UTC.

## 6. Ce qu'il ne faut surtout pas faire

- Ne pas tirer au sort à l'exécution ni stocker la sélection du joueur : deux
  appareils du même joueur verraient deux boutiques.
- Ne pas se servir de l'heure LOCALE pour la bascule — seulement UTC.
- Ne pas exclure les articles possédés du tirage : la sélection doit être la même
  pour tous, sinon un joueur qui possède beaucoup verrait une boutique différente.
- Ne pas toucher aux prix ni aux catalogues.
- CSS dans APP_STYLES : AUCUN accent grave. Animations : transform et opacity
  uniquement. Ne pas toucher au transform ni à la color des pastilles `.rank`.

## 7. Validations avant de conclure

1. Le build passe ; recherche d'accent grave dans APP_STYLES : zéro.
2. Écrire un petit script de contrôle (dans outils-equilibrage/, pas dans l'app)
   qui simule 3 cycles complets et affiche, pour chaque famille :
   - le nombre d'articles par jour (doit être exactement le quota),
   - aucun doublon à l'intérieur d'un même jour,
   - le nombre de passages de chaque article sur un cycle (écart maximum de 1
     entre le plus vu et le moins vu),
   - que chaque article du catalogue passe AU MOINS une fois par cycle.
3. Vérifier à la main que `jourDuCycle` change bien quand on avance l'horloge de
   24 h, et que la sélection change avec lui.
4. Vérifier qu'un article absent de la sélection ne peut pas être acheté.
5. Le minuteur affiche un temps cohérent avec le prochain 00:00 UTC.
