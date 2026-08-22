# EMPRISE — Répertoire des combos d'Ordres

Méthode : chaque combo ci-dessous est soit **vérifié en simulation** (le moteur du jeu a été
exécuté en Node sur le scénario exact), soit **dérivé du code** (la mécanique est écrite noir
sur blanc dans le moteur). Aucun combo théorique invérifiable.

Le nom de chaque combo est pensé pour le profil joueur : c'est le titre qu'on affichera
quand un joueur joue majoritairement cette paire.

---

## Les combos vérifiés en simulation

### 1. L'Or Corrompu — Pestiférés + Dorés
Le poison affaiblit toute carte posée sur une case marquée, y compris la tienne. Or l'Éveil
des Dorés échange ses rangs contre ceux de l'ennemie : plus le Dorés est faible, meilleur
est le troc. **Vérifié : une égalité 5 contre 5 (pas de capture) devient une capture si le
Dorés se pose sur ta propre case empoisonnée.** Le joueur empoisonne le terrain avec ses
Pestiférés, puis vient y poser ses Dorés comme dans un bain d'acide.
Attention : le Héraut des Pestiférés TUE ce combo (il épargne ton camp, donc ton Dorés
n'est plus affaibli). C'est le seul combo du jeu qui se joue sans son Héraut.
*Détection : poses de Dorés sur case empoisonnée par le joueur lui-même.*

### 2. La Rançon — Maudits + Dorés
Le Maudit gagne +1 partout à CHAQUE capture, définitivement, peu importe qui le prend.
Laisse l'adversaire voler ton Maudit (il grossit), puis rachète-le : l'Éveil des Dorés
capture précisément les cartes plus fortes que lui. **Vérifié : deux navettes = +2, la
carte revient chez toi plus dangereuse qu'au départ.** Chaque aller-retour la nourrit.
*Détection : recaptures de Maudits alliés (Maudit perdu puis repris dans la même partie).*

### 3. La Traîne au Venin — Cendres + Pestiférés
La carte attirée par les Cendres perd 1 rang par case empoisonnée traversée (case
d'arrivée comprise, cumulatif). Empoisonne le couloir, puis tire l'ennemie à travers.
**Vérifié : une carte qui résiste au bras des Cendres sur couloir propre (défense 6 contre
5) est capturée après avoir traversé deux cases de venin.** Le joueur prépare son piège
deux coups à l'avance.
*Détection : attirances dont le trajet traverse au moins une case empoisonnée.*

### 4. La Marée Montante — Abysses + n'importe quel captureur (Dorés en tête)
Le bonus des Abysses compte les Abysses POSSÉDÉES, pas posées : une Abysse ennemie volée
rejoint ton banc et nourrit la prochaine que tu poses. **Vérifié : capture l'Abysse
adverse, pose la tienne, elle arrive déjà à +1.** Le combo se retourne aussi contre toi :
chaque Abysse perdue nourrit l'adversaire s'il en joue.
*Détection : captures d'Abysses ennemies par un joueur qui aligne des Abysses.*

---

## Les combos dérivés du code

### 5. Le Miroir Truqué — Chimères + Dorés
La mue retourne l'axe d'une ennemie : son rang fort peut se retrouver face à ton Dorés.
L'Éveil capture ce qui est plus fort que lui, donc tourner le 9 de l'ennemie vers ton
Dorés, c'est le lui offrir. La Chimère prépare, le Dorés encaisse.
*Détection : Éveil déclenché sur une carte ayant subi une mue dans la même partie.*

### 6. Le Trait Voilé — Scribes + Archers
La faiblesse mortelle de l'Archer, c'est son 1 : tout le monde sait où frapper. Le voile
des Scribes cache les rangs quelques tours : l'adversaire ne sait plus où est le 1, ni où
est le 9. L'Archer dissimulé tire sans exposer sa gorge.
*Détection : Archers posés pendant qu'un voile de Scribe est actif sur le plateau.*

### 7. La Battue — Cendres + Archers
Les Cendres arrachent une ennemie de sa poche protégée et la traînent en terrain ouvert ;
la flèche de l'Archer traverse les cases vides et frappe la première ennemie de la ligne.
L'un rabat le gibier, l'autre l'abat. Combo de position pur.
*Détection : capture par portée dans les 2 tours suivant une attirance.*

### 8. La Brèche — Chimères + Piques
La mue retourne une ennemie pour exposer son flanc faible ; la Piques transperce jusqu'à
deux cartes alignées. Ouvre la brèche, puis enfonce la lance dans l'alignement.
*Détection : percée réussie sur une carte retournée par mue dans la même partie.*

### 9. La Fosse — Pestiférés + Abysses
Deux échelles de temps opposées : le poison fait rétrécir tout ce que l'adversaire pose
dans la zone, pendant que tes Abysses grossissent à mesure que le banc se remplit. La
zone empoisonnée protège les Abysses fragiles du début (total 16, les plus faibles du
jeu) le temps qu'elles deviennent intouchables.
*Détection : Abysses posées adjacentes à des cases empoisonnées alliées.*

### 10. Le Rempart Vicié — Gardiens + Pestiférés
Le déni de zone ultime : le Gardien (+1 défensif permanent, signature en double paire)
verrouille les cases saines, le poison rend les autres invivables. L'adversaire n'a plus
un seul endroit rentable où poser. Combo lent, étouffant, très typé "contrôle".
*Détection : parties gagnées au score avec Gardiens + au moins 3 cases empoisonnées actives.*

---

## Les mariages ratés (anti-synergies)

- **Gardiens + Archers** : le mur ne protège pas le 1 de l'Archer, et l'Archer n'offre
  aucune capture au Gardien. Aucun des deux ne répare la faiblesse de l'autre.
- **Pestiférés (avec Héraut) + Dorés** : le Héraut épargne ton camp, ton Dorés n'est plus
  affaibli, L'Or Corrompu s'éteint. Anti-synergie interne au combo n°1.
- **Dorés + Gardiens adverses** : pas un choix de deck mais bon à savoir : l'Éveil échange
  contre le rang défensif bouclier COMPRIS, le Gardien est la seule cible qui vend cher
  sa peau au troc (le bouclier passe dans l'échange, c'est déjà géré par le moteur).
- **Abysses en ouverture solitaire** : à 16 de total sans banc, elle nourrit la Marée
  Montante... de l'adversaire.

---

## Pour le profil joueur (implémentation)

Le moteur émet déjà tous les événements nécessaires (poison, eveil, mue, attraction-pull,
maudit-boost, percee, portee, devoreuse...). Il suffit de compter, par joueur :

1. à chaque fin de partie, détecter les signaux ci-dessus dans le journal d'événements ;
2. incrémenter un compteur par combo dans les stats du joueur ;
3. au-dessus d'un seuil (par exemple : combo réalisé dans 30 % des parties, minimum 10
   parties), afficher le titre sur le profil : « Style : L'Or Corrompu ».

Un joueur peut cumuler plusieurs titres ; on affiche le dominant, les autres en petit.
