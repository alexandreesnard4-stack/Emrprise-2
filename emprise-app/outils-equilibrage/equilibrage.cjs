// Mesure l'equilibrage des Ordres dans les conditions REELLES du jeu : un Commandant
// choisit DEUX Ordres differents. Une main de huit cartes du meme Ordre, comme dans un
// premier essai naif, exagere les capacites qui se cumulent (les Abysses se renforcent
// entre elles) et donne un classement qui ne ressemble a aucune partie jouee.
//
// Protocole : on tire des paires au hasard des deux cotes, on joue, et on attribue le
// resultat aux DEUX Ordres de chaque camp. Un Ordre fort tire vers le haut toutes les
// paires ou il figure, quel que soit son partenaire -- c'est ce signal qu'on cherche.
const { partie, JOUABLES } = require("./simuler.cjs");

function pairAuHasard(exclu) {
  const pool = JOUABLES.filter((o) => o.key !== (exclu && exclu.key));
  const a = pool[Math.floor(Math.random() * pool.length)];
  const reste = pool.filter((o) => o.key !== a.key);
  const b = reste[Math.floor(Math.random() * reste.length)];
  return [a, b];
}

const parties = Number(process.argv[2]) || 2000;
const niveau = process.argv[3] || "intermediaire";
const t0 = Date.now();

const vic = {}, jouees = {};
JOUABLES.forEach((o) => { vic[o.key] = 0; jouees[o.key] = 0; });
let premierGagne = 0;

for (let i = 0; i < parties; i++) {
  const bleu = pairAuHasard(), rouge = pairAuHasard();
  // Le camp qui commence alterne : sinon on mesurerait l'avantage du premier coup.
  const premier = i % 2 === 0 ? "blue" : "red";
  const v = partie(bleu, rouge, premier, niveau);
  if (v === premier) premierGagne++;
  for (const o of bleu) { jouees[o.key]++; if (v === "blue") vic[o.key]++; }
  for (const o of rouge) { jouees[o.key]++; if (v === "red") vic[o.key]++; }
}

const classement = JOUABLES.map((o) => ({
  nom: o.name,
  taux: jouees[o.key] ? vic[o.key] / jouees[o.key] : 0,
  n: jouees[o.key],
  somme: o.ranks.reduce((x, y) => x + y, 0),
  rangs: o.ranks.join("/"),
})).sort((x, y) => y.taux - x.taux);

console.log("Niveau du bot : " + niveau + "  |  " + parties + " parties  |  paires tirees au hasard\n");
console.log("Ordre          victoires    n     rangs     somme");
console.log("---------------------------------------------------");
classement.forEach((c) => {
  // Marge d'erreur a 95 % : on ne crie pas au desequilibre pour du bruit.
  const marge = 1.96 * Math.sqrt(c.taux * (1 - c.taux) / c.n) * 100;
  const pct = (c.taux * 100).toFixed(1);
  console.log(c.nom.padEnd(14) + (pct + " %").padStart(7) + " +-" + marge.toFixed(1)
    + String(c.n).padStart(6) + "   " + c.rangs.padEnd(10) + String(c.somme).padStart(2)
    + "  " + "#".repeat(Math.round(c.taux * 40)));
});

const ecart = (classement[0].taux - classement[classement.length - 1].taux) * 100;
console.log("\nEcart du meilleur au moins bon : " + ecart.toFixed(1) + " points");
console.log("Avantage du premier coup       : " + (premierGagne / parties * 100).toFixed(1) + " % (50 % = neutre)");
console.log("Duree : " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
