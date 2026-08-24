// La Reserve : chaque Commandant choisit AVANT la partie les deux cartes qu'il jouera
// en cas d'egalite parfaite. Idee d'Alexandre, et elle repond a la vraie objection --
// la mort subite tirait une carte au sort, donc le hasard tranchait le moment le plus
// tendu du duel. Ici, plus rien n'est tire : on savait depuis le debut ce qu'on aurait.
//
// Reste une question que seule la mesure tranche : quand les deux camps arrivent avec
// leurs MEILLEURES cartes au lieu de cartes au hasard, le departage reste-t-il neutre ?
// Une reserve forte des deux cotes pourrait tres bien profiter systematiquement a celui
// qui pose en dernier -- c'est ce qui avait tue le departage aux captures.
//
// Deux formes de reserve, qui n'ont pas du tout le meme poids :
//   cadeau  les deux cartes s'ajoutent a la main de huit. Aucun cout : on prend ses deux
//           meilleures, il n'y a rien a reflechir.
//   prelevee la main est tiree a dix, on en met deux de cote : reserver ses deux meilleures
//           cartes AFFAIBLIT le jeu principal. C'est la seule version ou le choix pese.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const r = JOUABLES.filter((o) => o.key !== a.key);
  return [a, r[Math.floor(Math.random() * r.length)]];
}
const force = (c) => c.top + c.right + c.bottom + c.left;

function partie(niveau, forme) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const paires = { blue: pairAuHasard(), red: pairAuHasard() };
  const mains = {}, reserves = {};

  for (const camp of ["blue", "red"]) {
    if (forme === "prelevee") {
      // Dix cartes : les huit qu'on joue, les deux qu'on garde. Un joueur reserve
      // naturellement ses deux plus fortes -- et se prive donc d'elles en partie.
      const dix = m.makeHand(...paires[camp]).concat(m.makeHand(...paires[camp]).slice(0, 2));
      dix.sort((a, b) => force(b) - force(a));
      reserves[camp] = dix.slice(0, 2).map((c, i) => ({ ...c, id: "res-" + camp + i }));
      mains[camp] = dix.slice(2);
    } else {
      // La reserve s'ajoute : la main de huit reste intacte.
      mains[camp] = m.makeHand(...paires[camp]);
      const rab = m.makeHand(...paires[camp]).sort((a, b) => force(b) - force(a));
      reserves[camp] = rab.slice(0, 2).map((c, i) => ({ ...c, id: "res-" + camp + i }));
    }
  }

  const poser = (camp, main) => {
    if (!main.length) return;
    const adverse = mains[camp === "blue" ? "red" : "blue"];
    const choix = m.botChooseMove(plateau, main, adverse, camp,
      camp === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) return;
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: camp };
    const res = m.resolvePlacement(plateau, choix.cellIdx, camp, poison);
    plateau = res.board; poison = res.poisonedCells || poison;
    main.splice(choix.cardIdx, 1);
  };

  let tour = premier;
  for (let c = 0; c < 16; c++) { poser(tour, mains[tour]); tour = tour === "blue" ? "red" : "blue"; }

  const compte = () => {
    const n = { blue: 0, red: 0 };
    plateau.forEach((x) => { if (x) n[x.owner]++; });
    return { p: n[premier] + 2, s: n[second] };
  };

  let { p, s } = compte();
  let rondes = 0;
  while (p === s && rondes < 2 && plateau.filter((x) => !x).length >= 2) {
    const carteP = reserves[premier][rondes], carteS = reserves[second][rondes];
    if (!carteP || !carteS) break;
    poser(premier, [carteP]);
    poser(second, [carteS]);
    rondes++;
    ({ p, s } = compte());
  }
  return { gagnant: p === s ? "second" : p > s ? "premier" : "second", rondes };
}

const N = Number(process.argv[2]) || 4000;
const niveaux = (process.argv[3] || "intermediaire").split(",");

console.log(N + " parties par case\n");
const entete = "Forme de reserve  ".padEnd(20) + niveaux.map((x) => x.padStart(15)).join("");
console.log(entete);
console.log("-".repeat(entete.length));
for (const forme of ["cadeau", "prelevee"]) {
  let ligne = forme.padEnd(20);
  for (const niveau of niveaux) {
    let prem = 0, dep = 0;
    for (let i = 0; i < N; i++) {
      const r = partie(niveau, forme);
      if (r.gagnant === "premier") prem++;
      if (r.rondes > 0) dep++;
    }
    const pct = prem / N * 100;
    ligne += (pct.toFixed(1) + " %" + (Math.abs(pct - 50) < 2.5 ? " *" : "  ")).padStart(15);
  }
  console.log(ligne);
}
console.log("\n* = entre 47,5 et 52,5 %, donc equitable");
