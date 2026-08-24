// La Mort Subite : la correction du premier coup qui passe entre les mailles de la parite.
//
// Le noeud du probleme : l'ecart de cartes est toujours pair. +1 point donne 41 % a celui
// qui commence, +3 donne 58 % -- et il n'existe RIEN entre les deux, toute la difference
// tient dans les parties qui finissent a deux cartes d'ecart. La seule facon d'atterrir a
// 50 %, c'est de partager cette bande : +2 points, et l'EGALITE PARFAITE (rendue possible
// par le +2) se joue en Mort Subite -- chaque camp tire une carte de ses Ordres et la
// pose sur les cases restees vides, celui qui commencait pose en premier, on recompte.
// C'est du jeu, pas une piece : les captures s'y font, le talent s'y exprime.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const reste = JOUABLES.filter((o) => o.key !== a.key);
  return [a, reste[Math.floor(Math.random() * reste.length)]];
}
function carteDe(paire) {
  const main = m.makeHand(paire[0], paire[1]);
  return main[Math.floor(Math.random() * main.length)];
}

function partie(niveau, bonus) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const pB = pairAuHasard(), pR = pairAuHasard();
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const mains = { blue: m.makeHand(pB[0], pB[1]), red: m.makeHand(pR[0], pR[1]) };
  const paires = { blue: pB, red: pR };

  const jouer = (camp) => {
    const main = mains[camp];
    if (!main.length) return false;
    const adverse = mains[camp === "blue" ? "red" : "blue"];
    const choix = m.botChooseMove(plateau, main, adverse, camp, camp === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) return false;
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: camp };
    const res = m.resolvePlacement(plateau, choix.cellIdx, camp, poison);
    plateau = res.board; poison = res.poisonedCells || poison;
    main.splice(choix.cardIdx, 1);
    return true;
  };

  let tour = premier;
  for (let c = 0; c < 16; c++) { jouer(tour); tour = tour === "blue" ? "red" : "blue"; }

  const score = () => {
    const n = { blue: 0, red: 0 };
    plateau.forEach((c) => { if (c) n[c.owner]++; });
    return { p: n[premier] + bonus, s: n[second] };
  };

  let rondes = 0;
  let { p, s } = score();
  // Mort Subite : tant que l'egalite tient et qu'il reste au moins deux cases.
  while (p === s && plateau.filter((c) => !c).length >= 2 && rondes < 2) {
    rondes++;
    mains[premier] = [{ ...carteDe(paires[premier]), id: "ms-p-" + rondes }];
    mains[second] = [{ ...carteDe(paires[second]), id: "ms-s-" + rondes }];
    jouer(premier);
    jouer(second);
    ({ p, s } = score());
  }
  // Egalite indeboulonnable (rarissime) : elle va au second, qui a subi le bonus.
  return { gagnant: p === s ? "second" : p > s ? "premier" : "second", rondes };
}

const parties = Number(process.argv[2]) || 4000;
const niveau = process.argv[3] || "intermediaire";
const bonus = Number(process.argv[4] ?? 2);
const t0 = Date.now();

let prem = 0, subites = 0, deuxRondes = 0, insolubles = 0;
for (let i = 0; i < parties; i++) {
  const r = partie(niveau, bonus);
  if (r.gagnant === "premier") prem++;
  if (r.rondes >= 1) subites++;
  if (r.rondes >= 2) deuxRondes++;
}
const pct = prem / parties * 100;
const marge = 1.96 * Math.sqrt((pct / 100) * (1 - pct / 100) / parties) * 100;
console.log("Niveau : " + niveau + "  |  " + parties + " parties  |  bonus +" + bonus + " puis Mort Subite\n");
console.log("Celui qui commence gagne : " + pct.toFixed(1) + " % +-" + marge.toFixed(1)
  + (Math.abs(pct - 50) < 2.5 ? "   <- EQUITABLE" : ""));
console.log("Parties en Mort Subite   : " + (subites / parties * 100).toFixed(1) + " %");
console.log("Deux rondes necessaires  : " + (deuxRondes / parties * 100).toFixed(1) + " %");
console.log("Duree : " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
