// Combien vaut le fait de commencer ?
//
// La regle actuelle donne UN point au camp qui commence, pour compenser le desavantage
// de poser la premiere carte (c'est le second qui pose la DERNIERE, en sachant tout).
// Cette mesure compte les cartes possedees a la fin, sans compensation, puis rejoue le
// verdict avec 0, 1, 2 et 3 points d'avance pour voir laquelle rend la partie equitable.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const reste = JOUABLES.filter((o) => o.key !== a.key);
  return [a, reste[Math.floor(Math.random() * reste.length)]];
}

// Rend l'ecart de CARTES (premier moins second), compensation exclue.
function ecartDeCartes(niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const [a1, a2] = pairAuHasard(), [b1, b2] = pairAuHasard();
  let mains = { blue: m.makeHand(a1, a2), red: m.makeHand(b1, b2) };
  const premier = Math.random() < 0.5 ? "blue" : "red";
  let tour = premier;
  for (let c = 0; c < 16; c++) {
    const main = mains[tour], adverse = mains[tour === "blue" ? "red" : "blue"];
    if (!main.length) { tour = tour === "blue" ? "red" : "blue"; continue; }
    const choix = m.botChooseMove(plateau, main, adverse, tour, tour === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) break;
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: tour };
    const res = m.resolvePlacement(plateau, choix.cellIdx, tour, poison);
    plateau = res.board; poison = res.poisonedCells || poison;
    main.splice(choix.cardIdx, 1);
    tour = tour === "blue" ? "red" : "blue";
  }
  const cartes = { blue: 0, red: 0 };
  plateau.forEach((c) => { if (c) cartes[c.owner]++; });
  const second = premier === "blue" ? "red" : "blue";
  return cartes[premier] - cartes[second];
}

const parties = Number(process.argv[2]) || 3000;
const niveau = process.argv[3] || "intermediaire";
const t0 = Date.now();

const ecarts = [];
for (let i = 0; i < parties; i++) ecarts.push(ecartDeCartes(niveau));

const moyenne = ecarts.reduce((a, b) => a + b, 0) / ecarts.length;
console.log("Niveau : " + niveau + "  |  " + parties + " parties\n");
console.log("Ecart moyen de cartes pour celui qui COMMENCE : " + moyenne.toFixed(2));
console.log("(negatif = commencer est un handicap)\n");

console.log("Compensation   celui qui commence gagne");
console.log("----------------------------------------");
for (const bonus of [0, 1, 2, 3, 4]) {
  // Score du premier = ses cartes + bonus ; du second = ses cartes. Il gagne si strictement
  // au-dessus, comme dans le jeu.
  const gagnees = ecarts.filter((e) => e + bonus > 0).length;
  const pct = gagnees / parties * 100;
  const marque = bonus === 1 ? "  <- regle actuelle" : (Math.abs(pct - 50) < 2 ? "  <- equitable" : "");
  console.log(("+" + bonus + " point" + (bonus > 1 ? "s" : "")).padEnd(15) + pct.toFixed(1).padStart(6) + " %" + marque);
}

// La repartition, pour comprendre d'ou vient le desequilibre.
const compte = {};
ecarts.forEach((e) => { compte[e] = (compte[e] || 0) + 1; });
console.log("\nRepartition des ecarts de cartes :");
Object.keys(compte).map(Number).sort((a, b) => a - b).forEach((e) => {
  console.log(String(e).padStart(4) + "  " + "#".repeat(Math.round(compte[e] / parties * 120))
    + " " + (compte[e] / parties * 100).toFixed(1) + " %");
});
console.log("\nDuree : " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
