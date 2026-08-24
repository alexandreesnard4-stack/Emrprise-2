// Corriger le handicap du premier coup SANS hasard et SANS phase supplementaire :
// en changeant l'ORDRE DES TOURS.
//
// Le probleme tient a une seule chose : en alternance stricte, c'est toujours le SECOND
// qui pose la seizieme carte, en sachant tout. Le dernier mot lui revient a chaque partie.
//
// La parade est connue des jeux de tirage : au lieu de A B A B A B..., on utilise un ordre
// qui rend le dernier mot moins systematique. Chacun pose toujours ses huit cartes, aucune
// regle de score ne change, aucune carte n'est tiree au sort en plus.
//
//   stricte     A B A B A B A B A B A B A B A B   (aujourd'hui)
//   serpent     A B B A A B B A A B B A A B B A   (le premier finit)
//   thue-morse  A B B A B A A B B A A B A B B A   (la suite qui equilibre les tirages)
//   miroir      A B B A B A A B  B A A B A B B A  (thue-morse, autre depart)
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");

const ORDRES = {
  stricte:  "ABABABABABABABAB",
  serpent:  "ABBAABBAABBAABBA",
  "thue-morse": "ABBABAABBAABABBA",
  inverse:  "BAABABBAABBABAAB",
};

function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const r = JOUABLES.filter((o) => o.key !== a.key);
  return [a, r[Math.floor(Math.random() * r.length)]];
}

function partie(sequence, niveau, bonus) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const mains = { blue: m.makeHand(...pairAuHasard()), red: m.makeHand(...pairAuHasard()) };

  for (const lettre of sequence) {
    const camp = lettre === "A" ? premier : second;
    const main = mains[camp];
    if (!main.length) continue;
    const adverse = mains[camp === "blue" ? "red" : "blue"];
    const choix = m.botChooseMove(plateau, main, adverse, camp,
      camp === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) continue;
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: camp };
    const res = m.resolvePlacement(plateau, choix.cellIdx, camp, poison);
    plateau = res.board; poison = res.poisonedCells || poison;
    main.splice(choix.cardIdx, 1);
  }

  const n = { blue: 0, red: 0 };
  plateau.forEach((c) => { if (c) n[c.owner]++; });
  return n[premier] + bonus > n[second] ? "premier" : "second";
}

const N = Number(process.argv[2]) || 3000;
const niveaux = (process.argv[3] || "intermediaire").split(",");
const bonus = Number(process.argv[4] ?? 1);

console.log("Bonus au premier : +" + bonus + "  |  " + N + " parties par case\n");
const entete = "Ordre des tours ".padEnd(18) + niveaux.map((x) => x.padStart(14)).join("");
console.log(entete);
console.log("-".repeat(entete.length));

for (const [nom, seq] of Object.entries(ORDRES)) {
  // Chacun doit poser exactement huit cartes, sinon on ne compare plus rien.
  const a = (seq.match(/A/g) || []).length, b = (seq.match(/B/g) || []).length;
  let ligne = (nom + (a === 8 && b === 8 ? "" : " (!" + a + "/" + b + ")")).padEnd(18);
  for (const niveau of niveaux) {
    let p = 0;
    for (let i = 0; i < N; i++) if (partie(seq, niveau, bonus) === "premier") p++;
    const pct = p / N * 100;
    const juste = Math.abs(pct - 50) < 2.5;
    ligne += (pct.toFixed(1) + " %" + (juste ? " *" : "  ")).padStart(14);
  }
  console.log(ligne);
}
console.log("\n* = entre 47,5 et 52,5 %, donc equitable");
console.log("Dernier a poser : stricte -> le second ; serpent -> le premier ;");
console.log("thue-morse -> le premier ; inverse -> le second.");
