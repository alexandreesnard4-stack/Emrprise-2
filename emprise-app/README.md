# EMPRISE

Jeu de cartes stratégique — projet React (Vite).

## Structure

- `src/App.jsx` — le jeu complet (règles, Légions, capacités, bot, animations)
- `src/firebase.js` — connexion à Firebase (pour le multijoueur, à venir)
- `.env.example` — clés Firebase à renseigner (copier en `.env`)

## Tester en local (optionnel, si tu as Node.js installé)

```
npm install
npm run dev
```

## Déployer sur Vercel (le chemin recommandé, sans rien installer)

1. Crée un dépôt sur **GitHub** (github.com > New repository)
2. Mets tous ces fichiers dedans (glisser-déposer sur la page du dépôt, ou "Add file > Upload files")
3. Sur **Vercel** (vercel.com) : "Add New Project" > importe ce dépôt GitHub
4. Vercel détecte automatiquement Vite — laisse les réglages par défaut et clique "Deploy"
5. Dans les réglages du projet Vercel > **Environment Variables**, ajoute les 6 clés listées dans `.env.example`, avec tes vraies valeurs Firebase (Firebase Console > ⚙️ Paramètres du projet > Tes applications > Config SDK)
6. Redéploie (Vercel > Deployments > "Redeploy") pour que les variables soient prises en compte

Une fois déployé, tu obtiens une URL type `emprise.vercel.app` — ouvre-la sur ton iPhone et ajoute-la à l'écran d'accueil (bouton Partager > "Sur l'écran d'accueil") pour qu'elle se comporte comme une vraie app.
