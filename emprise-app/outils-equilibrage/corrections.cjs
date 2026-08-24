// Essaie les corrections possibles du handicap du premier coup, avec le moteur reel.
//
// Le constat : celui qui commence gagne 40 % des parties. La compensation en points ne
// peut pas corriger cela, l'ecart de cartes etant toujours PAIR : +1 et +2 sont
// identiques (40 %), +3 saute a 57 %. Il faut donc changer la STRUCTURE, pas le bareme.
//
// Les variantes essayees :
//   actuelle    16 cartes, +1 point a celui qui commence (reference)
//   plus3       16 cartes, +3 points
//   neuvieme    17 cartes : celui qui commence en recoit une 9e, aucun point de
//               compensation. Total impair : l'egalite redevient impossible, et c'est
//               LUI qui pose la derniere carte -- l'avantage du dernier mot change de camp.
//   septieme    15 cartes : le second n'en recoit que 7, aucun point. Meme principe,
//               par soustraction.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const reste = JOUABLES.filter((o) => o.key !== a.key);
  return [a, reste[Math.floor(Math.random() * reste.length)]];
}

// Une carte de plus, tiree des deux memes Ordres : la 9e vient d'une seconde main.
function neuviemeCarte(paire) {
  const rab = m.makeHand(paire[0], paire[1]);
  return rab[Math.floor(Math.random() * rab.length)];
}

function partieVariante(variante, niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const pB = pairAuHasard(), pR = pairAuHasard();
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const mains = { blue: m.makeHand(pB[0], pB[1]), red: m.makeHand(pR[0], pR[1]) };

  let coups = 16;
  if (variante === "neuvieme") {
    mains[premier].push({ ...neuviemeCarte(premier === "blue" ? pB : pR), id: "carte-9" });
    coups = 17;
  } else if (variante === "septieme") {
    mains[second].splice(Math.floor(Math.random() * mains[second].length), 1);
    coups = 15;
  }

  let tour = premier;
  for (let c = 0; c < coups; c++) {
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
  let scoreP = cartes[premier], scoreS = cartes[second];
  if (variante === "actuelle") scoreP += 1;
  if (variante === "plus3") scoreP += 3;
  if (scoreP === scoreS) return "egalite"; // impossible sauf accident : on veut le voir
  return scoreP > scoreS ? "premier" : "second";
}

const parties = Number(process.argv[2]) || 3000;
const niveau = process.argv[3] || "intermediaire";
const t0 = Date.now();

console.log("Niveau : " + niveau + "  |  " + parties + " parties par variante\n");
console.log("Variante     celui qui commence gagne    egalites");
console.log("--------------------------------------------------");
for (const v of ["actuelle", "plus3", "neuvieme", "septieme"]) {
  let p = 0, e = 0;
  for (let i = 0; i < parties; i++) {
    const r = partieVariante(v, niveau);
    if (r === "premier") p++;
    else if (r === "egalite") e++;
  }
  const pct = p / (parties - e) * 100;
  const marge = 1.96 * Math.sqrt((pct / 100) * (1 - pct / 100) / (parties - e)) * 100;
  const note = Math.abs(pct - 50) < 2.5 ? "  <- EQUITABLE" : "";
  console.log(v.padEnd(12) + (pct.toFixed(1) + " % +-" + marge.toFixed(1)).padStart(16)
    + String(e).padStart(9) + note);
}
console.log("\nDuree : " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
