import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// host: true expose le serveur sur le réseau local (test depuis un téléphone).
// Le port vient de l'environnement quand l'outil de préversion en assigne un,
// sinon 5173 comme avant.

// ---------- L'horodatage du build (04/09) ----------
// Il est calculé ICI, à l'évaluation de la configuration, c'est-à-dire à chaque
// construction. Jamais saisi à la main : un horodatage écrit à la main ment dès le build
// suivant. La ligne qu'il remplaçait dans l'application affichait « 29 août · 15h » six
// jours après le 29 août.
//
// Sur Vercel, la configuration est évaluée par le constructeur au moment du déploiement :
// la valeur est donc l'heure du DÉPLOIEMENT, pas celle du dernier commit ni du jour où un
// fichier a été édité. Rien ici ne dépend de la machine : ni git, ni variable
// d'environnement, ni fichier hors de dist.
//
// Les noms de mois sont écrits à la main plutôt que demandés à Intl en français : une
// installation de Node sans ICU complet rendrait « September ». On ne demande à Intl que
// des NOMBRES, ce que toute installation sait faire, et le fuseau de Paris, qu'elle
// applique de la même façon partout.
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function horodatageDeParis(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    day: "numeric", month: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${Number(p.day)} ${MOIS[Number(p.month) - 1]} ${p.year}, ${p.hour}h${p.minute}`;
}

const HORODATAGE = horodatageDeParis();

// La même valeur, en tête de public/etat-du-jeu.txt — mais dans la COPIE CONSTRUITE, pas
// dans la source. Toucher la source à chaque build salirait le dépôt à chaque essai local
// et ferait mentir le fichier entre deux déploiements ; ici, le fichier servi par Vercel
// porte l'heure de son propre déploiement, et le dépôt reste propre.
function horodateEtatDuJeu(horodatage) {
  return {
    name: "horodate-etat-du-jeu",
    apply: "build",
    closeBundle() {
      const f = fileURLToPath(new URL("./dist/etat-du-jeu.txt", import.meta.url));
      if (!fs.existsSync(f)) return;
      const lignes = fs.readFileSync(f, "utf8").split(/\r?\n/);
      const ligne = `Version du ${horodatage} — horodatage posé automatiquement à la construction.`;
      const deja = lignes.findIndex((l) => l.startsWith("Version "));
      if (deja >= 0) lignes[deja] = ligne;
      else lignes.splice(1, 0, ligne);
      fs.writeFileSync(f, lignes.join("\n"));
    },
  };
}

export default defineConfig({
  plugins: [react(), horodateEtatDuJeu(HORODATAGE)],
  // Remplacé à la compilation, dans le serveur de développement comme dans le build : en
  // développement la valeur est l'heure de démarrage du serveur, ce qui est la vérité.
  define: {
    __HORODATAGE_BUILD__: JSON.stringify(HORODATAGE),
  },
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
  },
});
