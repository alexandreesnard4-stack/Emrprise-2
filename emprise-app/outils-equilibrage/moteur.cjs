// Rend le MOTEUR REEL d'App.jsx utilisable hors de React, sans le recopier.
//
// On ne decoupe rien a la main : esbuild (deja present avec Vite) compile le JSX en
// appels de fonction ordinaires. Les composants deviennent alors du code inoffensif --
// on ne les appelle jamais. Il ne reste qu'a fournir des coquilles pour React et
// Firebase, que le niveau module ne touche pas, et a exposer ce qu'on veut essayer.
//
// L'interet : ce qu'on mesure est EXACTEMENT ce que le joueur joue. Une reimplantation
// du moteur pour les essais aurait fini par mentir.
const fs = require("fs");
const path = require("path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const F = path.join(__dirname, "..", "src", "App.jsx");
const source = fs.readFileSync(F, "utf8");

const compile = esbuild.transformSync(source, {
  loader: "jsx",
  format: "cjs",
  target: "node18",
}).code;

// Coquilles : le niveau module ne fait qu'declarer des choses. Rien de tout ceci n'est
// appele tant qu'on ne rend pas un composant.
const rien = () => {};
const crochet = () => [undefined, rien];
const faux = new Proxy(function () {}, {
  get: () => faux,
  apply: () => faux,
  construct: () => faux,
});
const modules = {
  react: {
    default: { createElement: () => null, Fragment: "fragment" },
    useState: crochet, useRef: () => ({ current: null }), useEffect: rien,
    useMemo: (f) => (typeof f === "function" ? undefined : f), memo: (c) => c,
    createElement: () => null, Fragment: "fragment",
  },
  "./firebase.js": { db: faux, auth: faux },
  "firebase/auth": { signInAnonymously: rien, onAuthStateChanged: rien },
  "firebase/firestore": new Proxy({}, { get: () => rien }),
};

const module_ = { exports: {} };
const requireStub = (nom) => {
  const m = modules[nom];
  if (!m) throw new Error("import inattendu : " + nom);
  return m;
};

try {
  new Function("require", "module", "exports", compile)(requireStub, module_, module_.exports);
} catch (e) {
  console.error("Le moteur ne s'evalue pas : " + e.message);
  process.exit(1);
}

// esbuild garde les declarations de niveau module dans la portee du module : on les
// recupere en reexecutant avec un retour explicite.
const A_EXPOSER = ["ORDERS", "ROWS", "COLS", "CELLS", "setBoardSize", "makeHand",
  "resolvePlacement", "botChooseMove", "DIFFICULTIES", "LEAGUES",
  "TROPHEES_VICTOIRE", "TROPHEES_DEFAITE", "MAITRISE_PARTIES_MAX",
  // La completion des tournois par des Echos (02/09) : la simulation et les
  // prix assainis s eprouvent hors ecran, comme le reste du moteur.
  "simulerMatchEchos", "estEchoTournoi", "prixDuTournoi", "graineDeChaine",
  "TOURNOI_ENJEU", "TOURNOI_PRIX_PAR_HUMAIN", "TOURNOI_COMPLETE_ECHOS_S", "TOURNOI_ECHO_DIFF",
  // Les medaillons (03/09) : le catalogue et ses trois lectures s eprouvent
  // dans la vraie portee du module, la ou ORDERS et MAITRISE_RANGS existent.
  "MEDAILLONS", "MEDAILLON_REPLI", "medaillonDeCle", "imageMedaillon",
  "conditionMedaillon", "obtentionMedaillon", "medaillonRang", "MAITRISE_RANGS",
  // La rotation de la boutique (01/09) : le generateur et la repartition
  // s eprouvent hors ecran, sur trois cycles complets.
  "BOUTIQUE_REFERENCE", "BOUTIQUE_JOURS", "BOUTIQUE_FAMILLES", "jourAbsoluBoutique",
  "graineBoutique", "melangeDeterministe", "tranchesBoutique", "selectionBoutique",
  "enRotation", "resteAvantRotation", "PLATEAUX", "DOS_CARTES", "BANNIERES",
  // Le Heraut du jour (01/09) : un seul par journee, eprouve sur plusieurs
  // cycles hors ecran -- on ne peut pas avancer l horloge du navigateur.
  "HEROES", "HERAUTS_RAYON", "herautsDuRayon", "herautDuJour"];
const dispo = A_EXPOSER.filter((n) => new RegExp("(function|const|let|var)\\s+" + n + "\\b").test(compile));
const moteur = new Function("require", "module", "exports",
  compile + "\nreturn {" + dispo.join(", ") + "};")(requireStub, module_, module_.exports);

moteur.__manquants = A_EXPOSER.filter((n) => !dispo.includes(n));
module.exports = moteur;

if (require.main === module) {
  console.log("Ordres charges   : " + moteur.ORDERS.length);
  console.log("Plateau          : " + moteur.ROWS + "x" + moteur.COLS + " = " + moteur.CELLS + " cases");
  console.log("Niveaux du bot   : " + (moteur.DIFFICULTIES || []).map((d) => d.key).join(", "));
  console.log("Non exposes      : " + (moteur.__manquants.join(", ") || "aucun"));
  const a = moteur.ORDERS.find((o) => o.key === "eveil");
  const b = moteur.ORDERS.find((o) => o.key === "maudits");
  const main = moteur.makeHand(a, b);
  console.log("Une main         : " + main.length + " cartes, Ordres " + [...new Set(main.map((c) => c.ability))].join(" + "));
  console.log("Une carte        : rangs " + JSON.stringify([main[0].top, main[0].right, main[0].bottom, main[0].left]));
  console.log("\nLE MOTEUR TOURNE HORS DE L'ECRAN.");
}
