// Chercher un DEPARTAGE sans hasard pour les parties a egalite parfaite.
//
// Rappel du blocage : seize cartes posees, donc l'ecart de cartes est toujours PAIR.
// Passer le bonus de +1 a +2 transforme la defaite la plus frequente du premier joueur
// (deux cartes de retard, ~17 % des parties) en egalite parfaite. Reste a trancher ces
// egalites -- et la mort subite le fait par une carte tiree au sort, ce qui met du hasard
// au moment le plus tendu de la partie. On cherche mieux.
//
// Un bon departage doit etre : deterministe (aucun tirage), issu du JEU (pas d'une regle
// arbitraire), et surtout NEUTRE -- ni le premier ni le second ne doit le gagner
// systematiquement. C'est ce dernier point qui a tue le departage aux captures : jouer en
// dernier fait capturer davantage, le second gagnait neuf departages sur dix.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const r = JOUABLES.filter((o) => o.key !== a.key);
  return [a, r[Math.floor(Math.random() * r.length)]];
}

// Joue une partie et rend tout ce qu'on peut mesurer pour departager.
function partie(niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const mains = { blue: m.makeHand(...pairAuHasard()), red: m.makeHand(...pairAuHasard()) };

  const stat = {
    captures: { blue: 0, red: 0 },     // cases prises a l'adversaire
    perdues:  { blue: 0, red: 0 },     // cases qu'on s'est fait prendre
    tours:    { blue: 0, red: 0 },     // tours passes en tete
    jamaisPerdue: { blue: 0, red: 0 }, // cartes posees et jamais reprises
  };
  const poseurDe = new Array(m.CELLS).fill(null); // qui a pose la carte de cette case
  const reprise = new Array(m.CELLS).fill(false);

  for (let c = 0; c < 16; c++) {
    const camp = c % 2 === 0 ? premier : second;
    const main = mains[camp];
    if (main.length) {
      const adverse = mains[camp === "blue" ? "red" : "blue"];
      const choix = m.botChooseMove(plateau, main, adverse, camp,
        camp === "blue" ? "red" : "blue", niveau, poison);
      if (choix) {
        const avant = plateau.map((x) => x && x.owner);
        plateau = plateau.slice();
        plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: camp };
        poseurDe[choix.cellIdx] = camp;
        const res = m.resolvePlacement(plateau, choix.cellIdx, camp, poison);
        plateau = res.board; poison = res.poisonedCells || poison;
        for (let i = 0; i < m.CELLS; i++) {
          if (i !== choix.cellIdx && avant[i] && avant[i] !== camp
              && plateau[i] && plateau[i].owner === camp) {
            stat.captures[camp]++;
            stat.perdues[avant[i]]++;
            reprise[i] = true;
          }
        }
        main.splice(choix.cardIdx, 1);
      }
    }
    // Qui mene, apres ce coup ?
    let b = 0, r2 = 0;
    plateau.forEach((x) => { if (x) (x.owner === "blue" ? b++ : r2++); });
    if (b > r2) stat.tours.blue++; else if (r2 > b) stat.tours.red++;
  }

  const n = { blue: 0, red: 0 };
  plateau.forEach((x) => { if (x) n[x.owner]++; });
  for (let i = 0; i < m.CELLS; i++) {
    if (poseurDe[i] && !reprise[i]) stat.jamaisPerdue[poseurDe[i]]++;
  }
  return { premier, second, n, stat };
}

// Les departages a l'essai. Chacun rend "premier", "second", ou null s'il ne tranche pas.
const DEPARTAGES = {
  "captures":      (p) => cmp(p.stat.captures[p.premier], p.stat.captures[p.second]),
  "moins perdues": (p) => cmp(p.stat.perdues[p.second], p.stat.perdues[p.premier]),
  "mene le plus":  (p) => cmp(p.stat.tours[p.premier], p.stat.tours[p.second]),
  "mene, sinon 1er": (p) => cmp(p.stat.tours[p.premier], p.stat.tours[p.second]) || "premier",
  "jamais perdue": (p) => cmp(p.stat.jamaisPerdue[p.premier], p.stat.jamaisPerdue[p.second]),
};
function cmp(a, b) { return a === b ? null : a > b ? "premier" : "second"; }

const N = Number(process.argv[2]) || 4000;
const niveau = process.argv[3] || "intermediaire";

const parties = [];
for (let i = 0; i < N; i++) parties.push(partie(niveau));

// Les parties a egalite parfaite avec un bonus de +2 : celles ou le premier a exactement
// deux cartes de retard.
const aDepartager = parties.filter((p) => p.n[p.premier] + 2 === p.n[p.second]);
const gagneesDavance = parties.filter((p) => p.n[p.premier] + 2 > p.n[p.second]).length;

console.log("Niveau " + niveau + "  |  " + N + " parties\n");
console.log("Parties a egalite parfaite (bonus +2) : " + aDepartager.length
  + "  (" + (aDepartager.length / N * 100).toFixed(1) + " %)");
console.log("Deja gagnees par le premier             : " + (gagneesDavance / N * 100).toFixed(1) + " %");
console.log("\nPour etre juste, un departage doit rendre le premier gagnant d'environ la");
console.log("MOITIE des egalites, ce qui l'amenerait a 50 % au total.\n");

const cible = (50 - gagneesDavance / N * 100) / (aDepartager.length / N * 100) * 100;
console.log("Part des egalites que le premier devrait gagner : " + cible.toFixed(0) + " %\n");

console.log("Departage".padEnd(16) + "le premier gagne".padStart(18) + "  ne tranche pas    total");
console.log("-".repeat(62));
for (const [nom, f] of Object.entries(DEPARTAGES)) {
  let p = 0, nul = 0;
  aDepartager.forEach((x) => { const r = f(x); if (r === "premier") p++; else if (r === null) nul++; });
  // Une egalite indeboulonnable va au second (il a subi le bonus).
  const total = (gagneesDavance + p) / N * 100;
  const juste = Math.abs(total - 50) < 2.5;
  console.log(nom.padEnd(16)
    + ((p / aDepartager.length * 100).toFixed(0) + " %").padStart(18)
    + (nul + " fois").padStart(15)
    + (total.toFixed(1) + " %" + (juste ? " *" : "")).padStart(11));
}
console.log("\n* = total entre 47,5 et 52,5 %, donc equitable");
