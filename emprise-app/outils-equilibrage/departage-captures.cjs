// Variante SANS nouvelle phase : +2 points a celui qui commence, et l'egalite parfaite
// departagee par le nombre de CAPTURES faites pendant la partie. Deterministe, lisible,
// rien a synchroniser en ligne. Si les captures aussi sont a egalite, elle va au second,
// qui a subi le bonus. On compte une capture chaque fois qu'une case change de camp au
// profit du poseur, la carte posee exclue.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const r = JOUABLES.filter((o) => o.key !== a.key);
  return [a, r[Math.floor(Math.random() * r.length)]];
}

function partie(niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const mains = { blue: m.makeHand(...pairAuHasard()), red: m.makeHand(...pairAuHasard()) };
  const captures = { blue: 0, red: 0 };
  let tour = premier;
  for (let c = 0; c < 16; c++) {
    const main = mains[tour];
    if (main.length) {
      const adverse = mains[tour === "blue" ? "red" : "blue"];
      const choix = m.botChooseMove(plateau, main, adverse, tour, tour === "blue" ? "red" : "blue", niveau, poison);
      if (choix) {
        const avant = plateau.map((x) => x && x.owner);
        plateau = plateau.slice();
        plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: tour };
        const res = m.resolvePlacement(plateau, choix.cellIdx, tour, poison);
        plateau = res.board; poison = res.poisonedCells || poison;
        for (let i = 0; i < m.CELLS; i++) {
          if (i !== choix.cellIdx && avant[i] && avant[i] !== tour
              && plateau[i] && plateau[i].owner === tour) captures[tour]++;
        }
        main.splice(choix.cardIdx, 1);
      }
    }
    tour = tour === "blue" ? "red" : "blue";
  }
  const n = { blue: 0, red: 0 };
  plateau.forEach((c) => { if (c) n[c.owner]++; });
  const p = n[premier] + 2, s = n[second];
  if (p !== s) return { g: p > s ? "premier" : "second", dep: false };
  if (captures[premier] !== captures[second])
    return { g: captures[premier] > captures[second] ? "premier" : "second", dep: true };
  return { g: "second", dep: true };
}

const N = Number(process.argv[2]) || 4000;
const niveau = process.argv[3] || "intermediaire";
let prem = 0, dep = 0, depPremier = 0;
for (let i = 0; i < N; i++) {
  const r = partie(niveau);
  if (r.g === "premier") prem++;
  if (r.dep) { dep++; if (r.g === "premier") depPremier++; }
}
const pct = prem / N * 100;
console.log("Niveau " + niveau + " | " + N + " parties | +2 puis departage aux captures");
console.log("Celui qui commence gagne : " + pct.toFixed(1) + " %"
  + (Math.abs(pct - 50) < 2.5 ? "   <- EQUITABLE" : ""));
console.log("Parties departagees      : " + (dep / N * 100).toFixed(1) + " %"
  + "  (le premier en gagne " + (dep ? (depPremier / dep * 100).toFixed(0) : 0) + " %)");
