// Controle de la rotation de la boutique (01/09).
// Simule TROIS cycles complets sur les vraies fonctions du jeu, chargees par
// moteur.cjs : on n eprouve pas une copie du generateur, on eprouve celui qui
// tourne dans l application.
//
//   node outils-equilibrage/rotation.cjs
//
// Ce qu il verifie, famille par famille et cycle par cycle :
//   - exactement le quota d articles par jour ;
//   - aucun doublon a l interieur d une meme journee ;
//   - chaque article du catalogue passe AU MOINS une fois par cycle ;
//   - l ecart entre le plus vu et le moins vu ne depasse jamais 1.
const M = require("./moteur.cjs");

let ok = 0, ko = 0;
const T = (nom, cond) => { if (cond) { ok++; } else { ko++; console.log("  ECHEC  " + nom); } };

console.log("ROTATION DE LA BOUTIQUE : trois cycles complets\n");
console.log("Reference : " + new Date(M.BOUTIQUE_REFERENCE).toISOString());
console.log("Cycle     : " + M.BOUTIQUE_JOURS + " jours\n");

M.BOUTIQUE_FAMILLES.forEach((fam, index) => {
  const cat = fam.articles();
  console.log(fam.cle + " -- quota " + fam.quota + "/jour, catalogue de " + cat.length);
  if (!cat.length) { console.log("  (catalogue vide, rien a verifier)\n"); return; }

  for (let cycle = 0; cycle < 3; cycle++) {
    const tranches = M.tranchesBoutique(index, cycle);
    const passages = {};
    cat.forEach((a) => { passages[a.cle] = 0; });

    T("cycle " + cycle + " : huit journees", tranches.length === M.BOUTIQUE_JOURS);
    tranches.forEach((jour, j) => {
      T("cycle " + cycle + " jour " + j + " : " + fam.quota + " articles", jour.length === fam.quota);
      const cles = jour.map((a) => a.cle);
      T("cycle " + cycle + " jour " + j + " : aucun doublon", new Set(cles).size === cles.length);
      cles.forEach((c) => { passages[c] = (passages[c] || 0) + 1; });
    });

    const vus = Object.keys(passages).map((c) => passages[c]);
    const mini = Math.min(...vus), maxi = Math.max(...vus);
    T("cycle " + cycle + " : chaque article passe au moins une fois", mini >= 1);
    T("cycle " + cycle + " : ecart maximum de 1 entre le plus vu et le moins vu", maxi - mini <= 1);
    const oublies = Object.keys(passages).filter((c) => passages[c] === 0);
    console.log("  cycle " + cycle + " : passages de " + mini + " a " + maxi
      + (oublies.length ? "  OUBLIES : " + oublies.join(", ") : "  (aucun oubli)"));
  }
  console.log("");
});

// ---------- La bascule a 00:00 UTC ----------
console.log("La bascule des journees");
const jourDe = (iso) => M.jourAbsoluBoutique(Date.parse(iso));
T("le jour de reference est 0", jourDe("2026-09-01T00:00:00Z") === 0);
T("23:59 UTC le meme jour, toujours 0", jourDe("2026-09-01T23:59:59Z") === 0);
T("00:00 UTC le lendemain, 1", jourDe("2026-09-02T00:00:00Z") === 1);
T("avancer de 24 h avance d un jour", jourDe("2026-09-10T12:00:00Z") - jourDe("2026-09-09T12:00:00Z") === 1);
T("une horloge reglee AVANT la reference ne casse rien",
  [0, 1, 2, 3, 4, 5, 6, 7].includes(((jourDe("2026-08-20T12:00:00Z") % 8) + 8) % 8));

// La selection change bien d un jour a l autre.
const cles = (jour) => {
  const s = M.selectionBoutique(jour);
  return Object.keys(s).map((f) => s[f].map((a) => a.cle).join(",")).join("|");
};
let changements = 0;
for (let j = 0; j < 16; j++) if (cles(j) !== cles(j + 1)) changements += 1;
T("la selection change a chaque bascule (16 sur 16)", changements === 16);

// ---------- Le minuteur ----------
console.log("\nLe minuteur");
const reste = M.resteAvantRotation(Date.parse("2026-09-01T18:00:00Z"));
T("a 18:00 UTC, il reste six heures", reste === 6 * 3600000);
T("il ne depasse jamais 24 h et n est jamais negatif",
  [0, 1, 7, 23].every((h) => {
    const r = M.resteAvantRotation(Date.parse("2026-09-03T0" + (h % 10) + ":00:00Z"));
    return r > 0 && r <= 86400000;
  }));

console.log("\n---- " + ok + " verifications reussies, " + ko + " echec(s) ----");
process.exit(ko ? 1 : 0);
