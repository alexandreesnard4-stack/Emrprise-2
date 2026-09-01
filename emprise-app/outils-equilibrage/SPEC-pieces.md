# SPEC — Les pièces récompensent la manière de jouer

Cible : `src/App.jsx`. Lis le code réel avant d'agir ; les numéros de ligne sont
indicatifs, retrouve tout par ses identifiants.

## Pourquoi

Aujourd'hui les pièces sont un simple multiple de l'XP (`PIECES_PAR_XP = 2`, vers
la ligne 2514, utilisé vers 2053). Les deux monnaies sont donc strictement
corrélées : la pièce ne dit rien de plus que l'XP. On remplace ce lien par un
barème propre, fondé sur la MARGE DE VICTOIRE.

Le barème n'est pas inventé. Il a été calibré sur 2 500 parties jouées par le
moteur réel via `outils-equilibrage`. Mesures retenues :

- l'écart de score final va de 1 à 15 et ne peut JAMAIS être pair (le point du
  premier joueur rend l'égalité impossible) ;
- il vaut 3,92 en moyenne ; 33 % des parties finissent à 1 point, 25,8 % à 3,
  19 % à 5, 12 % à 7, et 10,4 % au-delà ;
- le nombre de captures ne discrimine PAS (10,4 pour le vainqueur contre 8,4 pour
  le perdant, la moitié des parties entre 9 et 12). **Ne l'utilise pas comme
  récompense** : il mesure le nombre de cartes posées, pas le talent.

## 1 — Le barème, dans une seule constante

Remplace `PIECES_PAR_XP` par une constante unique, posée près des autres
constantes d'économie, avec un commentaire (sans accents) expliquant d'où
viennent les valeurs.

    const PIECES_PARTIES = {
      // La marge de victoire : chaque point d'ecart au score final paie, jusqu'a
      // un plafond -- au-dela, l'ecart en dit plus sur la faiblesse d'en face
      // que sur le talent du vainqueur. Valeurs calibrees sur 2500 parties.
      margePlafond: 10,
      classe: {
        baseVictoire: 40,
        parLigue: 20,          // x index de ligue : Bronze 0 -> Legende 4
        parEcart: 5,
        baseDefaite: 12,
        primeDefaiteSerree: 8, // quand l'ecart vaut 1
      },
      echo: {
        baseVictoire: { debutant: 8, intermediaire: 16, avance: 24, expert: 32 },
        parEcart: 2,
        baseDefaite: 8,
        primeDefaiteSerree: 6,
      },
      bonusHistoire: 20,
    };

### Le calcul

- **Victoire classée** : `baseVictoire + parLigue * indexLigue + parEcart *
  min(ecart, margePlafond)`
- **Défaite classée** : `baseDefaite`, plus `primeDefaiteSerree` si l'écart vaut 1
- **Victoire contre un Écho** : `baseVictoire[difficulte] + parEcart *
  min(ecart, margePlafond)`. Difficulté absente : `intermediaire`, comme le fait
  déjà `XP_PARTIES` — on ne plante jamais.
- **Défaite libre** : `baseDefaite`, plus `primeDefaiteSerree` si l'écart vaut 1
- **Histoire** : `bonusHistoire` s'ajoute au total, exactement là où `XP_PARTIES`
  ajoute déjà son `bonusHistoire` à l'XP. Une seule fois.

### Contrôle de cohérence, à faire AVANT de coder

En ligue Bronze, une victoire classée doit tomber entre 45 et 90 pièces, et valoir
environ 60 en moyenne — le montant fixe d'aujourd'hui. Si tu ne retrouves pas cet
ordre de grandeur, ARRÊTE-TOI et dis-le, plutôt que d'ajuster les constantes.

## 2 — L'écart doit arriver jusqu'au calcul

Le versement se fait dans `recordGameStats` (vers 2053 :
`piecesVersees = gain * PIECES_PAR_XP`). Cette fonction ne connaît PAS l'écart de
score aujourd'hui.

- Trouve où le score final des deux camps est calculé en fin de partie (les cartes
  possédées, plus le point du premier joueur) et fais voyager l'ÉCART ABSOLU
  jusqu'à `recordGameStats`, via un nouveau paramètre.
- Ajoute-le à la FIN de la signature, avec une valeur par défaut, pour ne casser
  aucun appel existant. Mets à jour tous les appels et cite-les dans ton rapport.
- Ne recalcule pas le score à ta façon : réutilise la valeur que le jeu affiche
  déjà au joueur. Sinon l'écran de fin et le versement diraient deux choses
  différentes.
- Si l'écart n'est pas disponible (valeur par défaut), verse la base SANS marge
  plutôt que d'inventer un écart.

## 3 — L'XP ne bouge pas

`XP_PARTIES` reste exactement ce qu'il est. Les niveaux de Commandant, les gemmes
des paliers, la Flamme, le Changeur, les prix de la boutique, les quêtes : rien ne
change. Seules les pièces DE PARTIE changent de calcul.

Le commentaire « Les pieces suivent l'XP » (vers 2510) devient faux : réécris-le.

## 4 — L'écran de fin doit expliquer le montant

Un montant variable qu'on ne comprend pas est pire qu'un montant fixe : le joueur
doit voir POURQUOI il touche 90 plutôt que 45.

- Sous la ligne d'XP, ajoute le détail du versement : la base, puis la marge, puis
  la prime de défaite serrée quand elle s'applique. Formulation courte, du genre
  « 40 + 25 de marge ».
- Le repli d'affichage vers `b.gain * PIECES_PAR_XP` (vers 14945) disparaît : la
  valeur affichée est celle réellement versée (`piecesVersees`), jamais un
  recalcul.
- Fondu en opacity seulement, comme le reste de l'écran de fin. Aucune autre
  animation.

## Ce qu'il ne faut pas toucher

- Une partie disqualifiée, le bac à sable, un duel local sans camp, la Confluence
  hors de sa quête : ils ne versent rien aujourd'hui, ils ne versent rien demain.
  Ne touche pas à la porte `compteAuProfil`.
- Le tournoi et `TOURNOI_ENJEU`.
- Les gemmes, sous toutes leurs formes.
- Le `transform` et la `color` des pastilles de rang (`.rank`) : jamais.

## Contraintes techniques

- Fichier unique `src/App.jsx`. Le CSS vit dans la chaîne template `APP_STYLES` :
  AUCUN accent grave à l'intérieur, un seul casse tout le fichier. Commentaires
  sans accents.
- Animations : `transform` et `opacity` uniquement.
- Pas de « pendant que j'y suis » : signale sans toucher.
- Idempotent : une seule constante de barème, un seul endroit de calcul. Cette
  spec doit pouvoir être relancée sans créer de second barème.

## Validations à faire et à rapporter

1. Le fichier compile, aucune erreur de build, et confirmer qu'aucun accent grave
   n'a été introduit dans `APP_STYLES`.
2. Confirmer que `PIECES_PAR_XP` n'existe plus NULLE PART, appels d'affichage
   compris.
3. Citer la nouvelle signature de `recordGameStats` et la liste complète de ses
   appels mis à jour.
4. Donner les montants calculés à la main pour ces six cas : victoire classée
   Bronze écart 1 ; écart 5 ; écart 15 (plafond) ; victoire classée Légende
   écart 3 ; défaite classée écart 1 ; défaite classée écart 7.
5. Victoire contre l'Écho aux quatre difficultés, écart 3 : donner les montants et
   vérifier qu'ils restent proches des 16 / 24 / 32 / 40 d'aujourd'hui.
6. Une partie d'Histoire ajoute bien 20 pièces, une seule fois.
7. L'écran de fin affiche le détail, et le nombre affiché est EXACTEMENT celui
   crédité à la bourse : vérifier sur une partie réelle.
8. Une partie disqualifiée ou en bac à sable ne crédite toujours rien.
9. Lancer `node outils-equilibrage/bareme.cjs 2000` et coller la sortie : le total
   hebdomadaire doit rester à quelques pour cent du barème actuel. Si l'écart
   dépasse 10 %, ne rien corriger de soi-même : le signaler.
10. Lister ce qui a été remarqué mais volontairement PAS touché.
