// Mesure la MATIERE d'un barème de pièces fondé sur la manière de jouer :
// combien de cartes un camp capture réellement au cours d'une partie, et
// comment ce nombre se distribue entre vainqueur et perdant.
// Rien n'est recopié : le moteur réel d'App.jsx joue les parties.
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
  const captures = { blue: 0, red: 0 };
  let coups = 0;

  for (let c = 0; c < 16; c++) {
    const main = mains[tour];
    const adverse = mains[tour === "blue" ? "red" : "blue"];
    if (!main.length) { tour = tour === "blue" ? "red" : "blue"; continue; }
    const choix = m.botChooseMove(plateau, main, adverse, tour,
      tour === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) break;
    const avant = plateau.map((x) => (x ? x.owner : null));
    const carte = main[choix.cardIdx];
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...carte, owner: tour };
    const res = m.resolvePlacement(plateau, choix.cellIdx, tour, poison);
    plateau = res.board;
    poison = res.poisonedCells || poison;
    // Une capture : une carte DEJA posée qui change de camp au profit du poseur.
    for (let i = 0; i < plateau.length; i++) {
      if (i === choix.cellIdx) continue;
      if (avant[i] && plateau[i] && avant[i] !== plateau[i].owner && plateau[i].owner === tour) captures[tour]++;
    }
    main.splice(choix.cardIdx, 1);
    tour = tour === "blue" ? "red" : "blue";
    coups++;
  }
  const bleu = plateau.filter((x) => x && x.owner === "blue").length + (premier === "blue" ? 1 : 0);
  const rouge = plateau.filter((x) => x && x.owner === "red").length + (premier === "red" ? 1 : 0);
  const vainqueur = bleu > rouge ? "blue" : "red";
  const perdant = vainqueur === "blue" ? "red" : "blue";
  return {
    capV: captures[vainqueur], capP: captures[perdant],
    ecart: Math.abs(bleu - rouge), coups,
  };
}

const N = Number(process.argv[2]) || 400;
const niveau = process.argv[3] || "intermediaire";
const t0 = Date.now();
const res = [];
for (let i = 0; i < N; i++) res.push(partie(niveau));

const moy = (f) => res.reduce((s, r) => s + f(r), 0) / res.length;
const tri = (f) => res.map(f).sort((a, b) => a - b);
const pct = (a, p) => a[Math.floor((a.length - 1) * p)];
const cv = tri((r) => r.capV), cp = tri((r) => r.capP);

console.log(`${N} parties en ${niveau} — ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
console.log("CAPTURES DU VAINQUEUR   moy " + moy((r) => r.capV).toFixed(2) +
  "  | min " + cv[0] + "  p25 " + pct(cv, .25) + "  med " + pct(cv, .5) + "  p75 " + pct(cv, .75) + "  max " + cv[cv.length - 1]);
console.log("CAPTURES DU PERDANT     moy " + moy((r) => r.capP).toFixed(2) +
  "  | min " + cp[0] + "  p25 " + pct(cp, .25) + "  med " + pct(cp, .5) + "  p75 " + pct(cp, .75) + "  max " + cp[cp.length - 1]);
console.log("Ecart de score moyen    " + moy((r) => r.ecart).toFixed(2));
console.log("Coups joues moyen       " + moy((r) => r.coups).toFixed(2));
