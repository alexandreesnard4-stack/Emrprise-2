// Joue des parties completes avec le MOTEUR REEL, sans ecran, pour mesurer l'equilibrage.
//
// Une partie : 16 cartes posees a tour de role sur les 20 cases, chaque camp choisissant
// par botChooseMove. Le score final suit la regle du jeu -- cartes possedees, plus un
// point pour celui qui a commence, ce qui rend toute egalite impossible.
const m = require("./moteur.cjs");

const JOUABLES = m.ORDERS.filter((o) => o.status !== "coming_soon" && o.key !== "geolier");

// Une partie entiere. Rend "blue" ou "red".
function partie(ordresBleu, ordresRouge, premier, niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  let mainBleue = m.makeHand(ordresBleu[0], ordresBleu[1]);
  let mainRouge = m.makeHand(ordresRouge[0], ordresRouge[1]);
  let tour = premier;

  for (let coup = 0; coup < 16; coup++) {
    const main = tour === "blue" ? mainBleue : mainRouge;
    const adverse = tour === "blue" ? mainRouge : mainBleue;
    if (!main.length) { tour = tour === "blue" ? "red" : "blue"; continue; }
    const choix = m.botChooseMove(plateau, main, adverse, tour,
      tour === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) break;
    // On pose la carte, puis le moteur resout captures, capacites et poison.
    const carte = main[choix.cardIdx];
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...carte, owner: tour };
    const res = m.resolvePlacement(plateau, choix.cellIdx, tour, poison);
    plateau = res.board;
    poison = res.poisonedCells || poison;
    main.splice(choix.cardIdx, 1);
    tour = tour === "blue" ? "red" : "blue";
  }

  const bleu = plateau.filter((c) => c && c.owner === "blue").length + (premier === "blue" ? 1 : 0);
  const rouge = plateau.filter((c) => c && c.owner === "red").length + (premier === "red" ? 1 : 0);
  return bleu > rouge ? "blue" : "red";
}

// Un duel entre deux Ordres, chacun seul dans sa main, a armes egales : chaque camp
// commence la moitie des parties. Rend le taux de victoire du PREMIER.
function duel(a, b, parties, niveau) {
  let gagnees = 0;
  for (let i = 0; i < parties; i++) {
    const aCommence = i % 2 === 0;
    const v = aCommence
      ? partie([a, a], [b, b], "blue", niveau)
      : partie([b, b], [a, a], "red", niveau);
    // "a" est bleu quand il commence, rouge sinon.
    if ((aCommence && v === "blue") || (!aCommence && v === "red")) gagnees++;
  }
  return gagnees / parties;
}

if (require.main === module) {
  const parties = Number(process.argv[2]) || 20;
  const niveau = process.argv[3] || "intermediaire";
  const t0 = Date.now();

  console.log("Niveau du bot : " + niveau + "  |  " + parties + " parties par duel");
  console.log("Ordres jouables : " + JOUABLES.length + "  |  duels : "
    + (JOUABLES.length * (JOUABLES.length - 1) / 2) + "\n");

  const score = {}, duels = {};
  JOUABLES.forEach((o) => { score[o.key] = 0; duels[o.key] = 0; });

  for (let i = 0; i < JOUABLES.length; i++) {
    for (let j = i + 1; j < JOUABLES.length; j++) {
      const a = JOUABLES[i], b = JOUABLES[j];
      const taux = duel(a, b, parties, niveau);
      score[a.key] += taux; duels[a.key]++;
      score[b.key] += 1 - taux; duels[b.key]++;
    }
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  const classement = JOUABLES.map((o) => ({
    nom: o.name,
    cle: o.key,
    taux: score[o.key] / duels[o.key],
    somme: o.ranks.reduce((x, y) => x + y, 0),
  })).sort((x, y) => y.taux - x.taux);

  console.log("Ordre         victoires   somme des rangs");
  console.log("------------------------------------------");
  classement.forEach((c) => {
    const pct = (c.taux * 100).toFixed(1);
    const barre = "#".repeat(Math.round(c.taux * 30));
    console.log(c.nom.padEnd(13) + (pct + " %").padStart(7) + "   " + String(c.somme).padStart(2) + "  " + barre);
  });
  const ecart = (classement[0].taux - classement[classement.length - 1].taux) * 100;
  console.log("\nEcart du meilleur au moins bon : " + ecart.toFixed(1) + " points");
  console.log("Duree : " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
}

module.exports = { partie, duel, JOUABLES };
