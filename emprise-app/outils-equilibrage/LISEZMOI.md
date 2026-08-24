# Outils d'équilibrage

Ces scripts font tourner le **moteur réel** d'`App.jsx` hors de l'écran, dans Node,
pour jouer des milliers de parties et mesurer l'équilibrage. Rien n'est recopié :
`moteur.cjs` compile le fichier du jeu avec esbuild et remplace React et Firebase
par des coquilles. Ce qu'on mesure est exactement ce que le joueur joue — si les
règles ou un Ordre changent dans `App.jsx`, les mesures suivent toutes seules.

Aucun de ces fichiers n'est embarqué dans le jeu : `npm run build` ne les voit pas.

## Les scripts

```bash
node outils-equilibrage/moteur.cjs
```
Vérifie que le moteur s'extrait et tourne (à lancer d'abord après un gros changement).

```bash
node outils-equilibrage/equilibrage.cjs 6000 intermediaire
```
Le classement des Ordres : des paires tirées au hasard des deux côtés, la victoire
attribuée aux deux Ordres du camp gagnant. Niveaux : `debutant`, `intermediaire`,
`avance`, `expert`. Environ 26 s pour 6 000 parties en intermédiaire ; l'expert est
~40 fois plus lent.

```bash
node outils-equilibrage/premier-coup.cjs 4000 intermediaire
```
Le handicap du premier coup : écart moyen de cartes, et ce que donnerait chaque
compensation en points (+0 à +4).

```bash
node outils-equilibrage/mort-subite.cjs 5000 intermediaire 2
```
La règle candidate : +2 points à celui qui commence, égalité parfaite réglée en
Mort Subite (chaque camp tire une carte et la joue sur les cases restées vides).

`corrections.cjs` (9e carte, 7 cartes, +3) et `departage-captures.cjs` (départage
au nombre de captures) sont les variantes **essayées et écartées** — gardées pour
ne pas les réessayer un jour en croyant avoir eu une idée neuve.

## Les mesures du 25/08/2026 (celui qui commence gagne)

| Niveau | Règle actuelle (+1) | +2 & Mort Subite |
|---|---|---|
| débutant | 49,5 % | 59,8 % |
| intermédiaire | 41,3 % | **50,6 %** |
| avancé | 40,0 % | **49,1 %** |
| expert | 40,7 % | 54,3 % |

L'écart de cartes est toujours **pair** (16 cartes posées) : aucune compensation
entière ne peut tomber à 50 % — +1 et +2 sont identiques (40 %), +3 saute à 58 %.
Toute la différence tient dans les parties à deux cartes d'écart (~16 %) ; seule
une règle qui **partage cette bande** peut être équitable, d'où la Mort Subite.
Le départage aux captures échoue : jouer en dernier fait capturer plus, le second
gagne 90 % des départages.

Classement des Ordres (mêmes séries) : Cendres faibles partout (47,6 % puis
37,4 % en expert) ; Piques fortes contre un bot moyen, faibles contre un bon ;
Dorés l'inverse (62,3 % en expert).

## Limites

Le bot n'est pas un joueur parfait : identique des deux côtés, il n'avantage
aucun camp, mais son évaluation peut favoriser un style. La Confluence, les
Hérauts et le mode Histoire ne sont pas couverts.
