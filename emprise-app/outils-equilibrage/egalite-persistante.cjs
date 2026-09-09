// Mesure : a quelle frequence l'egalite TIENT ENCORE apres les deux rondes de Mort Subite
// (le "nul" vu par Alexandre), et ce que donneraient les departages candidats.
const m = require("./moteur.cjs");
const { JOUABLES } = require("./simuler.cjs");
const force = (c) => (c.top||0)+(c.right||0)+(c.bottom||0)+(c.left||0);
function pairAuHasard() {
  const a = JOUABLES[Math.floor(Math.random() * JOUABLES.length)];
  const r = JOUABLES.filter((o) => o.key !== a.key);
  return [a, r[Math.floor(Math.random() * r.length)]];
}
// La vraie regle du jeu : une carte par Ordre, la plus forte, en plus de la main.
function reserveAutomatique(main) {
  const parOrdre = new Map();
  for (const c of main) { const t = parOrdre.get(c.ability); if (!t || force(c) > force(t)) parOrdre.set(c.ability, c); }
  return [...parOrdre.values()].sort((a,b)=>force(b)-force(a)).slice(0,2).map((c,i)=>({...c, id: c.id+"-reserve-"+i}));
}
function partie(niveau) {
  m.setBoardSize(4, 5);
  let plateau = Array(m.CELLS).fill(null);
  let poison = Array(m.CELLS).fill(false);
  const premier = Math.random() < 0.5 ? "blue" : "red";
  const second = premier === "blue" ? "red" : "blue";
  const paires = { blue: pairAuHasard(), red: pairAuHasard() };
  const mains = { blue: m.makeHand(...paires.blue), red: m.makeHand(...paires.red) };
  const reserves = { blue: reserveAutomatique(m.makeHand(...paires.blue)), red: reserveAutomatique(m.makeHand(...paires.red)) };
  const captures = { blue: 0, red: 0 };
  const poser = (camp, main) => {
    if (!main.length) return;
    const adverse = mains[camp === "blue" ? "red" : "blue"];
    const choix = m.botChooseMove(plateau, main, adverse, camp, camp === "blue" ? "red" : "blue", niveau, poison);
    if (!choix) return;
    const avant = plateau.filter((x) => x && x.owner === camp).length;
    plateau = plateau.slice();
    plateau[choix.cellIdx] = { ...main[choix.cardIdx], owner: camp };
    const res = m.resolvePlacement(plateau, choix.cellIdx, camp, poison);
    plateau = res.board; poison = res.poisonedCells || poison;
    captures[camp] += plateau.filter((x) => x && x.owner === camp).length - avant - 1;
    main.splice(choix.cardIdx, 1);
  };
  let tour = premier;
  for (let c = 0; c < 16; c++) { poser(tour, mains[tour]); tour = tour === "blue" ? "red" : "blue"; }
  const compte = (bonus) => { const n = { blue: 0, red: 0 }; plateau.forEach((x) => { if (x) n[x.owner]++; }); return { p: n[premier] + bonus, s: n[second] }; };
  let { p, s } = compte(2);
  const out = { ms: false, egalApres1: false, egalApres2: false, gagnant: null, gagnantSiPlus1: null };
  if (p === s) {
    out.ms = true;
    poser(premier, [reserves[premier][0]]); poser(second, [reserves[second][0]]);
    ({ p, s } = compte(2));
    const v = compte(1); out.gagnantSiPlus1 = v.p > v.s ? "premier" : "second";
    if (p === s) {
      out.egalApres1 = true;
      poser(premier, [reserves[premier][1]]); poser(second, [reserves[second][1]]);
      ({ p, s } = compte(2));
      if (p === s) out.egalApres2 = true;
    }
  }
  out.gagnant = p === s ? "second" : p > s ? "premier" : "second";
  let fP = 0, fS = 0; plateau.forEach((x) => { if (x) (x.owner === premier ? fP += force(x) : fS += force(x)); });
  out.forceP = fP; out.forceS = fS; out.resP = reserves[premier].reduce((a,c)=>a+force(c),0); out.resS = reserves[second].reduce((a,c)=>a+force(c),0); out.capP = captures[premier]; out.capS = captures[second];
  return out;
}
const N = Number(process.argv[2]) || 4000, niveau = process.argv[3] || "intermediaire";
const t0 = Date.now();
let prem = 0, ms = 0, e1 = 0, e2 = 0, premMs = 0, premPlus1 = 0;
let forceP = 0, forceS = 0, forceEgal = 0, capP = 0, capS = 0, capEgal = 0, rP = 0, rS = 0, rE = 0;
for (let i = 0; i < N; i++) {
  const r = partie(niveau);
  if (r.gagnant === "premier") prem++;
  if (r.ms) { ms++; if (r.gagnant === "premier") premMs++; if (r.gagnantSiPlus1 === "premier") premPlus1++; }
  if (r.egalApres1) e1++;
  if (r.egalApres2) { e2++;
    if (r.forceP > r.forceS) forceP++; else if (r.forceS > r.forceP) forceS++; else forceEgal++;
    if (r.capP > r.capS) capP++; else if (r.capS > r.capP) capS++; else capEgal++;
    if (r.resP > r.resS) rP++; else if (r.resS > r.resP) rS++; else rE++;
  }
}
const pc = (a, b) => (b ? (a / b * 100).toFixed(1) : "-") + " %";
console.log(`Niveau ${niveau} | ${N} parties | ${((Date.now()-t0)/1000).toFixed(0)} s`);
console.log(`Celui qui commence gagne (regle actuelle)  : ${pc(prem, N)}`);
console.log(`Parties en Mort Subite                     : ${pc(ms, N)}  (${ms})`);
console.log(`  encore egal apres la ronde 1             : ${pc(e1, N)}  (${e1}, soit ${pc(e1, ms)} des Mort Subite)`);
console.log(`  encore egal apres la ronde 2 = "nul"     : ${pc(e2, N)}  (${e2}, soit ${pc(e2, ms)} des Mort Subite)`);
console.log(`Dans les Mort Subite, le premier gagne     : ${pc(premMs, ms)} (regle actuelle, nul -> second)`);
console.log(`  variante +1 pendant la Mort Subite       : ${pc(premPlus1, ms)} (tranche des la ronde 1)`);
console.log(`Sur les ${e2} nuls : departage a la force des cartes -> premier ${forceP}, second ${forceS}, egal ${forceEgal}`);
console.log(`Sur les ${e2} nuls : departage aux captures          -> premier ${capP}, second ${capS}, egal ${capEgal}`);
console.log(`Sur les ${e2} nuls : Reserve la plus forte              -> premier ${rP}, second ${rS}, egal ${rE}`);
