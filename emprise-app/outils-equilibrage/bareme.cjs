// Compare le barème ACTUEL (pièces = XP x 2) à un barème fondé sur la manière de
// jouer, sur des parties réelles jouées par le moteur d'App.jsx.
const m = require("./moteur.cjs");
const JOUABLES = m.ORDERS.filter((o) => o.status !== "coming_soon" && o.key !== "geolier");
const tirer = () => JOUABLES[Math.floor(Math.random() * JOUABLES.length)];

function partie(niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const mains = { blue: m.makeHand(tirer(), tirer()), red: m.makeHand(tirer(), tirer()) };
  const premier = Math.random() < 0.5 ? "blue" : "red";
  let tour = premier;
  const cap = { blue: 0, red: 0 };
  for (let c = 0; c < 16; c++) {
    const main = mains[tour];
    const adverse = mains[tour === "blue" ? "red" : "blue"];
    if (!main.length) { tour = tour === "blue" ? "red" : "blue"; continue; }
    const choix = m.botChooseMove(plateau, main, adverse, tour, tour === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) break;
    const avant = plateau.map((x) => (x ? x.owner : null));
    const carte = main[choix.cardIdx];
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...carte, owner: tour };
    const res = m.resolvePlacement(plateau, choix.cellIdx, tour, poison);
    plateau = res.board; poison = res.poisonedCells || poison;
    for (let i = 0; i < plateau.length; i++) {
      if (i === choix.cellIdx) continue;
      if (avant[i] && plateau[i] && avant[i] !== plateau[i].owner && plateau[i].owner === tour) cap[tour]++;
    }
    main.splice(choix.cardIdx, 1);
    tour = tour === "blue" ? "red" : "blue";
  }
  const bleu = plateau.filter((x) => x && x.owner === "blue").length + (premier === "blue" ? 1 : 0);
  const rouge = plateau.filter((x) => x && x.owner === "red").length + (premier === "red" ? 1 : 0);
  const v = bleu > rouge ? "blue" : "red";
  return { ecart: Math.abs(bleu - rouge), capV: cap[v], capP: cap[v === "blue" ? "red" : "blue"] };
}

const N = Number(process.argv[2]) || 2000;
const res = []; for (let i = 0; i < N; i++) res.push(partie("intermediaire"));

// Distribution de l'ecart de score
const dist = {};
res.forEach((r) => { dist[r.ecart] = (dist[r.ecart] || 0) + 1; });
console.log("ECART DE SCORE (marge de victoire) sur " + N + " parties");
Object.keys(dist).map(Number).sort((a,b)=>a-b).forEach((e) => {
  const p = (dist[e] / N * 100);
  console.log("  ecart " + String(e).padStart(2) + " : " + p.toFixed(1).padStart(5) + " %  " + "#".repeat(Math.round(p)));
});
const serre = res.filter((r) => r.ecart <= 2).length / N;
console.log("\n  ecart <= 2 (partie serree) : " + (serre * 100).toFixed(1) + " %");
console.log("  ecart moyen                : " + (res.reduce((s,r)=>s+r.ecart,0)/N).toFixed(2));

// --- Les deux baremes, sur une semaine type de 35 parties classees, 55 % de victoires
const ACTUEL = { victoire: 30 * 2, defaite: 8 * 2 };            // XP x 2, ligue Bronze
const NOUVEAU = {
  baseVictoire: 40, parEcart: 5, plafondEcart: 10,              // la marge, plafonnee
  baseDefaite: 12, primeSerree: 8,                              // defaite honorable
};
function piecesNouveau(r, gagne) {
  if (gagne) return NOUVEAU.baseVictoire + NOUVEAU.parEcart * Math.min(r.ecart, NOUVEAU.plafondEcart);
  return NOUVEAU.baseDefaite + (r.ecart <= 2 ? NOUVEAU.primeSerree : 0);
}
let totA = 0, totN = 0, nV = 0;
const PARTIES = 35, TAUX = 0.55;
for (let i = 0; i < PARTIES; i++) {
  const r = res[Math.floor(Math.random() * res.length)];
  const gagne = Math.random() < TAUX;
  if (gagne) nV++;
  totA += gagne ? ACTUEL.victoire : ACTUEL.defaite;
  totN += piecesNouveau(r, gagne);
}
// Moyennes theoriques, plus stables que le tirage ci-dessus
const moyV = res.reduce((s,r)=>s+piecesNouveau(r,true),0)/N;
const moyD = res.reduce((s,r)=>s+piecesNouveau(r,false),0)/N;
console.log("\nPAR PARTIE (classe, ligue Bronze)");
console.log("  victoire : actuel " + ACTUEL.victoire + "  ->  nouveau " + moyV.toFixed(1) + " en moyenne");
console.log("  defaite  : actuel " + ACTUEL.defaite + "  ->  nouveau " + moyD.toFixed(1) + " en moyenne");
const semA = PARTIES * (TAUX * ACTUEL.victoire + (1-TAUX) * ACTUEL.defaite);
const semN = PARTIES * (TAUX * moyV + (1-TAUX) * moyD);
console.log("\nSEMAINE DE " + PARTIES + " PARTIES A " + (TAUX*100) + " % DE VICTOIRES");
console.log("  actuel  : " + Math.round(semA) + " pieces");
console.log("  nouveau : " + Math.round(semN) + " pieces   (" + (semN>=semA?"+":"") + (((semN/semA)-1)*100).toFixed(1) + " %)");
console.log("\n  ecart victoire/defaite : actuel x" + (ACTUEL.victoire/ACTUEL.defaite).toFixed(2) + "  ->  nouveau x" + (moyV/moyD).toFixed(2));
console.log("  fourchette nouvelle victoire : " + (NOUVEAU.baseVictoire+NOUVEAU.parEcart) + " a " + (NOUVEAU.baseVictoire+NOUVEAU.parEcart*NOUVEAU.plafondEcart) + " pieces");
