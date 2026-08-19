# EMPRISE

Jeu de cartes stratégique — projet React (Vite), avec multijoueur en ligne (Firebase).

## Structure

- `src/App.jsx` — le jeu complet (règles, Légions, capacités, bot, animations, multijoueur)
- `src/firebase.js` — connexion à Firebase (Firestore + authentification anonyme)
- `firestore.rules` — règles de sécurité à coller dans la console Firebase
- `.env.example` — clés Firebase à renseigner (copier en `.env`)

## Configurer Firebase pour le multijoueur (à faire une fois)

1. Sur [console.firebase.google.com](https://console.firebase.google.com), ouvre ton projet
2. Dans le menu de gauche : **Build > Firestore Database** → "Créer une base de données" → mode **production** → choisis une région proche de toi
3. Toujours dans **Firestore Database**, onglet **Règles** : colle le contenu de `firestore.rules`, puis "Publier"
4. Dans le menu de gauche : **Build > Authentication** → "Get started" → onglet **Sign-in method** → active **Anonyme** (Anonymous)
5. Dans **⚙️ Paramètres du projet > Général**, en bas dans "Vos applications", clique sur l'icône `</>` pour ajouter une application Web si ce n'est pas déjà fait → copie les 6 valeurs de configuration qui s'affichent
6. Sur **Vercel**, Settings > Environment Variables, colle ces 6 valeurs dans les variables listées dans `.env.example`
7. Redéploie (Deployments > Redeploy)

## Tester en local (optionnel, si tu as Node.js installé)

```
npm install
npm run dev
```

## Déployer sur Vercel

1. Crée un dépôt sur **GitHub** (github.com > New repository)
2. Mets tous ces fichiers dedans (glisser-déposer sur la page du dépôt, ou "Add file > Upload files") — attention à bien uploader le **contenu** du dossier, pas un zip
3. Sur **Vercel** (vercel.com) : "Add New Project" > importe ce dépôt GitHub
4. Vérifie que **Framework Preset** = `Vite` et que le **Root Directory** pointe vers le bon dossier si les fichiers ne sont pas à la racine du dépôt
5. Ajoute les 6 variables d'environnement Firebase (voir section ci-dessus)
6. Deploy

Une fois déployé, ouvre l'URL sur ton iPhone et ajoute-la à l'écran d'accueil (bouton Partager > "Sur l'écran d'accueil") pour qu'elle se comporte comme une vraie app.

## Tester le multijoueur

Il te faut 2 appareils (ou 2 onglets/navigateurs différents pour un premier test rapide) :
1. Sur l'appareil 1 : Nouvelle partie > Multijoueur en ligne > "Créer une partie" → un code à 5 lettres s'affiche
2. Sur l'appareil 2 : Nouvelle partie > Multijoueur en ligne > entre ce code > "Rejoindre"
3. Chacun choisit ses 2 Légions de son côté
4. Dès que les deux ont confirmé, la partie démarre automatiquement des deux côtés

**Limite connue** : pour l'instant, les deux mains sont visibles dans les données Firestore (un joueur techniquement curieux pourrait inspecter le réseau et voir les cartes de l'adversaire à l'avance). Pour une vraie dissimulation sécurisée, il faudrait déplacer la logique de résolution des coups vers une Cloud Function côté serveur, une amélioration possible plus tard, pas bloquante pour jouer entre amis de confiance.
