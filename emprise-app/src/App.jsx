import React, { useState, useRef, useEffect, useMemo, memo } from "react";
import { db, auth } from "./firebase.js";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import {
  doc, getDoc, updateDoc, onSnapshot, serverTimestamp, runTransaction, arrayUnion,
} from "firebase/firestore";

// ---------- Multijoueur : code de partie à 5 lettres (sans caractères ambigus) ----------
function makeGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Sièges du tournoi en ligne : chaque place d'arrivée reçoit un alias et le portrait
// d'un Ordre — comme les adversaires nommés du tournoi solo, mais pour de vrais joueurs
// sans compte ni pseudo. Le joueur se reconnaît à la mention "Vous" sur sa plaque.
const SIEGES_TOURNOI = [
  { nom: "Le Doré", key: "eveil" },
  { nom: "Le Ressac", key: "maudits" },
  { nom: "La Vermine", key: "poison" },
  { nom: "L'Abysse", key: "devoreuse" },
  { nom: "Le Copiste", key: "scribes" },
  { nom: "La Mue", key: "mue" },
  { nom: "La Lance", key: "percee" },
  { nom: "Le Rempart", key: "guardian" },
];

// ---------- Board config ----------
// ROWS/COLS/CELLS sont volontairement mutables (pas des const) : le mode test utilise un
// plateau plus grand (6x6). setBoardSize() les change ensemble ; tous les autres modes
// repassent systématiquement par la taille standard à chaque sélection de mode.
let ROWS = 4;
let COLS = 5;
let CELLS = ROWS * COLS; // 20 cases en standard
const STANDARD_ROWS = 4, STANDARD_COLS = 5;
const TEST_ROWS = 6, TEST_COLS = 6; // 36 cases, uniquement en mode test
function setBoardSize(rows, cols) { ROWS = rows; COLS = cols; CELLS = rows * cols; }

const PORTRAITS = {
  eveil: "/portraits/eveil.jpg",
  fureur: "/portraits/fureur.jpg",
  percee: "/portraits/percee.jpg",
  portee: "/portraits/portee.jpg",
  devoreuse: "/portraits/devoreuse.jpg",
  mue: "/portraits/mue.jpg",
  poison: "/portraits/poison.jpg",
  guardian: "/portraits/guardian.jpg",
  scribe: "/portraits/scribe.jpg",
  maudit: "/portraits/maudit.jpg",
};

// ---------- Order data (EMPRISE) ----------
// `portrait` peut recevoir une URL d'image plus tard ; vide = icône affichée à la place
// L'ordre des rangs dans `ranks` est TOUJOURS [haut, gauche, droite, bas] — voir
// makeOrderQuad plus bas, qui déstructure exactement dans cet ordre : [t, l, r, b].
// À respecter pour tout nouvel Ordre, sous peine de rangs qui apparaissent
// du mauvais côté de la carte.
// status : "disponible" (jouable normalement) ou "prochainement" (visible dans les
// écrans de sélection mais grisé, non cliquable, et exclu de tous les tirages
// aléatoires — bot, draft Confluence, tournoi). Sert à teaser un futur Ordre sans
// qu'il ne puisse être choisi ou distribué avant d'être vraiment prêt.
const ORDER_STATUS = { AVAILABLE: "disponible", COMING_SOON: "prochainement" };

// Date de sortie prévue du prochain Ordre (30 jours après son annonce) — à mettre à
// jour manuellement quand un nouvel Ordre est planifié, pour garder le décompte honnête.
const NEXT_ORDER_RELEASE = new Date("2026-09-01T00:00:00");

// ⚠️ PIÈGE : trois Ordres ont une CLÉ différente de leur NOM DE CAPACITÉ.
//    cendres → attraction   |   scribes → scribe   |   maudits → maudit
// Pour tout ce qui touche au moteur (resolvePlacement, capacités, effets), c'est
// TOUJOURS `ability` qu'il faut comparer, jamais `key`. Un test s'est déjà trompé
// à cause de ça et a conclu à tort qu'un Héraut ne faisait rien.
const ORDERS = [
  { key: "eveil", ability: "eveil", name: "Dorés", icon: "✨", portrait: PORTRAITS.eveil, ranks: [2, 6, 5, 7], status: ORDER_STATUS.AVAILABLE, desc: "Échange son rang exposé avec celui de chaque ennemie adjacente" },
  { key: "cendres", ability: "attraction", name: "Cendres", icon: "🔥", portrait: PORTRAITS.fureur, ranks: [6, 4, 5, 3], status: ORDER_STATUS.AVAILABLE, desc: "Attire la carte la plus proche de chaque côté, alliée ou ennemie" },
  { key: "percee", ability: "percee", name: "Piques", icon: "🗡️", portrait: PORTRAITS.percee, ranks: [6, 5, 4, 6], status: ORDER_STATUS.AVAILABLE, desc: "Transperce les cartes alignées par direction" },
  { key: "portee", ability: "portee", name: "Archers", icon: "🏹", portrait: PORTRAITS.portee, ranks: [9, 6, 4, 1], status: ORDER_STATUS.AVAILABLE, desc: "Capture en ligne droite, même à distance" },
  { key: "devoreuse", ability: "devoreuse", name: "Abysses", icon: "🐙", portrait: PORTRAITS.devoreuse, ranks: [6, 5, 3, 2], status: ORDER_STATUS.AVAILABLE, desc: "Chaque Abysse en jeu renforce les autres de +1" },
  { key: "mue", ability: "mue", name: "Chimères", icon: "🌀", portrait: PORTRAITS.mue, ranks: [4, 6, 5, 5], status: ORDER_STATUS.AVAILABLE, desc: "Retourne le rang de chaque ennemie adjacente sur son axe" },
  { key: "poison", ability: "poison", name: "Pestiférés", icon: "☠️", portrait: PORTRAITS.poison, ranks: [7, 5, 6, 2], status: ORDER_STATUS.AVAILABLE, desc: "Empoisonne les 4 cases voisines : -1 sur tous les rangs" },
  { key: "guardian", ability: "guardian", name: "Gardiens", icon: "🛡️", portrait: PORTRAITS.guardian, ranks: [6, 6, 5, 5], status: ORDER_STATUS.AVAILABLE, desc: "+1 sur le rang attaqué, le temps du combat" },
  { key: "scribes", ability: "scribe", name: "Scribes", icon: "👁️", portrait: PORTRAITS.scribe, ranks: [4, 6, 5, 8], status: ORDER_STATUS.AVAILABLE, desc: "Rangs cachés en main, puis 1 tour après la pose" },
  { key: "maudits", ability: "maudit", name: "Maudits", icon: "🩸", portrait: PORTRAITS.maudit, ranks: [8, 6, 4, 2], status: ORDER_STATUS.AVAILABLE, desc: "Gagne +1 permanent sur ses 4 rangs à chaque capture subie" },
  // Portrait temporaire (réutilise celui des Maudits, méconnaissable une fois flouté/grisé
  // par le style "prochainement") — à remplacer par le vrai art et le vrai nom dès qu'ils
  // sont prêts. Nom volontairement non révélé pour l'instant (teaser).
  // Le prochain Ordre à sortir. Son identité reste masquée ("???") jusqu'au jour J : seuls
  // la clé et la capacité révèlent qu'il s'agit des Geôliers. Le drapeau essai:true le rend
  // jouable en bac à sable pour les essais, sans le sortir dans les autres modes.
  // Le jour de la sortie : passer status à AVAILABLE, retirer essai et releaseDate,
  // remplacer name/icon/desc par ceux des Geôliers, et remplacer le portrait verrouillé
  // Une seule image suffit : geolier.jpg est le portrait NORMAL, le teasing est fait
  // les deux fichiers sont déjà dans public/portraits/.
  { key: "geolier", ability: "geolier", name: "???", icon: "📦", portrait: "/portraits/geolier_verrou.jpg", ranks: [7, 5, 5, 3], status: ORDER_STATUS.COMING_SOON, releaseDate: NEXT_ORDER_RELEASE, essai: true, desc: "Prochain Ordre à rejoindre EMPRISE." },
];

// Petit utilitaire réutilisé partout où un Ordre "prochainement" doit être écarté
// (tirages aléatoires, draft, tournoi) — un Ordre sans status explicite est traité
// comme disponible, pour rester compatible si status venait à manquer quelque part.
function isOrderAvailable(order) {
  return order.status !== ORDER_STATUS.COMING_SOON;
}

// Le roster réellement jouable : tout ORDERS sauf les Ordres "prochainement".
// À utiliser partout où l'on distribue le roster complet (Confluence, bac à sable,
// tirage au hasard) pour qu'un Ordre non sorti n'arrive jamais en main.
const AVAILABLE_ORDERS = ORDERS.filter(isOrderAvailable);

// Candidats en cours d'évaluation : jouables en bac à sable seulement. Ils sont exclus
// d'AVAILABLE_ORDERS (statut "prochainement") et masqués des écrans de sélection, pour
// ne pas polluer les parties normales, la Confluence, le tournoi ni le mode Histoire.
const ORDRES_A_L_ESSAI = ORDERS.filter((o) => o.essai === true);

// Vrai décompte en direct (jours/heures/minutes/secondes) pour un Ordre
// "prochainement" avec une date de sortie prévue — se met à jour chaque
// seconde tant que la carte est affichée, via son propre petit minuteur.
function CountdownLabel({ order }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!order.releaseDate) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [order.releaseDate]);

  if (!order.releaseDate) return "Ordre encore scellé par la Faille, son heure viendra.";
  const diffMs = order.releaseDate - now;
  if (diffMs <= 0) return "Prochainement, son heure est presque venue...";
  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `Prochainement : ${days}j ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}


// Vignette d'un Ordre "prochainement". Le portrait réel n'est pas une image
// pré-assombrie : c'est le vrai portrait, poussé au contraste par CSS jusqu'à ne
// laisser qu'une gravure. Une aura respire derrière lui, un balayage lumineux le
// traverse au survol. Sur mobile :hover n'existe pas, d'où l'état "peek"
// déclenché au toucher et relâché après 1,1 s.
// Le jour de la sortie, il suffit de passer status à AVAILABLE : le teaser, le
// cadenas et le compte à rebours disparaissent d'eux-mêmes, le portrait
// s'affiche en clair. Aucune image à remplacer.
// Fait defiler les textes d'attente. Une seule animation, sur opacity et transform,
// relancee a chaque changement par la cle React : rien ne tourne en boucle.
function RecitsAttente({ actif, surImage }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * RECITS_ATTENTE.length));
  useEffect(() => {
    if (!actif) return;
    // 13 secondes : le temps de lire une phrase de trois lignes sans se sentir presse,
    // et de la relire si le regard etait ailleurs. A 7 secondes, le texte partait avant
    // d'avoir ete lu.
    const t = setInterval(() => setI((n) => (n + 1) % RECITS_ATTENTE.length), 13000);
    return () => clearInterval(t);
  }, [actif]);
  if (!actif) return null;
  const recit = RECITS_ATTENTE[i];
  return (
    <div className={`recit-attente ${surImage ? "sur-image" : ""}`} role="status" aria-live="polite">
      <div className="recit-genre">{recit.genre === "histoire" ? "L'Histoire" : "Astuce"}</div>
      <p key={i} className="recit-texte">{recit.texte}</p>
    </div>
  );
}

// Portrait d'un Ordre dont la couleur monte comme une maree, a la hauteur de la maitrise.
// Deux couches : le portrait grise en dessous, le portrait en couleur par-dessus, decoupe
// a la hauteur voulue avec une crete ondulee qui derive sans fin. Un voile de la couleur
// de l'Ordre teinte la partie remplie, pour que la vague soit bien LA couleur de la carte.
// Le niveau monte depuis zero a l'apparition : on voit la maree arriver.
function VagueMaitrise({ order, taux, grand }) {
  const [niveau, setNiveau] = useState(0);
  const [cote, setCote] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => setNiveau(taux), 60);
    return () => clearTimeout(t);
  }, [taux]);
  // Le portrait couleur doit mesurer la carte entiere : on lit sa hauteur et on la suit
  // si la fenetre change.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // clientHeight : l interieur du cadre, bordure exclue — c est la que vivent les
    // portraits. La HAUTEUR et non la largeur : la carte n est plus toujours carree (le
    // detail l affiche en 3/4), et c est la hauteur que le portrait couleur doit epouser.
    const lire = () => setCote(el.clientHeight);
    lire();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(lire) : null;
    if (ro) ro.observe(el);
    return () => { if (ro) ro.disconnect(); };
  }, []);
  const couleur = MAITRISE_COULEURS[order.key] || "rgba(203,164,86,0.8)";
  // Une seule partie vaut deja une lame d'eau visible : a 1 % on ne voyait rien. Et a
  // 100 %, la crete passe AU-DESSUS du cadre : le portrait est entierement en couleur,
  // sans bande grise ni vague qui derive en haut d'un Ordre pourtant acheve.
  const plein = niveau >= 1;
  const hauteur = niveau === 0 ? 0 : plein ? 130 : Math.max(6, Math.round(niveau * 100));
  return (
    <div ref={ref} className={`vague-maitrise ${grand ? "grand" : ""} ${taux === 0 ? "vide" : ""} ${plein ? "pleine" : ""}`}
         style={{ "--vague-couleur": couleur, "--vague-cote": cote ? `${cote}px` : "100%" }}>
      <img className="vague-gris" src={order.portrait} alt="" />
      <div className="vague-pleine" style={{ height: `${hauteur}%` }}>
        <img className="vague-couleur" src={order.portrait} alt="" />
        <div className="vague-teinte" />
      </div>
    </div>
  );
}

function ComingSoonThumb({ order }) {
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(null);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const revealBriefly = () => {
    setPeek(true);
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 1100);
  };
  return (
    <div
      className={`order-thumb-wrap teaser-wrap ${peek ? "teaser-peek" : ""}`}
      onPointerDown={revealBriefly}
    >
      <div className="teaser-aura" />
      <img className="thumb thumb-teaser" src={order.portrait} alt={order.name} />
      <div className="teaser-scan" />
      <div className="lock-chip">
        <svg className="lock-icon" viewBox="0 0 24 24" fill="none">
          <path d="M6 10V7a6 6 0 0112 0v3" stroke="var(--gold-bright)" strokeWidth="2" strokeLinecap="round" fill="none" />
          <rect x="4" y="10" width="16" height="12" rx="2.5" fill="var(--gold-bright)" stroke="var(--gold)" strokeWidth="1" />
          <circle cx="12" cy="15" r="1.7" fill="#1b2138" />
          <rect x="11" y="16" width="2" height="3.5" rx="1" fill="#1b2138" />
        </svg>
      </div>
    </div>
  );
}

const TURN_SECONDS = 105; // durée du minuteur par tour (1 min 45)
// Minuteur du choix des Ordres, en ligne uniquement : sans lui, un joueur qui pose son
// telephone bloque l'autre sur un ecran d'attente. A l'echeance, la selection en cours
// est confirmee ; si elle est incomplete, deux Ordres sont tires au sort.
const ORDRES_SECONDS = 60;
// Passé de 60 à 105 s avec la main en éventail : les cartes ne sont plus toutes visibles
// d'un coup, il faut déployer chaque Ordre pour lire ses rangs avant de choisir. Une
// minute ne suffisait plus pour comparer sereinement.
const DRAFT_SECONDS = 15; // durée du minuteur par choix, en draft Confluence

// ---------- Tutoriel interactif ----------
function tc(top, right, bottom, left, opts = {}) {
  return {
    id: `tut-${top}-${right}-${bottom}-${left}-${Math.random().toString(36).slice(2, 7)}`,
    name: opts.name || "Recrue",
    icon: opts.icon || "⚔️",
    portrait: opts.portrait || "",
    orderKey: opts.orderKey || "",
    ability: opts.ability || "none",
    top, right, bottom, left,
    baseTop: top, baseRight: right, baseBottom: bottom, baseLeft: left,
  };
}

const TUTORIAL_STEPS = [
  {
    kind: "info",
    title: "Bienvenue dans EMPRISE",
    text: "Apprenons les bases en quelques coups. Chaque carte a 4 rangs : haut, droite, bas, gauche. Pour capturer une carte adverse adjacente, votre rang doit être supérieur au rang opposé de l'adversaire.",
  },
  {
    kind: "play",
    title: "Capture de base",
    text: "Placez votre carte sur la case qui brille, à gauche de la carte ennemie. Votre rang droit (8) est supérieur au rang gauche adverse (2) : vous allez la capturer.",
    requiredCell: 7,
    handCard: tc(3, 8, 3, 3, { name: "Dorés", icon: ORDERS.find((l) => l.key === "eveil").icon, portrait: ORDERS.find((l) => l.key === "eveil").portrait }),
    board: (() => {
      const b = Array(CELLS).fill(null);
      b[8] = { ...tc(4, 4, 4, 2, { name: "Cendres", icon: ORDERS.find((l) => l.key === "cendres").icon, portrait: ORDERS.find((l) => l.key === "cendres").portrait }), owner: "red" };
      return b;
    })(),
    after: "Bravo ! Votre rang droit (8) était supérieur au rang gauche adverse (2), donc vous l'avez capturée.",
  },
  {
    kind: "play",
    title: "Résonance et Onde",
    text: "Si 2 de vos rangs ou plus répondent à ceux des cartes voisines, les vôtres comptent aussi, toutes les ennemies concernées sont capturées d'un coup : c'est la Résonance. Et si une carte ainsi capturée peut à son tour en capturer une autre, ça continue en chaîne : c'est une Onde. Placez votre carte pour voir les deux à l'œuvre.",
    requiredCell: 7,
    handCard: tc(5, 6, 3, 3, { name: "Dorés", icon: ORDERS.find((l) => l.key === "eveil").icon, portrait: ORDERS.find((l) => l.key === "eveil").portrait }),
    board: (() => {
      const b = Array(CELLS).fill(null);
      b[2] = { ...tc(4, 7, 5, 4, { name: "Cendres", icon: ORDERS.find((l) => l.key === "cendres").icon, portrait: ORDERS.find((l) => l.key === "cendres").portrait }), owner: "red" };
      b[3] = { ...tc(3, 3, 3, 2, { name: "Cendres", icon: ORDERS.find((l) => l.key === "cendres").icon, portrait: ORDERS.find((l) => l.key === "cendres").portrait }), owner: "red" };
      b[8] = { ...tc(3, 3, 3, 6, { name: "Cendres", icon: ORDERS.find((l) => l.key === "cendres").icon, portrait: ORDERS.find((l) => l.key === "cendres").portrait }), owner: "red" };
      return b;
    })(),
    after: "Vous avez capturé 2 cartes d'un coup grâce à la Résonance (2 rangs identiques), puis une 3ème automatiquement grâce à l'Onde !",
  },
  {
    kind: "play",
    title: "Les capacités des Ordres",
    text: "Chaque Ordre a une capacité unique. Voici Portée (Archers) : elle peut capturer une carte même si elle n'est pas juste à côté.",
    requiredCell: 7,
    handCard: tc(3, 7, 3, 3, { name: "Archers", ability: "portee", icon: ORDERS.find((l) => l.key === "portee").icon, portrait: ORDERS.find((l) => l.key === "portee").portrait }),
    board: (() => {
      const b = Array(CELLS).fill(null);
      b[9] = { ...tc(3, 3, 3, 3, { name: "Cendres", icon: ORDERS.find((l) => l.key === "cendres").icon, portrait: ORDERS.find((l) => l.key === "cendres").portrait }), owner: "red" };
      return b;
    })(),
    after: "Portée a capturé une carte à distance, sans qu'aucune carte adverse ne soit adjacente entre les deux !",
  },
  {
    kind: "info",
    title: "Vous êtes prêt !",
    text: "C'est tout ce qu'il faut savoir pour commencer. Chaque Ordre a sa propre capacité, vous les découvrirez en jouant. Bonne chance, Commandant.",
  },
];

const DIFFICULTIES = [
  { key: "debutant", label: "Novice", desc: "Coups aléatoires" },
  { key: "intermediaire", label: "Combattant", desc: "Cherche la capture immédiate la plus rentable" },
  { key: "avance", label: "Vétéran", desc: "Capture et évite de s'exposer" },
  { key: "expert", label: "Seigneur de Guerre", desc: "Anticipe votre meilleure réponse" },
];

const rankLabel = (n) => (n >= 10 ? "A" : String(n));

// Qui commence la partie, tiré au sort. L'audit v6 a mesuré en miroir strict que le
// SECOND joueur gagne jusqu'à +13 points au niveau Seigneur de Guerre : avec seize
// cartes, il pose la dernière et capture sans riposte possible. Donner systématiquement
// le premier coup à Azur désavantageait donc le joueur dans tous les modes, et les huit
// combats de fin de chapitre cumulaient l'IA la plus dure ET ce désavantage.
// La compensation par le score a été testée et s'est révélée impuissante : le total posé
// étant pair, +1 et +2 donnent exactement le même résultat, et +3 fait basculer à 70%.
// Le seul correctif viable est structurel — d'où ce tirage.
// ⚠️ En ligne, ce tirage doit être fait UNE SEULE FOIS par l'hôte et écrit dans Firestore.
// Si chaque client tirait de son côté, les deux parties se désynchroniseraient.
const tirerPremierJoueur = () => (Math.random() < 0.5 ? "blue" : "red");

// Accessibilité : plusieurs éléments cliquables sont des <div>, pas des <button>.
// Sans ça ils sont invisibles au clavier et aux lecteurs d'écran. Ce helper rejoue
// l'action sur Entrée ou Espace, comme le ferait un vrai bouton. Il tolère un
// gestionnaire absent (cas des éléments désactivés).
const KEY_ACTIVATE = (fn) => (e) => {
  if (!fn) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(e); }
};
// Le portrait de Gardiens (armure noire) est plus sombre que les autres à cette petite
// taille : on lui donne un léger coup de projecteur pour rester lisible.
// Les quatre cartes d'un meme Ordre partagent un seul portrait : cote a cote sur le
// plateau, elles se lisaient comme du papier peint plutot que comme quatre combattants.
// On decale legerement le cadrage et la temperature selon l'ORIENTATION de la carte
// (chacune des quatre a la sienne) : jamais deux identiques voisines, sans toucher aux
// images. Les ecarts sont faibles a dessein — de pres on ne sait pas dire ce qui change,
// de loin la repetition disparait.
// Deterministe : la meme carte a toujours exactement le meme cadrage, d'une partie a
// l'autre comme d'un rendu a l'autre. Aucun tirage au sort.
const PORTRAIT_VARIANTES = [
  { zoom: 1.0, x: 50, y: 34, teinte: 0, lum: 1.0 },
  { zoom: 1.08, x: 42, y: 30, teinte: -5, lum: 1.05 },
  { zoom: 1.04, x: 58, y: 38, teinte: 5, lum: 0.95 },
  { zoom: 1.12, x: 50, y: 26, teinte: -2, lum: 1.02 },
];

const portraitStyle = (card) => {
  if (!card) return undefined;
  // card.orientation est le numero de quart de tour (0 a 3) pose par makeOrderQuad : il
  // distingue exactement les quatre cartes d'un Ordre.
  // Deux tentatives ratees avant d'en arriver la, toutes deux fondees sur les RANGS :
  // baseTop+baseLeft, puis un melange pondere des deux. La rotation permute les rangs,
  // les collisions modulo 4 sont donc inevitables — mesure sur les 10 Ordres, on
  // obtenait 2 a 3 variantes distinctes au lieu de 4. Il fallait numeroter a la source.
  const v = PORTRAIT_VARIANTES[(card.orientation || 0) % 4];
  const gardien = card.ability === "guardian";
  return {
    transform: `scale(${v.zoom})`,
    objectPosition: `${v.x}% ${v.y}%`,
    filter: gardien
      ? `brightness(${(1.45 * v.lum).toFixed(2)}) contrast(1.08) hue-rotate(${v.teinte}deg)`
      : `brightness(${v.lum}) hue-rotate(${v.teinte}deg)`,
  };
};

// Sauvegarde de partie : on retire le portrait (gros texte d'image) avant de
// sauvegarder pour rester léger, et on le remet en le retrouvant via orderKey
// au moment de recharger la partie.
function stripForSave(card) {
  if (!card) return null;
  const { portrait, ...rest } = card;
  // Firestore REFUSE les valeurs undefined et fait échouer l'écriture entière. La pose
  // d'une carte pose systématiquement scribeConcealTurnsLeft/scribePlacedBy à undefined
  // pour tout Ordre autre que les Scribes : sans ce nettoyage, aucun coup ne part en
  // ligne. La sauvegarde locale, elle, ne montrait rien — JSON.stringify supprime les
  // clés undefined en silence.
  for (const cle of Object.keys(rest)) if (rest[cle] === undefined) delete rest[cle];
  return rest;
}

// Même contrainte que stripForSave, pour les objets qui ne sont pas des cartes : les
// événements d'animation portent des champs optionnels (comboLevel...) qui valent
// undefined la plupart du temps et feraient échouer l'écriture Firestore entière.
function sansUndefined(objet) {
  const propre = {};
  for (const cle of Object.keys(objet)) if (objet[cle] !== undefined) propre[cle] = objet[cle];
  return propre;
}
function hydrateFromSave(card) {
  if (!card) return null;
  const order = ORDERS.find((l) => l.ability === card.ability);
  return { ...card, portrait: order ? order.portrait : "" };
}

// Statistiques de partie — stockage HYBRIDE, robuste à tous les environnements.
// Préférence : window.storage (artefacts Claude, persiste entre sessions) >
// localStorage (site web hébergé) > mémoire (dernier recours, non persistant).
// Tout est asynchrone car window.storage l'est ; les stats transitent par un état React.
// ---------- Combos d'Ordres : le style de jeu d'un joueur ----------
// Chaque combo est une paire d'Ordres qui se repondent. On ne les declare pas comme des
// theories : chacun correspond a une detection precise dans le moteur (voir combosDuCoup),
// et le "signe" ci-dessous decrit en une phrase ce qu'il faut faire pour le declencher.
// Le nom sert de TITRE sur le profil : c'est ainsi qu'on dit au joueur quel joueur il est.
const COMBOS = [
  {
    key: "or-corrompu", nom: "L'Or Corrompu", ordres: ["poison", "eveil"],
    recit: "Vous empoisonnez votre propre terrain pour y poser vos Dorés : plus la carte est affaiblie, meilleur est le troc.",
    signe: "Un Doré posé sur une case que vous aviez vous-même empoisonnée.",
  },
  {
    key: "rancon", nom: "La Rançon", ordres: ["maudits", "eveil"],
    recit: "Vous laissez l'adversaire vous prendre un Maudit — il en sort plus fort — puis vous le rachetez.",
    signe: "Un Maudit perdu, puis repris dans la même partie.",
  },
  {
    key: "traine-venin", nom: "La Traîne au Venin", ordres: ["cendres", "poison"],
    recit: "Vous empoisonnez le couloir, puis vous y traînez l'ennemie : elle arrive exsangue.",
    signe: "Une carte attirée dont le trajet traverse au moins une case empoisonnée.",
  },
  {
    key: "maree-montante", nom: "La Marée Montante", ordres: ["devoreuse"],
    recit: "Chaque Abysse volée à l'adversaire rejoint votre banc et nourrit la suivante que vous posez.",
    signe: "Une Abysse ennemie capturée alors que vous alignez des Abysses.",
  },
  {
    key: "miroir-truque", nom: "Le Miroir Truqué", ordres: ["mue", "eveil"],
    recit: "La Chimère retourne l'ennemie pour exposer son rang fort, puis le Doré vient le lui échanger.",
    signe: "Un Éveil déclenché sur une carte déjà retournée par une mue.",
  },
  {
    key: "trait-voile", nom: "Le Trait Voilé", ordres: ["scribes", "portee"],
    recit: "Le voile du Scribe cache où se trouve le 1 de l'Archer : il tire sans exposer sa gorge.",
    signe: "Un Archer posé pendant qu'un de vos voiles de Scribe est actif.",
  },
  {
    key: "battue", nom: "La Battue", ordres: ["cendres", "portee"],
    recit: "Les Cendres arrachent l'ennemie de sa poche protégée, la flèche l'abat en terrain ouvert.",
    signe: "Une capture à distance dans les deux tours qui suivent une attirance.",
  },
  {
    key: "breche", nom: "La Brèche", ordres: ["mue", "percee"],
    recit: "La mue ouvre le flanc faible, la Pique s'enfonce dans l'alignement.",
    signe: "Une percée réussie sur une carte retournée par une mue.",
  },
  {
    key: "fosse", nom: "La Fosse", ordres: ["poison", "devoreuse"],
    recit: "Le venin rend la zone invivable le temps que vos Abysses, les plus fragiles du jeu, deviennent intouchables.",
    signe: "Une Abysse posée à côté d'une case que vous avez empoisonnée.",
  },
  {
    key: "rempart-vicie", nom: "Le Rempart Vicié", ordres: ["guardian", "poison"],
    recit: "Le Rempart verrouille les cases saines, le venin rend les autres inhabitables : l'adversaire n'a plus où se poser.",
    signe: "Une victoire au score avec des Gardiens et au moins trois cases empoisonnées.",
  },
];

// Un titre ne se donne pas sur un coup de chance : il faut un echantillon (10 parties) et
// une vraie regularite (le combo dans 30 % d'entre elles). Au-dela, on affiche les trois
// plus frequents, le premier faisant office de titre principal.
const COMBOS_PARTIES_MIN = 10;
const COMBOS_SEUIL = 0.3;
const COMBOS_TITRES_MAX = 3;

// Etat de suivi d'UNE partie : ce qu'il faut retenir d'un coup a l'autre pour reconnaitre
// les combos qui se jouent en plusieurs temps.
function nouveauSuiviCombos() {
  return {
    mesPoisons: new Set(),      // cases que J'AI empoisonnees
    mues: new Set(),            // identifiants des cartes retournees par une mue
    mauditsMiens: new Set(),    // Maudits vus sous mes couleurs a un moment de la partie
    dernierAttraction: null,    // numero de mon coup ou une attirance a eu lieu
    coups: 0,                   // nombre de coups que j'ai joues
    reussis: new Set(),         // combos deja realises cette partie
    disqualifie: false,         // une annulation a eu lieu : la partie ne compte plus
  };
}

// Renvoie les titres merites par ces statistiques, du plus frequent au moins frequent.
function titresDuProfil(stats) {
  const parties = (stats && stats.combosParties) || 0;
  const compte = (stats && stats.combos) || {};
  const classement = COMBOS
    .map((combo) => ({ combo, parties: compte[combo.key] || 0, taux: parties ? (compte[combo.key] || 0) / parties : 0 }))
    .filter((t) => t.parties > 0)
    .sort((a, b) => b.taux - a.taux || b.parties - a.parties);
  const assez = parties >= COMBOS_PARTIES_MIN;
  return {
    pret: assez,
    parties,
    restantes: Math.max(0, COMBOS_PARTIES_MIN - parties),
    titres: assez ? classement.filter((t) => t.taux >= COMBOS_SEUIL).slice(0, COMBOS_TITRES_MAX) : [],
    classement, // tout, y compris sous le seuil : le profil montre la progression
  };
}

// Le titre a afficher a cote d'un joueur, ou null s'il n'en a pas encore merite.
function titrePrincipal(stats) {
  const t = titresDuProfil(stats);
  return t.titres.length ? t.titres[0].combo.nom : null;
}

// ---------- Maitrise des Ordres ----------
// Un Ordre se maitrise en le jouant : 6 500 parties pour en faire le tour. La progression
// se lit en pourcentage de ce total, et franchit sept rangs en chemin. Les paliers ne
// sont pas espaces egalement : les premiers viennent vite, pour que l'on sente tout de
// suite que l'on avance, les derniers se meritent — 6 500 parties, c'est une vie de jeu.
const MAITRISE_PARTIES_MAX = 6500;
const MAITRISE_RANGS = [
  { nom: "Recrue", min: 0 },
  { nom: "Initié", min: 25 },
  { nom: "Disciple", min: 100 },
  { nom: "Vétéran", min: 350 },
  { nom: "Maître", min: 1000 },
  { nom: "Archonte", min: 2500 },
  { nom: "Éminence", min: MAITRISE_PARTIES_MAX },
];
// Couleur propre a chaque Ordre, pour la vague qui monte dans son portrait. Les Ordres
// qui ont un chapitre d'Histoire reprennent la teinte de ce chapitre ; les deux autres
// recoivent la leur ici : l'or des Dores, le cyan des Chimeres.
const MAITRISE_COULEURS = {
  eveil: "rgba(232,200,119,0.85)",
  cendres: "rgba(255,120,40,0.85)",
  percee: "rgba(200,220,255,0.9)",
  portee: "rgba(110,200,90,0.85)",
  devoreuse: "rgba(80,160,255,0.7)",
  mue: "rgba(75,201,201,0.8)",
  poison: "rgba(120,220,80,0.7)",
  guardian: "rgba(170,180,200,0.8)",
  scribes: "rgba(205,120,255,0.75)",
  maudits: "rgba(150,80,220,0.75)",
  geolier: "rgba(180,180,180,0.6)",
};

function maitriseOrdre(stats, cle) {
  // Number() : un vieux stockage pourrait porter autre chose qu'un nombre, et un NaN
  // s'afficherait tel quel ("NaN %").
  const parties = Math.max(0, Number((stats && stats.orderPlays && stats.orderPlays[cle]) || 0) || 0);
  const taux = Math.min(1, parties / MAITRISE_PARTIES_MAX);
  let rang = 0;
  for (let i = 0; i < MAITRISE_RANGS.length; i++) if (parties >= MAITRISE_RANGS[i].min) rang = i;
  const suivant = MAITRISE_RANGS[rang + 1] || null;
  return {
    parties,
    taux,
    // 1 partie = deja 1 %, pas 0 ; et 100 % est reserve au dernier rang : arrondir
    // 6 499 parties a 100 % alors qu'on est encore Archonte se contredisait a l'ecran.
    pourcent: parties === 0 ? 0 : parties >= MAITRISE_PARTIES_MAX ? 100 : Math.min(99, Math.max(1, Math.round(taux * 100))),
    rang: MAITRISE_RANGS[rang],
    numero: rang + 1,
    suivant,
    manque: suivant ? suivant.min - parties : 0,
  };
}

// Version du compteur orderPlays. Avant la page de maitrise, il additionnait les Ordres
// des DEUX camps, les miens et ceux d'en face : impossible, apres coup, d'en retirer la
// part de l'adversaire. On l'oublie donc une fois pour toutes, plutot que d'afficher
// "Initie" sur un Ordre jamais tenu en main. A incrementer si son sens change encore.
const MAITRISE_VERSION = 1;
const DEFAULT_STATS = { gamesPlayed: 0, blueWins: 0, redWins: 0, mesVictoires: 0, orderPlays: {}, trophies: 0, combos: {}, combosParties: 0, maitriseVersion: MAITRISE_VERSION };

// ---------- Ligues & Héros ----------
// Barème compétitif : +30 trophées par victoire, -15 par défaite, jamais en dessous de 0.
// Conséquence à connaître : le point d'équilibre est à 33 % de victoires. En dessous, le
// joueur recule ; au-dessus, il progresse. Un joueur à 50 % gagne 7,5 trophées par partie
// en moyenne, soit environ 333 parties pour atteindre Légende.
const TROPHEES_VICTOIRE = 30;
const TROPHEES_DEFAITE = -15;

// Arènes de ligue. "marge" est le retrait, en % de la largeur, qui place le plateau
// dans l'ouverture centrale de l'image — mesuré image par image, car les cadres n'ont
// pas tous la même épaisseur (Bronze ouvre à 61 %, Platine à 80 %).
// Arènes de ligue. "marge" est le retrait, en % de la largeur, qui place le plateau
// dans l'ouverture centrale de l'image — mesuré image par image, car les cadres n'ont
// pas tous la même épaisseur (Bronze ouvre à 61 %, Platine à 80 %).
// ⚠️ Fichier PREVIEW : images embarquées en 512 px (106 Ko au total) pour que le
// sélecteur fonctionne en conversation. Le fichier réel pointe vers /arenes/*.webp.
// Fumerolles et étincelles des arènes. Table figée plutôt qu'un tirage au hasard : le
// rendu est identique d'une partie à l'autre, d'un écran à l'autre en multijoueur, et
// aucun calcul ne tourne pendant la partie — tout est porté par le CSS.
// x/y : point de départ (les quatre coins, là où le cadre est enflammé).
// derive : décalage horizontal en fin de course. taille : diamètre de base.
// Position des gemmes de chaque arène, en % du cadre — RELEVÉES sur les images elles-mêmes
// par détection des zones colorées saturées, pas estimées à l'oeil. Un point lumineux est
// posé exactement dessus pour les faire scintiller sans toucher à l'image.
const ARENE_GEMMES = {
  Bronze:  { pts: [[10, 10.5], [89.6, 10.4], [10, 89.5], [89.6, 89.6]], mid: [[50, 9], [50, 91], [9, 50], [91, 50]], teinte: "rgba(255,175,70,0.95)" },
  Argent:  { pts: [[8.5, 9.3], [91, 8.9], [8.3, 91.4], [92, 90.9]], mid: [[49.5, 8.5], [49.5, 91.5], [8.5, 49.5], [91.5, 49.5]], teinte: "rgba(190,215,245,0.95)" },
  Or:      { pts: [[11.1, 9.7], [88.5, 10.6], [10.7, 90.5], [88.8, 89.8]], mid: [[50, 7.5], [50, 92.5], [7.5, 50], [92.5, 50]], teinte: "rgba(255,200,90,0.95)" },
  Platine: { pts: [[8.5, 8.2], [91.1, 8.7], [8.2, 91.2], [91.3, 91]], mid: [[50, 7], [50, 92.5], [7.3, 49.5], [92.7, 49.5]], teinte: "rgba(150,200,255,1)" },
  Légende: { pts: [[9.8, 8.9], [90, 8.9], [9.8, 90.7], [89.8, 90.5]], mid: [[50, 9.5], [50, 90.5], [9.5, 50], [90.5, 50]], teinte: "rgba(255,130,50,1)" },
};

const ARENE_PARTICULES = [
  { type: "etincelle", x: "6%",  y: "4%",  duree: "5.5s", retard: "0s",   derive: "14px",  taille: "3px" },
  { type: "fumee",     x: "9%",  y: "2%",  duree: "9s",   retard: "1.2s", derive: "26px",  taille: "34px" },
  { type: "etincelle", x: "13%", y: "8%",  duree: "6.8s", retard: "2.9s", derive: "-9px",  taille: "2px" },
  { type: "etincelle", x: "92%", y: "5%",  duree: "6.2s", retard: "0.7s", derive: "-16px", taille: "3px" },
  { type: "fumee",     x: "89%", y: "3%",  duree: "10s",  retard: "3.4s", derive: "-22px", taille: "38px" },
  { type: "etincelle", x: "86%", y: "9%",  duree: "7.4s", retard: "4.6s", derive: "11px",  taille: "2px" },
  { type: "fumee",     x: "50%", y: "1%",  duree: "11s",  retard: "5.8s", derive: "18px",  taille: "42px" },
  { type: "etincelle", x: "30%", y: "3%",  duree: "8s",   retard: "2.1s", derive: "-13px", taille: "2px" },
  { type: "etincelle", x: "70%", y: "2%",  duree: "7s",   retard: "6.5s", derive: "15px",  taille: "3px" },
];

// marge = épaisseur du cadre peint, MESURÉE sur chaque image (en % de sa largeur, hors
// ornements des milieux de côté). Trop petite, le cadre est rogné ; trop grande, il
// mange l'interface.
const ARENES = {
  Bronze: { img: "/arenes/bronze.webp", marge: 11, braise: "rgba(255,150,60,0.75)" },
  Argent: { img: "/arenes/argent.webp", marge: 10, braise: "rgba(180,205,235,0.6)" },
  Or: { img: "/arenes/or.webp", marge: 13, braise: "rgba(235,180,80,0.75)" },
  Platine: { img: "/arenes/platine.webp", marge: 10, braise: "rgba(150,190,255,0.7)" },
  Légende: { img: "/arenes/legende.webp", marge: 13, braise: "rgba(255,95,35,0.85)" },
};

// hub : l'illustration de l'arene. Les cinq en ont une desormais ; le rendu sait toujours
// afficher une ligue en chantier, au cas ou une nouvelle viendrait s'ajouter avant son
// decor.
const LEAGUES = [
  { name: "Bronze", min: 0, hub: "/arenes/bronze-hub.webp" },
  { name: "Argent", min: 300, hub: "/arenes/argent-hub.webp" },
  { name: "Or", min: 800, hub: "/arenes/or-hub.webp" },
  { name: "Platine", min: 1500, hub: "/arenes/platine-hub.webp" },
  { name: "Légende", min: 2500, hub: "/arenes/legende-hub.webp" },
];
function getLeague(trophies) {
  let current = LEAGUES[0];
  for (const l of LEAGUES) if (trophies >= l.min) current = l;
  return current;
}
// Un héros par Ordre, débloqué à un palier de trophées donné. orderKey doit correspondre
// à une clé d'ORDERS ; desc décrit le bonus en jeu (affiché dans le sélecteur).
// Héros & Ligues : la mécanique est prête (voir plus bas) mais son intérêt réel (comparer sa
// progression à d'autres joueurs) suppose du multijoueur en ligne, pas encore possible avec ce
// projet. On désactive l'usage actif côté joueur pour l'instant et on affiche "Prochainement" —
// passer ce booléen à true réactive tout d'un coup, sans rien avoir à recoder.
const HEROES_LEAGUES_ENABLED = false;

const HEROES = [
  { orderKey: "cendres", name: "Héraut des Cendres", unlockAt: 300, desc: "Attire jusqu'à 2 cartes alignées au lieu d'une" },
  { orderKey: "percee", name: "Héraut des Piques", unlockAt: 600, desc: "Transperce jusqu'à 3 cartes au lieu de 2" },
  { orderKey: "poison", name: "Héraut des Pestiférés", unlockAt: 1000, desc: "N'empoisonne plus les cartes alliées" },
  { orderKey: "devoreuse", name: "Héraut des Abysses", unlockAt: 1500, desc: "Commence à +2, même seule en jeu" },
  { orderKey: "maudits", name: "Héraut des Maudits", unlockAt: 2000, desc: "1 chance sur 3 de gagner +2 au lieu de +1" },
  { orderKey: "scribes", name: "Héraut des Scribes", unlockAt: 2500, desc: "Rangs masqués 2 tours après la pose" },
  // Les 2 Hérauts suivants sont réservés au mode Histoire (pas de palier de trophées
  // pertinent tant que HEROES_LEAGUES_ENABLED est à false) : unlockAt est ignoré pour eux.
  { orderKey: "guardian", name: "Héraut des Gardiens", unlockAt: null, desc: "+1 aussi en attaque, en permanence" },
  { orderKey: "portee", name: "Héraut des Archers", unlockAt: null, desc: "Sa flèche traverse ses alliées sans s'arrêter" },
];
function isHeroUnlocked(hero, trophies) { return hero.unlockAt != null && trophies >= hero.unlockAt; }

// Étincelles de la cérémonie de déblocage d'un Héraut : positions et minutages calculés
// une fois pour toutes plutôt qu'au hasard à chaque rendu — sinon elles se replaceraient
// à chaque re-rendu de React et l'effet sauterait.
const HC_ETINCELLES = Array.from({ length: 16 }, (_, i) => {
  const angle = (Math.PI * 2 * i) / 16 + (i % 3) * 0.13;
  const dist = 58 + ((i * 37) % 52);
  return {
    dx: Math.round(Math.cos(angle) * dist) + "px",
    dy: Math.round(Math.sin(angle) * dist - 40) + "px",
    duree: (1.3 + ((i * 7) % 9) / 10).toFixed(2) + "s",
    retard: (0.95 + ((i * 13) % 5) / 10).toFixed(2) + "s",
  };
});

// Braises de la ceremonie de fin : FIGEES, comme HC_ETINCELLES — aucun tirage au sort
// a l'execution. Les retards negatifs pre-remplissent l'ecran : des braises sont deja
// en vol a l'ouverture au lieu de toutes partir du sol en meme temps.
const CER_BRAISES = Array.from({ length: 14 }, (_, i) => ({
  gauche: (5 + ((i * 41) % 90)) + "%",
  taille: 2 + ((i * 7) % 4),
  duree: (5.5 + ((i * 11) % 30) / 10).toFixed(1) + "s",
  retard: "-" + ((i * 17) % 80) / 10 + "s",
  derive: (((i * 29) % 60) - 30) + "px",
}));

// ---------- Mode Histoire : 8 chapitres, un par Ordre disposant d'un Héraut ----------
// Chapitre = l'Ordre du chapitre imposé dans la main du joueur (+ un 2e Ordre au choix,
// modifiable après chaque partie) contre une suite de bots. Le nombre de parties du
// chapitre se calcule automatiquement à partir du rang le plus élevé de l'Ordre (ex.
// Archers, rang max 9 → 9 parties) : pas besoin d'ajuster ce fichier si les rangs
// changent plus tard suite à un rééquilibrage. La dernière partie oppose un Seigneur de
// Guerre qui possède déjà le Héraut de l'Ordre ; le battre débloque ce Héraut pour de bon
// (toutes les parties futures, tous modes confondus — pas seulement dans ce chapitre).
// Dorés et Chimères n'ont volontairement pas de chapitre : pas de Héraut prévu pour eux.
const STORY_CHAPTER_ORDER_KEYS = ["cendres", "maudits", "devoreuse", "poison", "guardian", "portee", "percee", "scribes"];
const STORY_CHAPTERS = STORY_CHAPTER_ORDER_KEYS.map((key, i) => {
  const order = ORDERS.find((o) => o.key === key);
  const hero = HEROES.find((h) => h.orderKey === key);
  return { chapterNumber: i + 1, orderKey: key, order, hero, numGames: Math.max(...order.ranks) };
});

// ---------- Carte du mode Histoire : thème visuel par chapitre ----------
// Chaque chapitre a son ambiance : couleurs du cadre qui borde l'écran, couleur de la
// matière qui s'échappe sous chaque nœud du chemin, et FORME de cette matière (flamme,
// feuille, bulle...). "sens" indique si les particules montent (feu, bulles) ou tombent
// (feuilles, éclats). Les couleurs sont volontairement en rgba pour se fondre au fond.
//
// "ambiance" désigne la déclinaison de bords : "brasier" allume un cadre vivant dont
// l'intensité suit la progression du joueur dans le chapitre (voir .sm-brasier). Les
// Ordres qui n'en ont pas encore gardent le cadre simple d'origine — c'est volontaire,
// chaque Ordre recevra la sienne (brume pour les Maudits, remous pour les Abysses...).
// "chaud" / "froid" pilote la couleur du texte de l'en-tête et l'aura du médaillon.
const STORY_THEMES = {
  cendres: { forme: "flamme", sens: "monte", ambiance: "brasier", a: "rgba(255,120,40,0.85)", b: "rgba(255,190,70,0.8)", cadre: "rgba(230,90,30,0.5)", lueur: "rgba(255,140,50,0.35)", noyau: "rgba(255,225,170,0.95)", braise: "rgba(255,90,20,0.9)" },
  maudits: { forme: "volute", sens: "monte", a: "rgba(150,80,220,0.5)", b: "rgba(90,40,150,0.45)", cadre: "rgba(130,60,200,0.45)", lueur: "rgba(150,80,220,0.3)", noyau: "rgba(215,180,255,0.9)", braise: "rgba(130,60,200,0.85)" },
  devoreuse: { forme: "bulle", sens: "monte", a: "rgba(80,160,255,0.5)", b: "rgba(40,90,180,0.45)", cadre: "rgba(40,110,210,0.45)", lueur: "rgba(70,150,255,0.28)", noyau: "rgba(190,225,255,0.9)", braise: "rgba(50,120,220,0.85)" },
  poison: { forme: "volute", sens: "monte", a: "rgba(120,220,80,0.45)", b: "rgba(60,150,50,0.4)", cadre: "rgba(90,190,60,0.4)", lueur: "rgba(110,210,80,0.26)", noyau: "rgba(205,255,180,0.9)", braise: "rgba(95,195,65,0.85)" },
  guardian: { forme: "eclat", sens: "tombe", a: "rgba(170,180,200,0.7)", b: "rgba(110,120,145,0.6)", cadre: "rgba(140,150,175,0.4)", lueur: "rgba(170,180,205,0.24)", noyau: "rgba(230,235,245,0.9)", braise: "rgba(150,160,185,0.85)" },
  portee: { forme: "feuille", sens: "tombe", a: "rgba(110,200,90,0.85)", b: "rgba(60,150,70,0.8)", cadre: "rgba(70,170,80,0.45)", lueur: "rgba(100,200,90,0.28)", noyau: "rgba(200,250,190,0.9)", braise: "rgba(85,180,80,0.85)" },
  percee: { forme: "etincelle", sens: "monte", a: "rgba(200,220,255,0.9)", b: "rgba(140,170,220,0.8)", cadre: "rgba(160,185,230,0.4)", lueur: "rgba(190,215,255,0.26)", noyau: "rgba(240,246,255,0.95)", braise: "rgba(170,195,240,0.85)" },
  // Teinte alignee sur la carte peinte du chapitre (violet-magenta), et non sur le
  // parchemin ambre d'origine : le titre et le cadre juraient avec l'illustration.
  // Volontairement plus clair et plus rose que les Maudits, pour que les deux chapitres
  // violets ne se confondent pas.
  scribes: { forme: "parchemin", sens: "tombe", a: "rgba(205,120,255,0.7)", b: "rgba(150,70,200,0.6)", cadre: "rgba(185,95,235,0.4)", lueur: "rgba(205,120,255,0.28)", noyau: "rgba(240,215,255,0.95)", braise: "rgba(190,100,240,0.85)" },
};

// ---------- Cartes peintes (images de fond) ----------
// Certains chapitres ont une vraie illustration en fond, avec ses ilots deja dessines.
// Dans ce cas, on n'utilise plus le trace genere : les positions des noeuds sont celles
// MESUREES dans l'image (en % de sa surface, y compte depuis le bas comme partout
// ailleurs), pour que les zones tapables tombent pile sur les rochers peints.
// ratio = hauteur / largeur de l'image, il fixe la taille de la surface monde.
// "eteint" est une decoupe du rocher, desaturee et assombrie, posee PAR-DESSUS l'original
// quand l'etape n'est pas encore atteinte : l'extinction epouse ainsi la vraie silhouette
// de la roche. Un masque CSS ne convenait pas — il est incompatible avec backdrop-filter
// et produisait des rectangles noirs decales.
// "zoom" (facultatif, 1 par defaut) corrige MONDE_FACTEUR pour ce chapitre : les rochers
// n'ont pas la meme taille d'une illustration a l'autre.
const STORY_CARTES_PEINTES = {
  cendres: {
    src: "/cartes/cendres.jpg",
    ratio: 1.75,
    // Les rochers de cette illustration sont les plus gros de la serie : sans ce
    // correctif, le chapitre paraissait bien plus zoome que les sept autres.
    zoom: 0.82,
    noeuds: [
      { x: 64.5, y: 16.5, l: 19.8, h: 13.3, eteint: "/cartes/cendres_r1.png" },
      { x: 39.3, y: 31.4, l: 21.0, h: 13.7, eteint: "/cartes/cendres_r2.png" },
      { x: 65.5, y: 46.5, l: 20.0, h: 11.7, eteint: "/cartes/cendres_r3.png" },
      { x: 39.7, y: 59.9, l: 26.4, h: 12.6, eteint: "/cartes/cendres_r4.png" },
      { x: 64.4, y: 74.8, l: 23.3, h: 13.0, eteint: "/cartes/cendres_r5.png" },
      { x: 38.6, y: 91.1, l: 19.6, h: 12.2, eteint: "/cartes/cendres_r6.png" },
    ],
  },
  maudits: {
    src: "/cartes/maudits.jpg",
    ratio: 1.75,
    noeuds: [
      { x: 40.1, y: 7.5, l: 14.6, h: 9.1, eteint: "/cartes/maudits_r1.png" },
      { x: 61.6, y: 19.9, l: 15.9, h: 7.5, eteint: "/cartes/maudits_r2.png" },
      { x: 41.2, y: 31.4, l: 16.9, h: 8.5, eteint: "/cartes/maudits_r3.png" },
      { x: 61.5, y: 42.8, l: 15.6, h: 7.4, eteint: "/cartes/maudits_r4.png" },
      { x: 38.3, y: 53.6, l: 11.1, h: 8.9, eteint: "/cartes/maudits_r5.png" },
      { x: 62.1, y: 64.7, l: 15.1, h: 6.7, eteint: "/cartes/maudits_r6.png" },
      { x: 40.3, y: 76.3, l: 15.9, h: 8.0, eteint: "/cartes/maudits_r7.png" },
      { x: 61.2, y: 91.8, l: 11.2, h: 9.2, eteint: "/cartes/maudits_r8.png" },
    ],
  },
  devoreuse: {
    src: "/cartes/devoreuse.jpg",
    ratio: 1.75,
    noeuds: [
      { x: 61.1, y: 15.0, l: 20.1, h: 9.4, eteint: "/cartes/devoreuse_r1.png" },
      { x: 34.7, y: 31.8, l: 10.0, h: 7.4, eteint: "/cartes/devoreuse_r2.png" },
      { x: 65.8, y: 46.3, l: 15.2, h: 9.0, eteint: "/cartes/devoreuse_r3.png" },
      { x: 39.6, y: 59.7, l: 18.9, h: 9.3, eteint: "/cartes/devoreuse_r4.png" },
      { x: 63.3, y: 75.4, l: 17.4, h: 9.2, eteint: "/cartes/devoreuse_r5.png" },
      { x: 40.4, y: 91.9, l: 24.7, h: 10.6, eteint: "/cartes/devoreuse_r6.png" },
    ],
  },
  guardian: {
    src: "/cartes/guardian.jpg",
    ratio: 1.75,
    noeuds: [
      { x: 61.9, y: 17.0, l: 11.2, h: 7.6, eteint: "/cartes/guardian_r1.png" },
      { x: 41.7, y: 32.0, l: 9.0, h: 5.8, eteint: "/cartes/guardian_r2.png" },
      { x: 63.9, y: 48.1, l: 15.6, h: 11.3, eteint: "/cartes/guardian_r3.png" },
      { x: 42.3, y: 62.1, l: 13.8, h: 11.2, eteint: "/cartes/guardian_r4.png" },
      { x: 60.2, y: 74.1, l: 9.2, h: 7.2, eteint: "/cartes/guardian_r5.png" },
      { x: 43.5, y: 86.9, l: 9.9, h: 7.8, eteint: "/cartes/guardian_r6.png" },
    ],
  },
  scribes: {
    src: "/cartes/scribes.jpg",
    ratio: 1.75,
    noeuds: [
      { x: 63.5, y: 7.3, l: 8.9, h: 4.3, eteint: "/cartes/scribes_r1.png" },
      { x: 36.3, y: 19.5, l: 9.6, h: 5.2, eteint: "/cartes/scribes_r2.png" },
      { x: 64.2, y: 31.7, l: 10.7, h: 4.4, eteint: "/cartes/scribes_r3.png" },
      { x: 35.6, y: 43.8, l: 10.7, h: 4.7, eteint: "/cartes/scribes_r4.png" },
      { x: 63.9, y: 56.3, l: 11.2, h: 5.2, eteint: "/cartes/scribes_r5.png" },
      { x: 35.7, y: 68.4, l: 11.6, h: 4.4, eteint: "/cartes/scribes_r6.png" },
      { x: 64.2, y: 80.4, l: 12.1, h: 4.1, eteint: "/cartes/scribes_r7.png" },
      { x: 37.5, y: 93.2, l: 12.4, h: 4.6, eteint: "/cartes/scribes_r8.png" },
    ],
  },
  portee: {
    src: "/cartes/portee.jpg",
    ratio: 1.750,
    noeuds: [
      { x: 39.3, y: 7.4, l: 23.6, h: 11.8, eteint: "/cartes/portee_r1.png" },
      { x: 63.7, y: 16.6, l: 24.0, h: 12.9, eteint: "/cartes/portee_r2.png" },
      { x: 36.8, y: 27.5, l: 23.0, h: 13.1, eteint: "/cartes/portee_r3.png" },
      { x: 64.3, y: 37.5, l: 23.3, h: 12.6, eteint: "/cartes/portee_r4.png" },
      { x: 37.2, y: 48.4, l: 24.0, h: 13.1, eteint: "/cartes/portee_r5.png" },
      { x: 63.8, y: 58.8, l: 24.5, h: 13.5, eteint: "/cartes/portee_r6.png" },
      { x: 36.6, y: 70.2, l: 23.0, h: 13.2, eteint: "/cartes/portee_r7.png" },
      { x: 63.1, y: 81.0, l: 22.7, h: 12.7, eteint: "/cartes/portee_r8.png" },
      { x: 40.3, y: 93.0, l: 25.1, h: 13.5, eteint: "/cartes/portee_r9.png" },
    ],
  },
  percee: {
    src: "/cartes/percee.jpg",
    ratio: 1.750,
    noeuds: [
      { x: 53.9, y: 13.1, l: 40.5, h: 14.7, eteint: "/cartes/percee_r1.png" },
      { x: 44.2, y: 29.1, l: 37.6, h: 14.3, eteint: "/cartes/percee_r2.png" },
      { x: 56.9, y: 44.3, l: 36.3, h: 14.0, eteint: "/cartes/percee_r3.png" },
      { x: 42.1, y: 60.0, l: 36.3, h: 14.7, eteint: "/cartes/percee_r4.png" },
      { x: 62.2, y: 75.1, l: 38.2, h: 12.4, eteint: "/cartes/percee_r5.png" },
      { x: 45.3, y: 90.8, l: 37.1, h: 15.8, eteint: "/cartes/percee_r6.png" },
    ],
  },
  poison: {
    src: "/cartes/poison.jpg",
    ratio: 1.750,
    noeuds: [
      { x: 42.7, y: 11.5, l: 29.4, h: 16.4, eteint: "/cartes/poison_r1.png" },
      { x: 64.0, y: 25.9, l: 33.2, h: 15.1, eteint: "/cartes/poison_r2.png" },
      { x: 38.2, y: 39.3, l: 31.9, h: 14.4, eteint: "/cartes/poison_r3.png" },
      { x: 64.0, y: 52.4, l: 33.3, h: 13.2, eteint: "/cartes/poison_r4.png" },
      { x: 37.3, y: 65.5, l: 35.0, h: 14.7, eteint: "/cartes/poison_r5.png" },
      { x: 64.8, y: 78.6, l: 34.4, h: 14.5, eteint: "/cartes/poison_r6.png" },
      { x: 41.5, y: 92.0, l: 26.6, h: 12.9, eteint: "/cartes/poison_r7.png" },
    ],
  },
};

// Tracé du chemin des parties, fidèle au croquis d'Alexandre : départ en bas à gauche,
// montée d'un cran, traversée vers la droite, remontée à droite — puis, pour les
// chapitres plus longs (8-9 parties), retour vers la gauche en haut. Généré par une
// séquence de pas (U = monter, R = droite, L = gauche) coupée au nombre de parties du
// chapitre, ce qui donne exactement le dessin pour 7 cases et s'adapte tout seul de 6 à
// 9. Retourne des positions en pourcentage du panneau (x: 0-100 de gauche à droite,
// y: 0-100 du BAS vers le haut — inversé au rendu).
function storyMapLayout(n) {
  const pas = ["U", "R", "R", "R", "U", "U", "L", "L", "L", "U", "U"]; // au-delà de 12 cases, prolonger ici
  let x = 0, y = 0;
  const cases = [{ x, y }];
  for (let i = 0; i < n - 1; i++) {
    const p = pas[i] || "U";
    if (p === "U") y += 1;
    else if (p === "R") x += 1;
    else x -= 1;
    cases.push({ x, y });
  }
  const maxX = Math.max(...cases.map((c) => c.x));
  const maxY = Math.max(...cases.map((c) => c.y));
  // Espacement vertical à PAS CONSTANT (26% par cran, réduit seulement si le chemin ne
  // tiendrait pas) : un chapitre court (Cendres, 2 crans) garde des cases proches comme
  // sur le croquis, au lieu de s'étirer sur toute la hauteur de l'écran.
  const pasY = Math.min(26, maxY > 0 ? 80 / maxY : 26);
  // Départ légèrement centré : un chemin court (Cendres, 2 crans) remonte un peu au lieu
  // de laisser tout le haut du panneau vide sous le titre.
  const departY = Math.max(8, (92 - maxY * pasY - 10) / 2);
  return cases.map((c) => ({
    x: maxX === 0 ? 50 : 14 + (c.x / maxX) * 72,
    y: departY + c.y * pasY,
  }));
}

// Particules du décor, FIGÉES (aucun tirage au sort à l'exécution — même règle que
// ARENE_PARTICULES : identique à chaque affichage, aucun calcul pendant le jeu).
// gauche : position horizontale en %, taille en px, duree/retard : animation.
const STORY_MAP_PARTICULES = [
  { gauche: 4, taille: 14, duree: "5.2s", retard: "0s" },
  { gauche: 12, taille: 9, duree: "6.8s", retard: "1.4s" },
  { gauche: 21, taille: 12, duree: "5.9s", retard: "0.7s" },
  { gauche: 32, taille: 8, duree: "7.4s", retard: "2.6s" },
  { gauche: 43, taille: 13, duree: "5.5s", retard: "1.9s" },
  { gauche: 54, taille: 9, duree: "6.4s", retard: "0.4s" },
  { gauche: 63, taille: 15, duree: "5.1s", retard: "3.1s" },
  { gauche: 72, taille: 8, duree: "7.1s", retard: "1.1s" },
  { gauche: 81, taille: 12, duree: "6s", retard: "2.2s" },
  { gauche: 91, taille: 10, duree: "5.7s", retard: "0.9s" },
  { gauche: 97, taille: 13, duree: "6.6s", retard: "1.7s" },
];
// Flammèches (ou feuilles, bulles...) qui s'échappent sous CHAQUE case du chemin —
// l'équivalent des hachures du croquis. Trois par case, figées elles aussi.
const STORY_CASE_MECHES = [
  { gauche: 18, taille: 10, duree: "2.1s", retard: "0s" },
  { gauche: 50, taille: 13, duree: "1.8s", retard: "0.6s" },
  { gauche: 78, taille: 9, duree: "2.4s", retard: "1.1s" },
];

// Langues de feu qui lèchent le BORD BAS de l'écran (ambiance "brasier"). Position,
// largeur, hauteur et cadence figées : aucun tirage au sort à l'affichage, l'écran est
// identique d'une ouverture à l'autre. Les hauteurs varient pour éviter le peigne
// régulier ; les cadences sont volontairement toutes différentes et non multiples entre
// elles, sinon les flammes se synchronisent au bout de quelques secondes et l'effet
// devient mécanique.
const STORY_FLAMMES_BAS = [
  { gauche: -2, largeur: 20, hauteur: 62, duree: "2.3s", retard: "0s" },
  { gauche: 9, largeur: 15, hauteur: 44, duree: "3.1s", retard: "0.7s" },
  { gauche: 19, largeur: 22, hauteur: 78, duree: "2.7s", retard: "1.5s" },
  { gauche: 31, largeur: 16, hauteur: 50, duree: "3.4s", retard: "0.3s" },
  { gauche: 42, largeur: 24, hauteur: 86, duree: "2.5s", retard: "1.1s" },
  { gauche: 55, largeur: 17, hauteur: 46, duree: "3.2s", retard: "1.9s" },
  { gauche: 66, largeur: 21, hauteur: 72, duree: "2.9s", retard: "0.5s" },
  { gauche: 78, largeur: 15, hauteur: 42, duree: "3.6s", retard: "1.3s" },
  { gauche: 87, largeur: 23, hauteur: 80, duree: "2.6s", retard: "2.1s" },
];
// Braises qui remontent le long des DEUX CÔTÉS. "cote" vaut "g" ou "d" ; "bas" est la
// hauteur de départ en % (elles montent ensuite jusqu'en haut de l'écran).
const STORY_BRAISES_COTES = [
  { cote: "g", bas: 4, taille: 7, duree: "5.4s", retard: "0s" },
  { cote: "g", bas: 22, taille: 5, duree: "6.8s", retard: "1.6s" },
  { cote: "g", bas: 41, taille: 8, duree: "5.9s", retard: "3.2s" },
  { cote: "g", bas: 63, taille: 5, duree: "7.3s", retard: "0.9s" },
  { cote: "g", bas: 79, taille: 6, duree: "6.2s", retard: "2.4s" },
  { cote: "d", bas: 11, taille: 6, duree: "6.5s", retard: "0.4s" },
  { cote: "d", bas: 29, taille: 8, duree: "5.6s", retard: "2.8s" },
  { cote: "d", bas: 48, taille: 5, duree: "7.1s", retard: "1.2s" },
  { cote: "d", bas: 68, taille: 7, duree: "6.1s", retard: "3.6s" },
  { cote: "d", bas: 88, taille: 6, duree: "5.8s", retard: "2s" },
];

// ---------- Textes affiches pendant les temps d'attente ----------
// Deux registres qui alternent : l'Histoire du monde, et des conseils de jeu tires
// des regles reelles. Ils occupent les secondes ou le joueur ne peut rien faire :
// recherche d'un adversaire, ou attente de ses Ordres.
// Ordre volontairement fixe (pas de tirage au sort) : deux joueurs qui attendent
// cote a cote voient la meme chose, et la relecture reste coherente d'une partie
// a l'autre. Le point de depart, lui, tourne a chaque attente.
const RECITS_ATTENTE = [
  { genre: "histoire", texte: "Le ciel se déchira sans avertissement. La Faille aspira la réalité et recracha des flots de magie brute, bouleversant les dix Ordres à jamais." },
  { genre: "astuce", texte: "Un rang supérieur à celui qui lui fait face capture la carte adverse. Comparez toujours le côté qui touche, jamais la carte entière." },
  { genre: "histoire", texte: "Le Pacte Azur veut contenir la Faille. La Horde Écarlate veut y puiser. Aucun des deux camps ne cédera avant le prochain Rite." },
  { genre: "astuce", texte: "Deux rangs identiques parmi vos voisines déclenchent la Résonance : toutes les ennemies concernées tombent d'un coup, même les plus fortes." },
  { genre: "histoire", texte: "Les Ordres ne jurent fidélité à aucune bannière fixe, seulement au vainqueur du Rite. C'est pourquoi un Commandant invoque les deux Ordres de son choix." },
  { genre: "astuce", texte: "Une carte capturée sert aussitôt son nouveau camp : sa capacité se déclenche pour vous. C'est l'Onde, et elle peut renverser un plateau entier." },
  { genre: "histoire", texte: "Les Maudits portent une malédiction antique : chaque capture subie les rend plus redoutables. Les retourner deux fois est rarement une bonne idée." },
  { genre: "astuce", texte: "Les coins ne présentent que deux côtés attaquables. Vos cartes aux rangs faibles y survivent bien plus longtemps qu'au centre." },
  { genre: "histoire", texte: "Les Scribes gardaient leurs secrets jusqu'au dernier instant. Leurs rangs restent cachés en main, puis un tour encore après la pose." },
  { genre: "astuce", texte: "Azur part avec un point d'avance pour compenser le fait de jouer en premier. Une égalité de cartes sur le plateau lui donne donc la victoire." },
  { genre: "histoire", texte: "Les Abysses sont remontées des tréfonds océaniques. Chaque Abysse en jeu renforce toutes les autres : elles ne chassent jamais seules." },
  { genre: "astuce", texte: "Gardez une carte forte pour le dernier tour. La dernière pose ne peut plus être punie, c'est souvent elle qui décide de la partie." },
];

// ---------- Historique des parties ----------
// Les 3 dernières parties terminées, la plus récente en premier. Volontairement
// minuscule (3 entrées, quelques champs) : un vrai journal viendra avec les profils.
const HISTORIQUE_MAX = 3;
function lireHistorique() {
  try {
    const brut = localStorage.getItem("emprise-historique");
    const liste = brut ? JSON.parse(brut) : [];
    if (!Array.isArray(liste)) return [];
    // Classé uniquement pour l'instant. Le filtre sert aussi de nettoyage : les entrees
    // enregistrees avant cette regle, qui n'ont pas le marqueur, sont ecartees.
    return liste.filter((e) => e && e.classee).slice(0, HISTORIQUE_MAX);
  } catch (e) { return []; }
}
function ecrireHistorique(entree) {
  const liste = [entree, ...lireHistorique()].slice(0, HISTORIQUE_MAX);
  try { localStorage.setItem("emprise-historique", JSON.stringify(liste)); } catch (e) { /* non persisté */ }
  return liste;
}
// "il y a 5 min" plutôt qu'une date brute : sur 3 parties récentes, la fraîcheur
// relative se lit mieux qu'un horodatage.
function ilYa(t) {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "à l'instant";
  const min = Math.floor(s / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.floor(h / 24);
  return j === 1 ? "hier" : `il y a ${j} jours`;
}

let memoryStats = null; // repli en mémoire si aucun stockage durable n'est disponible

async function readStatsRaw() {
  if (typeof window !== "undefined" && window.storage && window.storage.get) {
    try {
      const res = await window.storage.get("emprise-stats");
      return res && res.value != null ? res.value : null;
    } catch (e) {
      return null; // clé absente ou stockage indisponible
    }
  }
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem("emprise-stats");
  } catch (e) { /* stockage bloqué */ }
  return memoryStats;
}

async function writeStatsRaw(str) {
  if (typeof window !== "undefined" && window.storage && window.storage.set) {
    try { await window.storage.set("emprise-stats", str); return; } catch (e) { /* on tente la suite */ }
  }
  try {
    if (typeof localStorage !== "undefined") { localStorage.setItem("emprise-stats", str); return; }
  } catch (e) { /* stockage bloqué */ }
  memoryStats = str;
}

async function loadStats() {
  const raw = await readStatsRaw();
  if (!raw) return { ...DEFAULT_STATS };
  try {
    const parsed = JSON.parse(raw);
    // Compteur d'une version anterieure (ou sans version) : il melangeait les Ordres d'en
    // face aux miens, on repart de zero. Les autres stats sont gardees telles quelles.
    const orderPlays = parsed.maitriseVersion === MAITRISE_VERSION ? (parsed.orderPlays || {}) : {};
    return { ...DEFAULT_STATS, ...parsed, orderPlays, combos: parsed.combos || {}, maitriseVersion: MAITRISE_VERSION };
  } catch (e) {
    return { ...DEFAULT_STATS };
  }
}

// orderKeys : liste des clés d'Ordre (chaînes) réellement utilisées cette partie.
// trophyGain : variation de trophées de cette partie (0 hors multijoueur en ligne).
// Seules les parties en ligne comptent pour le classement ; les Échos et le jeu local ne
// rapportent rien. La valeur peut être négative (défaite en ligne).
// Renvoie les stats mises à jour pour rafraîchir l'état React.
// comboKeys : combos reconnus pendant cette partie (liste vide si la partie ne compte pas
// pour le profil — bac a sable, Mode Histoire, duel local, ou annulation utilisee).
// compteAuProfil : dit si cette partie entre dans le denominateur du profil. Une partie
// hors-profil ne doit NI compter ses combos NI gonfler le total, sinon le taux baisserait.
// monCamp : le camp que J'AI tenu cette partie (null en duel local, ou les deux joueurs
// sont humains et aucune victoire n'est "la mienne"). blueWins et redWins comptent les
// camps du PLATEAU : une egalite etant impossible, leur somme vaut toujours gamesPlayed
// et ne peut donc pas servir de compteur personnel — le profil affichait ainsi autant de
// "victoires" que de parties jouees, defaites comprises.
async function recordGameStats(winner, orderKeys, trophyGain = 0, comboKeys = [], compteAuProfil = false, monCamp = null) {
  const stats = await loadStats();
  stats.gamesPlayed += 1;
  if (monCamp && winner === monCamp) stats.mesVictoires = (stats.mesVictoires || 0) + 1;
  if (compteAuProfil) {
    stats.combosParties = (stats.combosParties || 0) + 1;
    if (!stats.combos) stats.combos = {};
    comboKeys.forEach((key) => { stats.combos[key] = (stats.combos[key] || 0) + 1; });
  }
  if (winner === "blue") stats.blueWins += 1;
  else if (winner === "red") stats.redWins += 1;
  orderKeys.forEach((key) => {
    stats.orderPlays[key] = (stats.orderPlays[key] || 0) + 1;
  });
  // Plancher à 0 : une série de défaites ne peut jamais faire passer le total en négatif.
  stats.trophies = Math.max(0, (stats.trophies || 0) + trophyGain);
  await writeStatsRaw(JSON.stringify(stats));
  return stats;
}

// Remet les statistiques à zéro (même mécanisme de stockage hybride que ci-dessus).
async function resetStats() {
  memoryStats = null;
  await writeStatsRaw(JSON.stringify(DEFAULT_STATS));
  return { ...DEFAULT_STATS };
}

// ---------- Mode Histoire : progression (même mécanisme de stockage hybride que les stats) ----------
// completedChapters : clés d'Ordre dont le chapitre est terminé (Seigneur de Guerre battu).
// chapterWins : { [orderKey]: parties gagnées dans la tentative en cours de ce chapitre }.
const DEFAULT_STORY_PROGRESS = { completedChapters: [], chapterWins: {} };
let memoryStory = null; // repli en mémoire si aucun stockage durable n'est disponible

async function readStoryRaw() {
  if (typeof window !== "undefined" && window.storage && window.storage.get) {
    try {
      const res = await window.storage.get("emprise-story");
      return res && res.value != null ? res.value : null;
    } catch (e) {
      return null; // clé absente ou stockage indisponible
    }
  }
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem("emprise-story");
  } catch (e) { /* stockage bloqué */ }
  return memoryStory;
}

async function writeStoryRaw(str) {
  if (typeof window !== "undefined" && window.storage && window.storage.set) {
    try { await window.storage.set("emprise-story", str); return; } catch (e) { /* on tente la suite */ }
  }
  try {
    if (typeof localStorage !== "undefined") { localStorage.setItem("emprise-story", str); return; }
  } catch (e) { /* stockage bloqué */ }
  memoryStory = str;
}

async function loadStoryProgress() {
  const raw = await readStoryRaw();
  if (!raw) return { ...DEFAULT_STORY_PROGRESS, chapterWins: {} };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STORY_PROGRESS, ...parsed, chapterWins: parsed.chapterWins || {} };
  } catch (e) {
    return { ...DEFAULT_STORY_PROGRESS, chapterWins: {} };
  }
}

// Enregistre une victoire dans le chapitre en cours (incrémente son compteur de parties
// gagnées). Le passage à "chapitre terminé" (Seigneur de Guerre battu) sera géré à
// l'étape suivante, en même temps que le déblocage du Héraut.
async function recordChapterWin(orderKey) {
  const progress = await loadStoryProgress();
  progress.chapterWins[orderKey] = (progress.chapterWins[orderKey] || 0) + 1;
  await writeStoryRaw(JSON.stringify(progress));
  return progress;
}

// Marque le chapitre comme terminé (Seigneur de Guerre battu) : débloque son Héraut pour
// de bon. idempotent — rejouer un chapitre déjà terminé n'ajoute pas de doublon.
async function completeChapter(orderKey) {
  const progress = await loadStoryProgress();
  progress.chapterWins[orderKey] = (progress.chapterWins[orderKey] || 0) + 1;
  if (!progress.completedChapters.includes(orderKey)) progress.completedChapters.push(orderKey);
  await writeStoryRaw(JSON.stringify(progress));
  return progress;
}

// Calcule le niveau de difficulté du bot pour une partie donnée d'un chapitre du mode
// Histoire (gameIndex commence à 1). Les ~40% premières parties sont en Novice, le
// reste en Vétéran, sauf la toute dernière partie qui est toujours le Seigneur de
// Guerre (le combat de fin de chapitre).
function storyDifficultyFor(gameIndex, numGames) {
  if (gameIndex >= numGames) return "expert"; // la dernière partie est toujours le Seigneur de Guerre
  const p = gameIndex / numGames;
  if (p <= 0.3) return "debutant";
  if (p <= 0.6) return "intermediaire"; // Combattant : la marche manquante entre Novice et Vétéran
  return "avance";
}

// Composant réutilisable : affiche une carte (portrait + 4 rangs), avec ses
// animations d'événements le cas échéant. Remplace 6 copies identiques du même
// JSX qui traînaient dans le plateau, les 2 mains, le tutoriel et l'aperçu.
const Card = memo(function Card({ card, owner, events = [], onClick, onPointerDown, extraClass = "", selected = false, concealed = false, poisoned = false, previewResonanceDirs = [], hiddenFromFoe = 0 }) {
  // La capture (same/basic/combo) s'affiche normalement. La croissance du Maudit
  // ("maudit-boost") est retardée (voir mauditBoostDelay plus bas) pour laisser au joueur
  // le temps de bien voir la capture avant de comprendre que la carte grandit en plus —
  // elle n'est donc PAS mélangée aux classes de flash du flip, qui jouerait en même temps.
  const flashClasses = events.filter((e) => e.kind !== "maudit-boost").map((e) => (e.kind === "mue" && e.axis ? `flash-mue flash-mue-${e.axis}` : `flash-${e.kind}`)).join(" ");
  const porteeEvent = events.find((e) => e.kind === "portee" && e.dir);
  const perceeEvent = events.find((e) => e.kind === "percee" && e.dir);
  const guardianEvent = events.find((e) => e.kind === "guardian" && e.dir);
  // Cendres : la carte attirée doit se VOIR arriver. Sans point de départ, l'animation ne
  // faisait que la redimensionner sur sa case d'arrivée — elle semblait se téléporter.
  // On lui donne donc un décalage de départ, dans le sens inverse de son déplacement et
  // proportionnel au nombre de cases franchies (plafonné à 3 pour rester dans l'écran).
  const attractionPullEvent = events.find((e) => e.kind === "attraction-pull" && e.dir);
  const pullStyle = (() => {
    if (!attractionPullEvent) return null;
    const cases = Math.min(3, Math.max(1, attractionPullEvent.steps || 1));
    const dist = `${cases * 108}%`;
    switch (attractionPullEvent.dir) {
      case "top": return { "--pull-dx": "0%", "--pull-dy": `-${dist}` };
      case "bottom": return { "--pull-dx": "0%", "--pull-dy": dist };
      case "left": return { "--pull-dx": `-${dist}`, "--pull-dy": "0%" };
      default: return { "--pull-dx": dist, "--pull-dy": "0%" };
    }
  })();
  // Gardiens : aucun +1 n'est jamais affiché en permanence, avec ou sans capacité
  // supérieure. Une carte 6/5/5/6 se lit 6/5/5/6, en main comme sur le plateau. Le +1
  // apparaît uniquement à l'aperçu, sur le SEUL côté concerné par le combat en cours :
  //   - en défense (capacité de base)   : le côté attaqué du Gardien adverse
  //   - en attaque (capacité supérieure) : le côté du Gardien posé qui frappe un ennemi
  // Voir liveDragPreview, qui remplit guardianBoostedSides.
  // Eveil (Dores) : un evenement par cote echange. La carte peut etre la POSEE
  // ("eveil-self") ou une CIBLE ("eveil"), et jusqu'a 4 cotes peuvent troquer en meme
  // temps sur la carte posee.
  const eveilDirs = events.filter((e) => (e.kind === "eveil" || e.kind === "eveil-self") && e.dir).map((e) => e.dir);
  const eveilCotes = [...new Set(eveilDirs)];
  const devouring = events.some((e) => e.kind === "devoreuse");
  const mauditBoostEvent = events.find((e) => e.kind === "maudit-boost");
  // Résonance : côté(s) où un rang égal a matché — sur la carte capturée ("same") ET sur
  // la carte posée elle-même ("same-self"), pour que les 2 valeurs à l'origine du match
  // clignotent toutes les deux, pas seulement celle de la victime.
  const resonanceDirs = events.filter((e) => (e.kind === "same" || e.kind === "same-self") && e.dir).map((e) => e.dir);
  const resonanceShockDir = events.find((e) => e.kind === "same" && e.dir)?.dir; // point de contact pour l'onde de choc
  // Onde (combo) : la carte peut être VICTIME (elle vient d'être capturée en chaîne) et/ou
  // ÉMETTRICE (elle transmet le choc à la suivante) au même instant — les deux sont possibles
  // simultanément sur une même case au fil d'une chaîne.
  const comboVictimEvent = events.find((e) => e.kind === "combo" && e.dir);
  const comboEmitEvent = events.find((e) => e.kind === "combo-emit" && e.dir);
  // L'Onde ne démarre qu'une fois la Résonance bien terminée (3s) + 1s de pause — jamais
  // en même temps — puis chaque carte de la chaîne s'enchaîne toutes les 300ms par-dessus.
  const COMBO_BASE_DELAY = 4000;
  const comboDelay = comboVictimEvent ? COMBO_BASE_DELAY + (comboVictimEvent.comboLevel || 0) * 300 : (comboEmitEvent ? COMBO_BASE_DELAY + (comboEmitEvent.comboLevel || 0) * 300 : 0);
  // La croissance du Maudit attend que l'animation de capture soit bien terminée avant de
  // se déclencher (comboDelay si elle vient d'une chaîne + le temps du flip + une pause
  // volontaire), pour que le joueur comprenne "capture" puis "croissance" comme 2 temps distincts.
  const mauditBoostDelay = mauditBoostEvent ? comboDelay + 3200 : 0;
  const deltaEvents = events.filter((e) => typeof e.delta === "number" && e.delta !== 0);
  const tiltable = extraClass.includes("draggable"); // tilt 3D seulement sur les cartes jouables de la main

  // Effet Tilt : la carte s'incline en 3D en suivant la position du curseur.
  // On écrit directement dans des variables CSS (pas de setState) pour rester
  // fluide à 60 FPS sans re-rendu React à chaque mouvement de souris.
  function handleTiltMove(e) {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;  // -0.5 (gauche) à 0.5 (droite)
    const py = (e.clientY - rect.top) / rect.height - 0.5;  // -0.5 (haut) à 0.5 (bas)
    el.style.setProperty("--tilt-x", `${(-py * 14).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${(px * 14).toFixed(2)}deg`);
  }
  function handleTiltLeave(e) {
    const el = e.currentTarget;
    el.style.setProperty("--tilt-x", "0deg");
    el.style.setProperty("--tilt-y", "0deg");
  }

  return (
    <div
      className={`card ${owner} ${flashClasses} ${extraClass} ${selected ? "selected" : ""} ${poisoned ? "card-acide" : ""} ${concealed ? "card-concealed" : ""} ${comboVictimEvent ? `combo-hit-from-${comboVictimEvent.dir}` : ""}`}
      style={comboDelay || pullStyle ? { ...(comboDelay ? { animationDelay: `${comboDelay}ms` } : {}), ...(pullStyle || {}) } : undefined}
      role="button" tabIndex={0} onClick={onClick} onKeyDown={KEY_ACTIVATE(onClick)}
      onPointerDown={onPointerDown}
      onMouseMove={tiltable ? handleTiltMove : undefined}
      onMouseLeave={tiltable ? handleTiltLeave : undefined}
    >
      {card.heroActive && <span className="hero-active-badge" title="Héraut actif">★</span>}
      {porteeEvent && (
        <svg className={`portee-arrow arrow-from-${porteeEvent.dir}`} viewBox="0 0 46 14" width="46" height="14">
          <line x1="4" y1="7" x2="33" y2="7" stroke="var(--portee)" strokeWidth="2.2" strokeLinecap="round" />
          <polygon points="32,2 45,7 32,12" fill="var(--portee)" />
          <path d="M4,7 L11,2.5 M4,7 L11,11.5 M8,7 L15,3.5 M8,7 L15,10.5" stroke="var(--portee)" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </svg>
      )}
      {/* Les piques latérales ont été retirées : à 16 px de large sur une carte de
          téléphone, la dentelure se comblait et se lisait comme une barre blanche pleine.
          Seules les piques haut/bas subsistent ; la poussée de la carte attaquante
          (.flash-percee-self) reste le retour visuel principal de la Percée. */}
      {perceeEvent && (perceeEvent.dir === "top" || perceeEvent.dir === "bottom") && <span className={`percee-spikes spikes-from-${perceeEvent.dir}`} />}
      {guardianEvent && <span className={`guardian-edge edge-from-${guardianEvent.dir}`} />}
      {hiddenFromFoe > 0 && (
        <span className="scribe-hidden-badge" title={`Cachée à l'adversaire, ${hiddenFromFoe} tour(s)`}>
          <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
            <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="2" />
          </svg>
          {hiddenFromFoe}
        </span>
      )}
      {/* Eveil : sur chaque cote qui troque, deux traits de lumiere se croisent le long de
          la bordure partagee — l'un part de la carte, l'autre y arrive. C'est le croisement
          qui doit se lire, pas l'eclat. */}
      {eveilCotes.map((dir) => (
        <span key={`ev-${dir}`} className={`eveil-edge eveil-edge-${dir}`} aria-hidden="true">
          <i className="eveil-flux eveil-flux-out" />
          <i className="eveil-flux eveil-flux-in" />
        </span>
      ))}
      {resonanceShockDir && <span className={`resonance-ring ring-from-${resonanceShockDir}`} />}
      {comboEmitEvent && <span className={`combo-impulse impulse-from-${comboEmitEvent.dir}`} style={{ animationDelay: `${comboDelay}ms` }} />}
      {devouring && (
        <svg className="abysse-tentacles" viewBox="0 0 100 130">
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => (
            <path key={i} d="M50,65 C44,42 47,28 49,16 C49.5,13 50.5,13 51,16 C53,28 56,42 50,65 Z" transform={`rotate(${a} 50 65)`} />
          ))}
        </svg>
      )}
      {deltaEvents.map((e, di) => (
        <span
          key={di}
          className={`delta-badge ${e.delta > 0 ? "delta-pos" : "delta-neg"}`}
          style={{ marginTop: di * 16, animationDelay: e.kind === "maudit-boost" ? `${mauditBoostDelay}ms` : undefined }}
        >
          {e.delta > 0 ? `+${e.delta}` : e.delta}
        </span>
      ))}
      <div className="portrait-frame">
        {card.portrait ? <img src={card.portrait} alt={card.name} style={portraitStyle(card)} /> : <span className="icon">{card.icon}</span>}
      </div>
      <span className={`rank top ${(card.guardianBoostedSides || []).includes("top") ? "rank-boosted" : ""} ${poisoned ? "rank-poisoned" : ""} ${resonanceDirs.includes("top") ? "rank-resonance" : ""} ${eveilCotes.includes("top") ? "rank-eveil" : ""} ${previewResonanceDirs.includes("top") ? "rank-resonance-preview" : ""} ${mauditBoostEvent ? "rank-maudit-boost" : ""}`} style={mauditBoostEvent ? { animationDelay: `${mauditBoostDelay}ms` } : undefined}>{concealed ? "?" : rankLabel(card.top)}</span>
      <span className={`rank right ${(card.guardianBoostedSides || []).includes("right") ? "rank-boosted" : ""} ${poisoned ? "rank-poisoned" : ""} ${resonanceDirs.includes("right") ? "rank-resonance" : ""} ${eveilCotes.includes("right") ? "rank-eveil" : ""} ${previewResonanceDirs.includes("right") ? "rank-resonance-preview" : ""} ${mauditBoostEvent ? "rank-maudit-boost" : ""}`} style={mauditBoostEvent ? { animationDelay: `${mauditBoostDelay}ms` } : undefined}>{concealed ? "?" : rankLabel(card.right)}</span>
      <span className={`rank bottom ${(card.guardianBoostedSides || []).includes("bottom") ? "rank-boosted" : ""} ${poisoned ? "rank-poisoned" : ""} ${resonanceDirs.includes("bottom") ? "rank-resonance" : ""} ${eveilCotes.includes("bottom") ? "rank-eveil" : ""} ${previewResonanceDirs.includes("bottom") ? "rank-resonance-preview" : ""} ${mauditBoostEvent ? "rank-maudit-boost" : ""}`} style={mauditBoostEvent ? { animationDelay: `${mauditBoostDelay}ms` } : undefined}>{concealed ? "?" : rankLabel(card.bottom)}</span>
      <span className={`rank left ${(card.guardianBoostedSides || []).includes("left") ? "rank-boosted" : ""} ${poisoned ? "rank-poisoned" : ""} ${resonanceDirs.includes("left") ? "rank-resonance" : ""} ${eveilCotes.includes("left") ? "rank-eveil" : ""} ${previewResonanceDirs.includes("left") ? "rank-resonance-preview" : ""} ${mauditBoostEvent ? "rank-maudit-boost" : ""}`} style={mauditBoostEvent ? { animationDelay: `${mauditBoostDelay}ms` } : undefined}>{concealed ? "?" : rankLabel(card.left)}</span>
      {mauditBoostEvent && <span className="maudit-swell-fx" style={{ "--maudit-delay": `${mauditBoostDelay}ms` }} />}
    </div>
  );
});

// Génère un identifiant de carte impossible à dupliquer accidentellement,
// même si deux parties venaient à exister en mémoire en même temps (avant, un
// simple compteur partagé pouvait, en théorie, donner le même identifiant à
// deux cartes différentes).
let uidCounter = 0;
function makeCardId() {
  uidCounter += 1;
  return `card-${Date.now()}-${uidCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function buildCard(order, top, right, bottom, left, orientation) {
  return {
    id: makeCardId(),
    name: order.name,
    icon: order.icon,
    portrait: order.portrait,
    ability: order.ability,
    // Numero de quart de tour, 0 a 3. Purement cosmetique : il sert a depareiller le
    // cadrage du portrait pour que les quatre cartes d'un Ordre ne se lisent pas comme
    // la meme image repetee. Ne touche jamais aux rangs ni aux regles.
    orientation: orientation || 0,
    top, right, bottom, left,
    baseTop: top, baseRight: right, baseBottom: bottom, baseLeft: left,
  };
}

// Fait tourner un jeu de rangs d'un cran (haut → droite → bas → gauche → haut)
function rotateSides(sides) {
  return { top: sides.left, right: sides.top, bottom: sides.right, left: sides.bottom };
}

// 4 cartes par Ordre, générées à partir des rangs FIXES de l'Ordre (order.ranks).
// Chaque carte est la précédente tournée à 90°, donc toujours 4 cartes distinctes,
// jamais de doublon, et les valeurs ne changent jamais d'une partie à l'autre.
function makeOrderQuad(order) {
  const [t, l, r, b] = order.ranks;
  let sides = { top: t, left: l, right: r, bottom: b };
  const cards = [];
  for (let i = 0; i < 4; i++) {
    cards.push(buildCard(order, sides.top, sides.right, sides.bottom, sides.left, i));
    sides = rotateSides(sides);
  }
  return cards;
}

function makeHand(orderA, orderB) {
  // Les cartes restent GROUPÉES PAR ORDRE dans la main : les quatre du premier Ordre,
  // puis les quatre du second. Alternées, elles obligeaient le joueur à trier du regard
  // à chaque tour pour comparer deux cartes du même Ordre.
  // Le mélange est conservé mais confiné À L'INTÉRIEUR de chaque groupe : l'ordre des
  // quatre orientations varie toujours d'une partie à l'autre, seuls les groupes ne se
  // croisent plus. Les valeurs des cartes ne sont jamais touchées.
  const melangerQuad = (quad) => {
    const q = quad.slice();
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    return q;
  };
  return [...melangerQuad(makeOrderQuad(orderA)), ...melangerQuad(makeOrderQuad(orderB))];
}

// ---------- Main en éventail ----------
// Regroupe les cartes d'une main par Ordre (via `ability` — jamais `key`, voir le piège
// plus haut), dans l'ordre où elles apparaissent dans la main. Comme makeHand met les 4
// cartes du premier Ordre puis les 4 du second, et que placeCardAt retire une carte par
// simple filter (sans réordonner le reste), les groupes restent naturellement dans cet
// ordre du début à la fin de la partie — même quand ils rétrécissent.
// Chaque carte garde son handIdx D'ORIGINE (sa position réelle dans le tableau de main) :
// c'est CET index, jamais la position dans le groupe, qu'attendent startCardDrag,
// playCard et placeCardAt. Une main normale donne 2 groupes de 4 ; la Confluence et le
// bac à sable, où chaque Ordre n'apporte qu'une seule carte, donnent autant de groupes
// à 1 carte qu'il y a d'Ordres — voir plus bas où les groupes à 1 carte s'affichent
// directement, sans passer par la vignette-éventail.
function groupHandByOrder(hand) {
  const groups = [];
  const byAbility = new Map();
  hand.forEach((card, handIdx) => {
    let g = byAbility.get(card.ability);
    if (!g) {
      g = { ability: card.ability, order: ORDERS.find((o) => o.ability === card.ability), cards: [] };
      byAbility.set(card.ability, g);
      groups.push(g);
    }
    g.cards.push({ card, handIdx });
  });
  return groups;
}

// Position d'une carte au sein de son éventail déployé : rotation + décalage horizontal
// autour d'un pivot commun ancré sur la vignette, plus un léger arc (les cartes des
// extrémités s'écartent un peu plus du pivot que celles du centre). "sens" inverse le
// signe de la rotation/du décalage vertical : la main Azur (en bas de l'écran) s'ouvre
// VERS le plateau donc vers le haut ; la main Écarlate (en haut) s'ouvre vers le bas.
// Consommé par les variables CSS --fan-x/--fan-y/--fan-rot (voir .card-fan plus bas) —
// jamais en modifiant .rank, qui a sa propre logique de centrage (voir le piège dédié).
//
// Écartement exprimé en % de la largeur PROPRE de chaque carte, pas en pixels fixes :
// translateX en % se réfère nativement à la largeur de l'élément qui le porte, donc ça
// s'adapte tout seul à n'importe quelle taille d'écran SANS perdre la garantie ci-dessous.
// 112% (>100%) garantit qu'une carte ne chevauche jamais sa voisine : en pixels fixes
// (ancienne version), deux cartes proches du centre pouvaient se recouvrir assez pour
// cacher le rang "droite" de l'une sous le bord de l'autre — repéré par Alexandre en
// testant. Avec un écart toujours ≥ une largeur de carte, les 4 rangs de chaque carte
// restent visibles en permanence, sans avoir besoin de toucher une carte pour la lire.
function fanSlotVars(i, n, sens) {
  const mid = (n - 1) / 2;
  const c = i - mid;
  const angle = c * 9;
  const spreadPercent = c * 112;
  const liftPercent = Math.abs(c) * 4;
  return {
    "--fan-x": `${spreadPercent}%`,
    "--fan-y": `${sens === "haut" ? -liftPercent : liftPercent}%`,
    "--fan-rot": `${sens === "haut" ? angle : -angle}deg`,
    "--fan-delay": `${i * 35}ms`,
    zIndex: 10 + i,
  };
}

// Confluence : chaque camp reçoit UNE carte de chaque Ordre du pool — la première des
// quatre, donc la même pour les deux joueurs. Exception pour les Ordres à dissimulation
// (les Scribes) : deux jumelles rendraient le masquage inutile, l'adversaire aurait la
// réponse sous les yeux. Leur orientation est donc tirée au hasard, séparément pour
// chaque camp. Les valeurs ne changent pas : seul le côté où se trouve chaque rang
// change — exactement le secret que les Scribes ont en partie normale. Le tirage est
// volontairement indépendant, SANS garantir deux orientations différentes : garantir
// « jamais la même » donnerait un indice à l'adversaire (il pourrait rayer sa propre
// orientation de la liste des possibles).
// FUTUR EN LIGNE : si la Confluence arrive en multijoueur, ce tirage devra être fait
// une seule fois par l'hôte et écrit dans Firestore, comme tout tirage au sort —
// sinon les deux écrans montreraient des cartes différentes.
function carteConfluence(order) {
  const quad = makeOrderQuad(order);
  return order.ability === "scribe" ? quad[Math.floor(Math.random() * 4)] : quad[0];
}

// Marque toutes les cartes de l'Ordre concerné (identifié par sa clé, ex: "cendres") avec
// heroActive: true, si un héros est actif pour cette main. Sans effet si heroOrderKey est
// null ou ne correspond à aucune carte de la main (Ordre non choisi cette partie).
function applyHeroToHand(hand, heroOrderKey) {
  if (!heroOrderKey) return hand;
  const order = ORDERS.find((o) => o.key === heroOrderKey);
  if (!order) return hand;
  return hand.map((c) => (c.ability === order.ability ? { ...c, heroActive: true } : c));
}

// Mode test uniquement : active TOUS les Hérauts définis d'un coup, sur toute une main,
// pour pouvoir tester rapidement chaque capacité supérieure sans passer par le mode Histoire.
// Dorés et Chimères n'ont pas de Héraut (voir HEROES) : leurs cartes ne sont pas concernées.
// Active uniquement les Hérauts déjà gagnés (chapitres terminés). C'est ce que promet
// le commentaire de STORY_CHAPTERS : battre le Seigneur de Guerre débloque le Héraut
// « pour de bon ». Sans cet appel, le joueur ne récupérait jamais ce qu'il avait gagné.
function applyEarnedHeroesToHand(hand, completedChapters) {
  if (!completedChapters || completedChapters.length === 0) return hand;
  const abilities = new Set(
    completedChapters.map((k) => ORDERS.find((o) => o.key === k)?.ability).filter(Boolean)
  );
  return hand.map((c) => (abilities.has(c.ability) ? { ...c, heroActive: true } : c));
}

function applyAllHeroesToHand(hand) {
  const heroAbilities = new Set(HEROES.map((h) => ORDERS.find((o) => o.key === h.orderKey)?.ability).filter(Boolean));
  return hand.map((c) => (heroAbilities.has(c.ability) ? { ...c, heroActive: true } : c));
}

const DIRS = [
  { dr: -1, dc: 0, my: "top", their: "bottom" },
  { dr: 0, dc: 1, my: "right", their: "left" },
  { dr: 1, dc: 0, my: "bottom", their: "top" },
  { dr: 0, dc: -1, my: "left", their: "right" },
];

function idx(r, c) { return r * COLS + c; }
function inBounds(r, c) { return r >= 0 && r <= ROWS - 1 && c >= 0 && c <= COLS - 1; }

// ---------- Capture resolution ----------
// Rempart (Gardiens) : gagne +1 sur le rang attaqué en défense, quel que soit le
// côté touché (gauche, haut, bas ou droite) — jamais stocké, jamais permanent,
// purement une lecture différente au moment de la comparaison de combat.
function defRank(card, side) {
  if (card.ability === "guardian") {
    // Le bouclier a déjà été payé si les Dorés viennent d'échanger ce côté-là : c'est le
    // rang défensif (bouclier compris) que l'Éveil a pris, le Gardien ne peut pas le
    // remettre par-dessus la valeur qu'il vient de recevoir en échange, sinon il le
    // compterait deux fois et le troc perdrait tout son sens.
    if ((card.eveilSansBouclier || []).includes(side)) return card[side];
    return card[side] + 1;
  }
  return card[side];
}

// Attaque (Gardiens) : SEUL le Héraut des Gardiens ajoute +1 sur le rang d'ATTAQUE,
// en plus du +1 défensif de base (defRank). Sans Héraut, l'attaque reste brute.
function atkRank(card, side) {
  if (card.ability === "guardian" && card.heroActive) {
    return card[side] + 1;
  }
  return card[side];
}

function poisonPenalty(card) {
  return {
    ...card,
    top: Math.max(0, card.top - 1),
    right: Math.max(0, card.right - 1),
    bottom: Math.max(0, card.bottom - 1),
    left: Math.max(0, card.left - 1),
  };
}

// Une case empoisonnée vaut soit `true` (empoisonne tout le monde, poison classique), soit
// le camp du poseur (Héraut des Pestiférés actif : épargne ce camp précis). cardOwner est
// le camp de la carte qui arrive/traverse cette case.
// Le poison d'une case est une PILE de marques. Chaque marque vaut -1 rang.
// Une marque vaut `true` (nuit à tout le monde) ou le nom d'un camp (Héraut des
// Pestiférés : ne nuit qu'au camp adverse). Une case propre reste `false`, pour que
// l'interface puisse continuer à tester simplement `poisonedCells[i]`.
// Les anciennes parties sauvegardées contiennent `true` ou un nom de camp : on les
// accepte encore et on les traite comme une pile d'une seule marque.
const POISON_MAX = 4; // profondeur maximale d'une case (-4 rangs). Une seule valeur à changer.

function poisonMarques(poisonValue) {
  if (!poisonValue) return [];
  if (Array.isArray(poisonValue)) return poisonValue;
  return [poisonValue]; // ancien format : true ou "blue"/"red"
}

// Nombre de marques qui nuisent RÉELLEMENT à ce camp (0 = case inoffensive pour lui).
function poisonCount(poisonValue, cardOwner) {
  return poisonMarques(poisonValue).filter(
    (m) => m === true || (typeof m === "string" && m !== cardOwner)
  ).length;
}

function poisonHarms(poisonValue, cardOwner) {
  return poisonCount(poisonValue, cardOwner) > 0;
}

// ---------- Poison et Firestore ----------
// Une case empoisonnee porte une PILE de marques, donc poisonedCells est un tableau de
// tableaux. Firestore refuse net les tableaux imbriques ("Nested arrays are not
// supported") : sans encodage, la premiere case empoisonnee faisait echouer l'ecriture du
// coup, et plus rien ne se synchronisait de la partie. On aplatit donc chaque case en une
// chaine ("" si saine, "blue", "blue|red", "*" pour une marque de l'ancien format).
function encoderPoison(valeur) {
  const pile = poisonMarques(valeur);
  if (!pile.length) return "";
  return pile.map((m) => (m === true ? "*" : String(m))).join("|");
}

function decoderPoison(valeur) {
  if (Array.isArray(valeur)) return valeur; // deja au bon format (sauvegarde locale)
  if (typeof valeur !== "string") return valeur ? [true] : false;
  if (!valeur) return false;
  return valeur.split("|").map((m) => (m === "*" ? true : m));
}

function decoderPoisonPlateau(liste) {
  if (!Array.isArray(liste)) return Array(CELLS).fill(false);
  return liste.map(decoderPoison);
}

// ---------- Detection des combos pendant la partie ----------
// Appelee UNE FOIS par coup reellement joue, depuis placeCardAt — jamais depuis
// resolvePlacement, qui tourne aussi sur les survols et les simulations du bot et
// compterait alors des combos qui n'ont jamais eu lieu.
//
// La fonction met a jour le suivi de partie (pour les deux camps : l'adversaire nourrit
// certains combos, comme le Maudit qu'il vous prend) et renvoie les combos que CE coup
// vient de realiser pour le camp du joueur.
function combosDuCoup(ctx) {
  const { card, position, owner, monCamp, mesOrdres, events,
          plateauAvant, plateauApres, poisonAvant, poisonApres, suivi } = ctx;
  const trouves = [];
  const a = (cle) => mesOrdres.has(cle);
  const marque = (cle) => { if (!suivi.reussis.has(cle)) { suivi.reussis.add(cle); trouves.push(cle); } };

  // --- Suivi alimente par les DEUX camps ---

  // Cases dont la pile de marques a grossi pendant ce coup : c'est owner qui les a
  // empoisonnees. On ne peut pas le lire sur le plateau (une marque sans Heraut vaut
  // "true" et ne dit pas qui l'a posee), d'ou ce releve au moment ou ca se produit.
  for (let i = 0; i < poisonApres.length; i++) {
    if (poisonMarques(poisonApres[i]).length > poisonMarques(poisonAvant[i]).length && owner === monCamp) {
      suivi.mesPoisons.add(i);
    }
  }

  // Cartes retournees par une mue : suivies par identifiant, car l'Attraction les deplace.
  events.forEach((e) => {
    if (e.kind === "mue" && plateauApres[e.index]) suivi.mues.add(plateauApres[e.index].id);
  });

  // Changements de camp de ce coup, par identifiant de carte (les index bougent).
  // En ligne, les coups de l'adversaire n'arrivent pas par ici mais par l'ecouteur
  // Firestore : on ne peut donc PAS reperer le vol au moment ou il se produit. On note
  // plutot, apres chacun de mes coups, les Maudits qui sont alors sous mes couleurs ; si
  // l'un d'eux revient plus tard chez moi apres etre passe chez l'adversaire, c'est une
  // Rancon — et cette lecture vaut aussi bien contre un Echo qu'en ligne.
  const campAvant = new Map();
  plateauAvant.forEach((c) => { if (c) campAvant.set(c.id, c.owner); });
  let mauditRachete = false, abysseVolee = false;
  plateauApres.forEach((c) => {
    if (!c) return;
    const ancien = campAvant.get(c.id);
    if (ancien === undefined || ancien === c.owner) return;
    if (c.ability === "maudit" && c.owner === monCamp && suivi.mauditsMiens.has(c.id)) mauditRachete = true;
    if (c.ability === "devoreuse" && c.owner === monCamp) abysseVolee = true;
  });

  // --- A partir d'ici, seuls MES coups peuvent creer un combo ---
  if (owner !== monCamp) return trouves;
  suivi.coups += 1;

  // Une capture porte sur une AUTRE case que celle qu'on vient de jouer : plusieurs effets
  // emettent aussi un evenement du meme nom sur la carte posee, en simple signal visuel.
  const victimes = (kind) => events.filter((e) => e.kind === kind && e.index !== position);

  // 1. L'Or Corrompu : un Dore pose sur une case que j'ai empoisonnee et qui me nuit
  // vraiment (avec le Heraut des Pestiferes, le venin epargne mon camp : pas de combo).
  if (a("eveil") && a("poison") && card.ability === "eveil"
      && suivi.mesPoisons.has(position) && poisonHarms(poisonAvant[position], monCamp)) {
    marque("or-corrompu");
  }

  // 2. La Rancon : un Maudit que l'adversaire m'avait pris revient chez moi.
  if (a("maudits") && a("eveil") && mauditRachete) marque("rancon");

  // 3. La Traine au Venin : une carte tiree par les Cendres a traverse du poison. Le moteur
  // signale la penalite par un evenement "poison" negatif sur la case d'arrivee.
  if (a("cendres") && a("poison")) {
    const tirees = victimes("attraction-pull").map((e) => e.index);
    if (events.some((e) => e.kind === "poison" && e.delta < 0 && tirees.includes(e.index))) {
      marque("traine-venin");
    }
    if (tirees.length) suivi.dernierAttraction = suivi.coups;
  } else if (a("cendres") && events.some((e) => e.kind === "attraction-pull")) {
    suivi.dernierAttraction = suivi.coups;
  }

  // 4. La Maree Montante : voler une Abysse a l'adversaire quand on en aligne soi-meme.
  if (a("devoreuse") && abysseVolee) marque("maree-montante");

  // 5. Le Miroir Truque : l'Eveil frappe une carte deja retournee par une mue.
  if (a("mue") && a("eveil")
      && victimes("eveil").some((e) => plateauApres[e.index] && suivi.mues.has(plateauApres[e.index].id))) {
    marque("miroir-truque");
  }

  // 6. Le Trait Voile : un Archer pose pendant qu'un de mes voiles de Scribe tient encore.
  if (a("scribes") && a("portee") && card.ability === "portee"
      && plateauAvant.some((c) => c && c.scribeJustPlaced && c.scribePlacedBy === monCamp)) {
    marque("trait-voile");
  }

  // 7. La Battue : une capture a distance dans les deux coups qui suivent une attirance.
  if (a("cendres") && a("portee") && victimes("portee").length
      && suivi.dernierAttraction !== null && suivi.coups - suivi.dernierAttraction <= 2) {
    marque("battue");
  }

  // 8. La Breche : une percee qui aboutit sur une carte retournee par une mue.
  if (a("mue") && a("percee")
      && victimes("percee").some((e) => plateauApres[e.index] && suivi.mues.has(plateauApres[e.index].id))) {
    marque("breche");
  }

  // 9. La Fosse : une Abysse posee au contact d'une case que j'ai empoisonnee.
  if (a("devoreuse") && a("poison") && card.ability === "devoreuse") {
    const r = Math.floor(position / COLS), c = position % COLS;
    const voisines = DIRS
      .map((d) => (inBounds(r + d.dr, c + d.dc) ? idx(r + d.dr, c + d.dc) : null))
      .filter((i) => i !== null);
    if (voisines.some((i) => suivi.mesPoisons.has(i))) marque("fosse");
  }

  // Releve de fin de coup : les Maudits actuellement a moi. C'est la seule occasion de les
  // voir sous mes couleurs avant que l'adversaire ne joue.
  plateauApres.forEach((c) => {
    if (c && c.ability === "maudit" && c.owner === monCamp) suivi.mauditsMiens.add(c.id);
  });

  return trouves;
}

// Le Rempart Vicie ne se lit qu'a la fin : c'est une facon de gagner, pas un coup.
function comboDeFin(ctx) {
  const { mesOrdres, gagne, poison, suivi } = ctx;
  if (!gagne || !mesOrdres.has("guardian") || !mesOrdres.has("poison")) return null;
  const actives = poison.filter((v) => poisonMarques(v).length > 0).length;
  if (actives < 3 || suivi.reussis.has("rempart-vicie")) return null;
  suivi.reussis.add("rempart-vicie");
  return "rempart-vicie";
}

// Ajoute une marque à une case, sans dépasser POISON_MAX.
function poisonAjoute(poisonValue, marque) {
  const pile = poisonMarques(poisonValue);
  if (pile.length >= POISON_MAX) return pile;
  return [...pile, marque];
}

// ---------------------------------------------------------------------------
// capaciteOffensive — les capacites qui FRAPPENT une voisine, en un seul endroit.
// Appelee pour la carte qu'on pose, et pour chaque carte capturee par une Onde : c'est
// ce qui permet a une Chimere capturee de retourner un rang a son tour.
// Renvoie la liste des cases nouvellement capturees, pour alimenter la chaine.
//
// Ne sont PAS ici, volontairement :
//  - l'attraction des Cendres : elle deplace une carte a travers le plateau, ce qui
//    n'a de sens qu'a la pose (decision d'Alexandre) ;
//  - le poison des Pestiferes, le bonus des Abysses, l'echange des Dores : ce sont des
//    effets de POSE, pas des attaques, et ils restent dans resolvePlacement.
// ---------------------------------------------------------------------------
function capaciteOffensive(board, from, player, events, comboLevel, eveilEcarts) {
  const carte = board[from];
  const prises = [];
  if (!carte) return prises;
  const fr = Math.floor(from / COLS), fc = from % COLS;
  const niveau = comboLevel === undefined ? undefined : comboLevel;

  // DORES — l'Eveil, au service du nouveau camp : echange de rangs avec chaque ennemie
  // adjacente (le rang defensif de l'ennemie contre le sien), puis re-jugement immediat,
  // exactement comme a la pose. C'est l'identite de l'Ordre : il bat plus fort que lui.
  // Les ecarts sont pousses dans eveilEcarts pour etre annules en fin de resolution
  // (seules les captures restent acquises), comme pour l'Eveil de pose.
  if (carte.ability === "eveil" && eveilEcarts) {
    DIRS.forEach((d) => {
      const nr = fr + d.dr, nc = fc + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      const cell = board[ni];
      if (cell && cell.owner !== player) {
        const courant = board[from];
        const myRank = courant[d.my];
        const theirRank = defRank(cell, d.their);
        board[from] = { ...courant, [d.my]: theirRank };
        board[ni] = {
          ...cell,
          [d.their]: myRank,
          eveilSansBouclier: [...(cell.eveilSansBouclier || []), d.their],
        };
        eveilEcarts.push({ index: from, side: d.my, ecart: theirRank - myRank });
        eveilEcarts.push({ index: ni, side: d.their, ecart: myRank - cell[d.their] });
        events.push({ index: ni, kind: "eveil", dir: d.their, comboLevel: niveau });
        events.push({ index: from, kind: "eveil-self", dir: d.my, comboLevel: niveau });
        // Re-jugement avec les rangs echanges : l'echange peut suffire a faire tomber la carte.
        if (atkRank(board[from], d.my) > defRank(board[ni], d.their)) {
          board[ni] = { ...board[ni], owner: player };
          events.push({ index: ni, kind: "combo", dir: d.their, comboLevel: (niveau || 0) + 1 });
          prises.push(ni);
        }
      }
    });
  }

  // CHIMERES — retourne le rang de chaque ennemie adjacente sur l'axe attaque.
  if (carte.ability === "mue") {
    let touche = false;
    DIRS.forEach((d) => {
      const nr = fr + d.dr, nc = fc + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      const cell = board[ni];
      if (cell && cell.owner !== player) {
        const horizontal = d.my === "left" || d.my === "right";
        board[ni] = horizontal
          ? { ...cell, left: cell.right, right: cell.left }
          : { ...cell, top: cell.bottom, bottom: cell.top };
        events.push({ index: ni, kind: "mue", axis: horizontal ? "h" : "v", comboLevel: niveau });
        touche = true;
        // Le retournement peut suffire a faire tomber la carte : on rejuge apres coup.
        if (atkRank(carte, d.my) > defRank(board[ni], d.their)) {
          board[ni] = { ...board[ni], owner: player };
          events.push({ index: ni, kind: "combo", dir: d.their, comboLevel: (niveau || 0) + 1 });
          prises.push(ni);
        }
      }
    });
    if (touche) events.push({ index: from, kind: "mue-self", comboLevel: niveau });
  }

  // PIQUES — transperce jusqu'a 2 cartes alignees (3 avec le Heraut).
  if (carte.ability === "percee") {
    let touche = false;
    DIRS.forEach((d) => {
      let nr = fr + d.dr, nc = fc + d.dc;
      let perces = 0;
      while (inBounds(nr, nc) && perces < (carte.heroActive ? 3 : 2)) {
        const ni = idx(nr, nc);
        const cell = board[ni];
        if (!cell || cell.owner === player) break;
        if (atkRank(carte, d.my) > defRank(cell, d.their)) {
          board[ni] = { ...cell, owner: player };
          events.push({ index: ni, kind: "percee", dir: d.my, comboLevel: niveau });
          prises.push(ni);
          touche = true;
          perces += 1;
          nr += d.dr; nc += d.dc;
        } else break;
      }
    });
    if (touche) events.push({ index: from, kind: "percee-self", comboLevel: niveau });
  }

  // ARCHERS — la fleche part en ligne droite jusqu'a la premiere ennemie.
  if (carte.ability === "portee") {
    let touche = false;
    DIRS.forEach((d) => {
      let nr = fr + d.dr, nc = fc + d.dc;
      while (inBounds(nr, nc)) {
        const ni = idx(nr, nc);
        const cell = board[ni];
        if (cell) {
          if (cell.owner === player) {
            if (carte.heroActive) { nr += d.dr; nc += d.dc; continue; }
            break;
          }
          if (atkRank(carte, d.my) > defRank(cell, d.their)) {
            board[ni] = { ...cell, owner: player };
            events.push({ index: ni, kind: "portee", dir: d.their, comboLevel: niveau });
            prises.push(ni);
            touche = true;
          }
          break;
        }
        nr += d.dr; nc += d.dc;
      }
    });
    if (touche) events.push({ index: from, kind: "portee", comboLevel: niveau });
  }

  return prises;
}

function resolvePlacement(board, position, player, poisonedCells) {
  let newBoard = board.slice();
  let newPoison = (poisonedCells || Array(CELLS).fill(false)).slice();
  const r = Math.floor(position / COLS);
  const c = position % COLS;
  const events = [];

  let placedCard = { ...newBoard[position] };

  // Case empoisonnée : toute carte qui s'y pose perd 1 rang sur tous les côtés — sauf si
  // c'est un allié du Pestiférés qui a posé le poison ET que son Héraut est actif (auquel
  // cas la case reste "poisoned" pour tout le monde, mais épargne ce camp précis).
  const poisonHere = newPoison[position];
  const poisonHereCount = poisonCount(poisonHere, player);
  if (poisonHereCount > 0) {
    for (let i = 0; i < poisonHereCount; i++) placedCard = poisonPenalty(placedCard);
    events.push({ index: position, kind: "poison", delta: -1 });
  }

  if (placedCard.ability === "devoreuse") {
    // Le bonus doit s'appliquer AVANT le combat : compte les Abysses déjà possédées
    // (celle qu'on vient de poser est déjà sur newBoard à ce stade).
    const ownCount = newBoard.filter((cell) => cell && cell.owner === player && cell.ability === "devoreuse").length;
    // Héraut des Abysses : +2 d'un bloc, même seule en jeu.
    const bonus = Math.max(0, ownCount - 1) + (placedCard.heroActive ? 2 : 0);
    if (bonus > 0) {
      placedCard = {
        ...placedCard,
        top: placedCard.baseTop + bonus,
        right: placedCard.baseRight + bonus,
        bottom: placedCard.baseBottom + bonus,
        left: placedCard.baseLeft + bonus,
      };
      events.push({ index: position, kind: "devoreuse", delta: bonus });
    }
  }

  // ÉVEIL (Dorés) — échange TEMPORAIRE. Le rang exposé est échangé avec chaque ennemie
  // adjacente, le combat se résout avec ces valeurs (une attaque perdante peut donc
  // basculer en victoire), puis les rangs reviennent à la normale en fin de résolution.
  // Les captures obtenues pendant l'échange, elles, restent acquises.
  // On mémorise les ÉCARTS appliqués (et non les valeurs absolues) pour pouvoir les annuler
  // sans écraser les autres effets du tour (poison, boost des Maudits...).
  const eveilEcarts = [];
  if (placedCard.ability === "eveil") {
    let eveilTriggered = false;
    DIRS.forEach((d) => {
      const nr = r + d.dr, nc = c + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      const cell = newBoard[ni];
      if (cell && cell.owner !== player) {
        const myRank = placedCard[d.my];
        // Le bouclier du Gardien compte AVANT l'échange : l'Éveil échange contre son
        // rang défensif (+1), pas son rang brut.
        const theirRank = defRank(cell, d.their);
        placedCard = { ...placedCard, [d.my]: theirRank };
        // Le côté échangé est marqué : son bouclier vient d'être transféré aux Dorés,
        // il ne se réapplique pas au combat qui suit. Marque purement temporaire, effacée
        // en fin de résolution avec les écarts de rang.
        newBoard[ni] = {
          ...cell,
          [d.their]: myRank,
          eveilSansBouclier: [...(cell.eveilSansBouclier || []), d.their],
        };
        eveilEcarts.push({ index: position, side: d.my, ecart: theirRank - myRank });
        eveilEcarts.push({ index: ni, side: d.their, ecart: myRank - cell[d.their] });
        // dir : le cote CONCERNE par l'echange, vu de chaque carte. C'est lui qui permet
        // a l'animation de tracer le troc le long de la bordure partagee.
        events.push({ index: ni, kind: "eveil", dir: d.their });
        events.push({ index: position, kind: "eveil-self", dir: d.my });
        eveilTriggered = true;
      }
    });
    // (les evenements "eveil-self" sont maintenant emis cote par cote, juste au-dessus)
  }

  newBoard[position] = placedCard;

  if (placedCard.ability === "guardian") {
    events.push({ index: position, kind: "guardian-place" });
  }

  if (placedCard.ability === "poison") {
    // Empoisonne les 4 cases adjacentes (les cases elles-mêmes, pas les cartes
    // qui s'y trouvent déjà) : tout ce qui s'y posera ensuite perdra 1 rang partout.
    // Héraut des Pestiférés : on marque la case avec le camp du poseur (au lieu de `true`)
    // pour pouvoir épargner ses propres alliés à l'arrivée, sans changer l'effet pour l'adversaire.
    DIRS.forEach((d) => {
      const nr = r + d.dr, nc = c + d.dc;
      if (!inBounds(nr, nc)) return;
      const ci = idx(nr, nc);
      newPoison[ci] = poisonAjoute(newPoison[ci], placedCard.heroActive ? player : true);
    });
    events.push({ index: position, kind: "poison" });
  }

  if (placedCard.ability === "mue") {
    // Retourne le rang de chaque ennemie adjacente, mais UNIQUEMENT sur l'axe attaqué :
    // attaquée à gauche ou à droite → seul gauche ↔ droite pivote (haut/bas inchangés) ;
    // attaquée en haut ou en bas → seul haut ↔ bas pivote (gauche/droite inchangés).
    let mueTriggered = false;
    DIRS.forEach((d) => {
      const nr = r + d.dr, nc = c + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      const cell = newBoard[ni];
      if (cell && cell.owner !== player) {
        const horizontal = d.my === "left" || d.my === "right";
        newBoard[ni] = horizontal
          ? { ...cell, left: cell.right, right: cell.left }
          : { ...cell, top: cell.bottom, bottom: cell.top };
        events.push({ index: ni, kind: "mue", axis: horizontal ? "h" : "v" });
        mueTriggered = true;
      }
    });
    if (mueTriggered) events.push({ index: position, kind: "mue-self" });
  }

  // --- Effets spécifiques de capacité : viennent EN PLUS de la résolution Résonance/Onde ci-dessous ---
  if (placedCard.ability === "attraction") {
    let attractionTriggered = false;
    DIRS.forEach((d) => {
      let nr = r + d.dr, nc = c + d.dc;
      let steps = 0;
      let foundIdx = null;
      const pathCells = []; // toutes les cases vides traversées par la carte attirée, y compris la case d'arrivée
      while (inBounds(nr, nc)) {
        const ni = idx(nr, nc);
        if (newBoard[ni]) { foundIdx = ni; break; }
        pathCells.push(ni);
        nr += d.dr; nc += d.dc; steps++;
      }
      if (foundIdx === null) return;
      const target = newBoard[foundIdx];
      const adjacentIdx = idx(r + d.dr, c + d.dc);

      if (steps > 0) {
        // Cases vides entre les deux : on tire la carte (alliée ou ennemie) jusqu'à la case adjacente
        newBoard[adjacentIdx] = target;
        newBoard[foundIdx] = null;
        events.push({ index: adjacentIdx, kind: "attraction-pull", dir: d.my, steps });
        attractionTriggered = true;
        // La carte perd -1 par case empoisonnée effectivement traversée sur son chemin (la case
        // d'arrivée comprise) — cumulatif : 2 cases empoisonnées traversées = -2, pas juste -1.
        const poisonHits = pathCells.reduce((s, ci) => s + poisonCount(newPoison[ci], target.owner), 0);
        if (poisonHits > 0) {
          for (let i = 0; i < poisonHits; i++) newBoard[adjacentIdx] = poisonPenalty(newBoard[adjacentIdx]);
          events.push({ index: adjacentIdx, kind: "poison", delta: -poisonHits });
        }
      }

      if (target.owner !== player) {
        // Seules les cartes ennemies peuvent être capturées après avoir été attirées
        const pulledCard = newBoard[adjacentIdx];
        if (placedCard[d.my] > defRank(pulledCard, d.their)) {
          newBoard[adjacentIdx] = { ...pulledCard, owner: player };
          events.push({ index: adjacentIdx, kind: "attraction" });
          attractionTriggered = true;
        }
      }

      // Héraut des Cendres : une 2e carte alignée est toujours attirée aussi, jusqu'à la case
      // juste derrière la 1re (P+2) — que la 1re ait eu un espace devant elle ou qu'elle ait
      // déjà été collée à la Cendres. La 1re finit toujours en P+1, la 2e vient se coller en P+2.
      if (placedCard.heroActive) {
        const s2r = r + d.dr * 2, s2c = c + d.dc * 2;
        const secondSlotIdx = inBounds(s2r, s2c) ? idx(s2r, s2c) : null;
        if (secondSlotIdx !== null && !newBoard[secondSlotIdx]) {
          let nr2 = r + d.dr * 3, nc2 = c + d.dc * 3;
          let secondFoundIdx = null;
          const secondPathCells = [secondSlotIdx]; // case d'arrivée comprise dans le calcul du poison
          while (inBounds(nr2, nc2)) {
            const ni2 = idx(nr2, nc2);
            if (newBoard[ni2]) { secondFoundIdx = ni2; break; }
            secondPathCells.push(ni2);
            nr2 += d.dr; nc2 += d.dc;
          }
          if (secondFoundIdx !== null) {
            const secondTarget = newBoard[secondFoundIdx];
            newBoard[secondSlotIdx] = secondTarget;
            newBoard[secondFoundIdx] = null;
            events.push({ index: secondSlotIdx, kind: "attraction-pull", dir: d.my, steps: secondPathCells.length });
            attractionTriggered = true;
            const secondPoisonHits = secondPathCells.reduce((s, ci) => s + poisonCount(newPoison[ci], secondTarget.owner), 0);
            if (secondPoisonHits > 0) {
              for (let i = 0; i < secondPoisonHits; i++) newBoard[secondSlotIdx] = poisonPenalty(newBoard[secondSlotIdx]);
              events.push({ index: secondSlotIdx, kind: "poison", delta: -secondPoisonHits });
            }
            if (secondTarget.owner !== player) {
              const pulledSecond = newBoard[secondSlotIdx];
              if (placedCard[d.my] > defRank(pulledSecond, d.their)) {
                newBoard[secondSlotIdx] = { ...pulledSecond, owner: player };
                events.push({ index: secondSlotIdx, kind: "attraction" });
              }
            }
          }
        }
      }
    });
    events.push({ index: position, kind: "attraction" }); // toujours un flash à la pose, même sans cible
  }

  if (placedCard.ability === "percee") {
    let perceeTriggered = false;
    DIRS.forEach((d) => {
      let nr = r + d.dr, nc = c + d.dc;
      let pierced = 0; // nombre de cartes déjà transpercées dans cette direction
      while (inBounds(nr, nc) && pierced < (placedCard.heroActive ? 3 : 2)) { // Piques : transperce 2 cartes (3 avec le héros)
        const ni = idx(nr, nc);
        const cell = newBoard[ni];
        if (!cell || cell.owner === player) break;
        if (placedCard[d.my] > defRank(cell, d.their)) {
          newBoard[ni] = { ...cell, owner: player };
          // dir: d.my (pas d.their) — le pic doit jaillir du côté OPPOSÉ à l'impact,
          // dans le sens de la poussée, comme une pique qui transperce et ressort de l'autre côté.
          events.push({ index: ni, kind: "percee", dir: d.my });
          perceeTriggered = true;
          pierced += 1;
          nr += d.dr; nc += d.dc;
        } else break;
      }
    });
    if (perceeTriggered) events.push({ index: position, kind: "percee-self" });
  }

  if (placedCard.ability === "portee") {
    let porteeTriggered = false;
    DIRS.forEach((d) => {
      let nr = r + d.dr, nc = c + d.dc;
      // Héraut des Archers : la flèche traverse TOUTES les cartes alliées de la ligne et
      // ne s'arrête que sur une ennemie ou au bord du plateau. La variante « une seule
      // alliée » a été mesurée : écart de +0,2 point seulement, car deux alliées alignées
      // devant une ennemie n'arrivent que dans 8 % des cas sur un plateau 4×5. La règle
      // catégorique a été retenue pour la lisibilité, pas pour la puissance.
      while (inBounds(nr, nc)) {
        const ni = idx(nr, nc);
        const cell = newBoard[ni];
        if (cell) {
          if (cell.owner === player) {
            if (placedCard.heroActive) { nr += d.dr; nc += d.dc; continue; }
            break;
          }
          if (placedCard[d.my] > defRank(cell, d.their)) {
            newBoard[ni] = { ...cell, owner: player };
            events.push({ index: ni, kind: "portee", dir: d.their });
            porteeTriggered = true;
          }
          break;
        }
        nr += d.dr; nc += d.dc;
      }
    });
    if (porteeTriggered) events.push({ index: position, kind: "portee" });
  }

  // --- Résolution standard : Résonance + capture de base + Onde, s'applique TOUJOURS,
  // quel que soit l'Ordre (en plus de sa capacité spéciale ci-dessus) ---
  {
    // Deux listes distinctes, et c'est tout l'enjeu de la Resonance :
    //  - voisinsTous : TOUTES les cartes adjacentes, alliees comprises. Elles servent a
    //    DECLENCHER la resonance — un rang qui repond a celui d'une carte a soi resonne
    //    tout autant qu'avec une carte ennemie.
    //  - neighbors : les ennemies seules. Ce sont les seules qu'on puisse CAPTURER.
    // Avant, les alliees etaient purement ignorees : une carte a soi au meme rang plus une
    // ennemie au meme rang ne declenchait rien, alors que les deux rangs se repondaient.
    const voisinsTous = [];
    const neighbors = [];
    DIRS.forEach((d) => {
      const nr = r + d.dr, nc = c + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      const cell = newBoard[ni];
      if (!cell) return;
      voisinsTous.push({ index: ni, dir: d, card: cell });
      if (cell.owner !== player) neighbors.push({ index: ni, dir: d, card: cell });
    });

    // Rempart : petit flash visuel sur Gardiens dès que son bouclier entre en jeu
    // (gauche, haut ou bas), qu'il finisse par résister ou non.
    neighbors.forEach((n) => {
      if (n.card.ability === "guardian") {
        events.push({ index: n.index, kind: "guardian", delta: 1, dir: n.dir.their });
      }
    });

    // RESONANCE — une seule condition, celle de la regle : au moins DEUX rangs
    // EXACTEMENT identiques parmi toutes les voisines, alliees comprises. Une alliee au
    // meme rang compte donc pour declencher, mais ne sera jamais capturee.
    // Ce qui a ete retire ici : la tolerance maison "rangs proches a plus ou moins 1", et
    // le declenchement sur UN seul rang identique des qu'il y avait deux voisines. Mesure
    // avant correction sur 30 000 poses : 92,1 % des Resonances partaient hors regle
    // (47,3 % sur un seul rang egal, 44,8 % sans aucun rang egal).
    const exactTous = voisinsTous.filter((n) => atkRank(placedCard, n.dir.my) === defRank(n.card, n.dir.their));
    // La CAPTURE ne concerne que les ennemies, et seulement au rang exactement egal.
    const sameMatches = neighbors.filter((n) => atkRank(placedCard, n.dir.my) === defRank(n.card, n.dir.their));
    const basicMatches = neighbors.filter((n) => atkRank(placedCard, n.dir.my) > defRank(n.card, n.dir.their));
    const captured = new Set();
    // sameMatches >= 1 : une Resonance entre alliees seules n'aurait aucune carte a
    // retourner, donc rien a montrer a l'ecran.
    const sameTriggered = exactTous.length >= 2 && sameMatches.length >= 1;
    if (sameTriggered) sameMatches.forEach((n) => captured.add(n.index));
    basicMatches.forEach((n) => captured.add(n.index));

    captured.forEach((ni) => {
      newBoard[ni] = { ...newBoard[ni], owner: player };
      const matched = sameTriggered && sameMatches.find((n) => n.index === ni);
      events.push({ index: ni, kind: sameTriggered ? "same" : "basic", dir: matched ? matched.dir.their : undefined });
    });
    // Résonance : la carte posée elle-même clignote aussi, sur le(s) côté(s) qui ont
    // fait matcher un rang égal — pas seulement les cartes capturées.
    if (sameTriggered) {
      // On eclaire TOUS les cotes qui ont resonne, y compris ceux tournes vers une carte
      // alliee : c'est ce qui rend l'enchainement lisible pour le joueur.
      exactTous.forEach((n) => events.push({ index: position, kind: "same-self", dir: n.dir.my }));
    }

    // ═══ L'ONDE. Une carte capturee ne se contente pas de recomparer ses rangs : elle
    // ACTIVE SA CAPACITE au service de son nouveau proprietaire. Une Chimere capturee
    // retourne donc le rang d'une voisine, et si cette voisine tombe, l'onde continue.
    // Avant, la capacite n'etait jamais appelee (prouve en Node : aucun evenement "mue"
    // sur une Chimere capturee) — la chaine n'etait qu'une comparaison de chiffres.
    // Les Geoliers gardent leur particularite : chez eux TOUTE capture propage, sans
    // exiger de Resonance.
    const estGeolier = placedCard.ability === "geolier" && captured.size > 0;
    if (sameTriggered || estGeolier) {
      const queue = (estGeolier && !sameTriggered)
        ? [...captured].map((i) => ({ index: i, comboLevel: 0 }))
        : sameMatches.map((n) => ({ index: n.index, comboLevel: 0 }));
      // Sans ce garde-fou, deux cartes qui se reprennent l'une l'autre boucleraient
      // indefiniment et figeraient le jeu.
      const dejaVues = new Set(queue.map((q) => q.index));
      while (queue.length) {
        const { index: curIdx, comboLevel } = queue.shift();
        const cr = Math.floor(curIdx / COLS), cc = curIdx % COLS;

        // 1. la capacite de la carte capturee, au service de son nouveau camp
        const prises = capaciteOffensive(newBoard, curIdx, player, events, comboLevel, eveilEcarts);
        prises.forEach((ni) => {
          if (dejaVues.has(ni)) return;
          dejaVues.add(ni);
          events.push({ index: curIdx, kind: "combo-emit", comboLevel });
          queue.push({ index: ni, comboLevel: comboLevel + 1 });
        });
        // Lue APRES la capacite : l'Eveil d'un Dores capture modifie ses propres rangs
        // (echange), le choc de rang ci-dessous doit se jouer avec ces rangs-la, comme a
        // la pose. Mue/percee/portee ne touchent pas la carte emettrice : rien ne change.
        const curCard = newBoard[curIdx];

        // 2. puis le choc de rang classique sur les quatre voisines
        DIRS.forEach((d) => {
          const nr = cr + d.dr, nc = cc + d.dc;
          if (!inBounds(nr, nc)) return;
          const ni = idx(nr, nc);
          const cell = newBoard[ni];
          if (cell && cell.owner !== player && atkRank(curCard, d.my) > defRank(cell, d.their)) {
            newBoard[ni] = { ...cell, owner: player };
            // dir: le sens du choc, vu depuis la carte VICTIME (d.their = son côté touché).
            events.push({ index: ni, kind: "combo", dir: d.their, comboLevel: comboLevel + 1 });
            // La carte émettrice (celle qui vient de capturer et transmet le choc) clignote aussi.
            events.push({ index: curIdx, kind: "combo-emit", dir: d.my, comboLevel });
            if (!dejaVues.has(ni)) { dejaVues.add(ni); queue.push({ index: ni, comboLevel: comboLevel + 1 }); }
          }
        });
      }
    }
  }

  // Dévoreuse : recalcule le bonus de TOUTES les Abysses de chaque camp à chaque
  // changement du plateau (pose ou capture) — 1 seule Abysse = pas de bonus,
  // chaque Abysse supplémentaire ajoute +1 sur les rangs de TOUTES vos Abysses.
  ["blue", "red"].forEach((side) => {
    const ownIndices = [];
    newBoard.forEach((cell, i) => {
      if (cell && cell.owner === side && cell.ability === "devoreuse") ownIndices.push(i);
    });
    const bonus = Math.max(0, ownIndices.length - 1);
    ownIndices.forEach((i) => {
      const cell = newBoard[i];
      const totalBonus = bonus + (cell.heroActive ? 2 : 0); // Héraut des Abysses : +2 même seule
      const prevBonus = cell.top - cell.baseTop;
      const nt = cell.baseTop + totalBonus, nrgt = cell.baseRight + totalBonus, nb = cell.baseBottom + totalBonus, nl = cell.baseLeft + totalBonus;
      if (nt !== cell.top || nrgt !== cell.right || nb !== cell.bottom || nl !== cell.left) {
        newBoard[i] = { ...cell, top: nt, right: nrgt, bottom: nb, left: nl };
        events.push({ index: i, kind: "devoreuse", delta: totalBonus - prevBonus });
      }
    });
  });

  // Maudits : à chaque fois qu'elle est capturée (peu importe
  // comment ni par qui), la carte elle-même gagne +1 sur ses 4 rangs, de
  // façon permanente — elle devient plus dangereuse à mesure qu'elle change
  // de main. Plafonné à 10 (= "A" à l'affichage) pour éviter qu'un rang
  // dépasse la valeur maximale jouable après plusieurs recaptures.
  const captureKinds = ["same", "basic", "combo", "percee", "portee", "attraction"];
  const mauditBoosted = new Set();
  events.slice().forEach((e) => {
    if (captureKinds.includes(e.kind) && !mauditBoosted.has(e.index) && newBoard[e.index] && newBoard[e.index].ability === "maudit") {
      mauditBoosted.add(e.index);
      const v = newBoard[e.index];
      // Héraut des Maudits : 1 chance sur 3 de gagner +2 au lieu de +1 (seul effet aléatoire
      // du jeu, réservé à ce héros optionnel — tout le reste d'EMPRISE reste déterministe).
      const gain = v.heroActive && Math.random() < 1 / 3 ? 2 : 1;
      newBoard[e.index] = {
        ...v,
        top: Math.min(10, v.top + gain),
        right: Math.min(10, v.right + gain),
        bottom: Math.min(10, v.bottom + gain),
        left: Math.min(10, v.left + gain),
      };
      events.push({ index: e.index, kind: "maudit-boost", delta: gain });
    }
  });

  // ÉVEIL (Dorés) — fin de l'échange : on annule les écarts appliqués plus haut.
  // Les rangs redeviennent ceux d'origine ; seules les captures restent acquises.
  eveilEcarts.forEach(({ index, side, ecart }) => {
    const carte = newBoard[index];
    if (carte) newBoard[index] = { ...carte, [side]: Math.max(0, carte[side] - ecart) };
  });
  // La marque « bouclier déjà payé » ne vaut que pour ce coup-ci : on l'efface, sinon un
  // Gardien échangé resterait sans défense pour tout le reste de la partie.
  newBoard.forEach((carte, i) => {
    if (carte && carte.eveilSansBouclier) {
      const { eveilSansBouclier, ...propre } = carte;
      newBoard[i] = propre;
    }
  });
  // Une Scribes qui vient de changer de camp n'a plus rien à cacher : ses rangs
  // apparaissent aussitôt, sans attendre la fin de sa fenêtre de dissimulation. On
  // compare au camp qui l'a POSÉE (scribePlacedBy) et non à son ancien propriétaire :
  // la carte a pu être déplacée par l'Attraction entre-temps. Vaut pour toutes les
  // formes de prise — capture directe, Onde, Résonance, combo.
  newBoard.forEach((carte, i) => {
    if (carte && carte.scribeJustPlaced && carte.owner !== carte.scribePlacedBy) {
      newBoard[i] = { ...carte, scribeJustPlaced: false, scribeConcealTurnsLeft: 0 };
      events.push({ index: i, kind: "scribe-reveal" });
    }
  });

  return { board: newBoard, events, poisonedCells: newPoison };
}

// ---------- Bot AI ----------
function simulateMove(board, card, position, player, poisonedCells) {
  let b = board.slice();
  b[position] = { ...card, owner: player };
  const { board: resolved, events, poisonedCells: nextPoison } = resolvePlacement(b, position, player, poisonedCells);
  const capturedCount = events.filter(
    (e) => ["basic", "same", "combo", "percee", "portee", "attraction"].includes(e.kind) && e.index !== position
  ).length;
  return { board: resolved, events, capturedCount, poisonedCells: nextPoison };
}

function getValidMoves(board, hand) {
  const moves = [];
  hand.forEach((card, cardIdx) => {
    board.forEach((cell, cellIdx) => { if (!cell) moves.push({ cardIdx, cellIdx }); });
  });
  return moves;
}

function estimateVulnerability(board, player) {
  let penalty = 0;
  board.forEach((cell, i) => {
    if (!cell || cell.owner !== player) return;
    const r = Math.floor(i / COLS), c = i % COLS;
    DIRS.forEach((d) => {
      const nr = r + d.dr, nc = c + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      if (board[ni] === null && cell[d.my] <= 3) penalty += 1;
    });
  });
  return penalty;
}

// Ne renvoie que les cases vides qui ont une chance réelle de mener à une capture
// (une carte quelque part sur leur ligne ou leur colonne — nécessaire pour toute
// capacité, y compris les capacités à distance comme Percée/Portée). Permet à
// l'IA de ne pas perdre de temps à simuler des cases totalement isolées.
function candidateCellsFor(board) {
  const occupiedRows = new Set();
  const occupiedCols = new Set();
  board.forEach((cell, i) => {
    if (cell) { occupiedRows.add(Math.floor(i / COLS)); occupiedCols.add(i % COLS); }
  });
  const result = [];
  board.forEach((cell, i) => {
    if (cell) return;
    const r = Math.floor(i / COLS), c = i % COLS;
    if (occupiedRows.has(r) || occupiedCols.has(c)) result.push(i);
  });
  return result;
}

// Empreinte d'une position : même plateau + même main = même empreinte. Sert à rendre
// le hasard du bot reproductible.
function empreintePosition(board, hand) {
  let h = 2166136261;
  const melange = (n) => { h ^= n | 0; h = Math.imul(h, 16777619); };
  board.forEach((c, i) => {
    melange(i + 1);
    if (c) {
      melange(c.top * 1093 + c.right * 131 + c.bottom * 17 + c.left);
      melange(c.owner === "blue" ? 11 : 23);
      for (let k = 0; k < (c.ability || "").length; k++) melange(c.ability.charCodeAt(k));
    }
  });
  hand.forEach((c) => {
    melange(c.top * 1093 + c.right * 131 + c.bottom * 17 + c.left);
    for (let k = 0; k < (c.ability || "").length; k++) melange(c.ability.charCodeAt(k));
  });
  return h >>> 0;
}

// Générateur pseudo-aléatoire déterministe (mulberry32) : à graine égale, suite égale.
function aleaDeterministe(graine) {
  let t = graine;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function botChooseMove(board, hand, opponentHand, player, opponent, difficulty, poisonedCells) {
  const moves = getValidMoves(board, hand);
  if (moves.length === 0) return null;

  // ⚠️ Le hasard du bot est volontairement REPRODUCTIBLE : il dépend de la position,
  // pas de Math.random(). Sans cela, le Repentir permettait d'annuler en boucle jusqu'à
  // ce que l'Écho joue mal — l'exploit fonctionnait aux trois premiers niveaux (le
  // Seigneur de Guerre était déjà déterministe). Ne pas remettre Math.random() ici.
  const alea = aleaDeterministe(empreintePosition(board, hand));

  if (difficulty === "debutant") {
    return moves[Math.floor(alea() * moves.length)];
  }

  const scored = moves.map((m) => {
    const card = hand[m.cardIdx];
    const sim = simulateMove(board, card, m.cellIdx, player, poisonedCells);
    return { ...m, capturedCount: sim.capturedCount, resultBoard: sim.board };
  });

  if (difficulty === "intermediaire") {
    const maxCap = Math.max(...scored.map((s) => s.capturedCount));
    const best = scored.filter((s) => s.capturedCount === maxCap);
    return best[Math.floor(alea() * best.length)];
  }

  if (difficulty === "avance") {
    const withRisk = scored.map((s) => ({ ...s, score: s.capturedCount * 2 - estimateVulnerability(s.resultBoard, player) }));
    const maxScore = Math.max(...withRisk.map((s) => s.score));
    const best = withRisk.filter((s) => s.score === maxScore);
    return best[Math.floor(alea() * best.length)];
  }

  // expert : anticipe la meilleure réponse adverse sur les meilleurs candidats
  const withRisk = scored.map((s) => ({ ...s, heuristic: s.capturedCount * 2 - estimateVulnerability(s.resultBoard, player) }));
  withRisk.sort((a, b) => b.heuristic - a.heuristic);
  const candidates = withRisk.slice(0, 14);

  let bestMove = null, bestNet = -Infinity;
  candidates.forEach((cand) => {
    let oppBest = 0;
    const usefulCells = candidateCellsFor(cand.resultBoard);
    opponentHand.forEach((oCard) => {
      usefulCells.forEach((cellIdx) => {
        const sim = simulateMove(cand.resultBoard, oCard, cellIdx, opponent, poisonedCells);
        if (sim.capturedCount > oppBest) oppBest = sim.capturedCount;
      });
    });
    const net = cand.capturedCount - oppBest;
    if (net > bestNet) { bestNet = net; bestMove = cand; }
  });
  return bestMove || candidates[0];
}

// ---------- Component ----------
// ---------- Timer bar ----------
// Vert au-dessus de 66% du temps restant, orange entre 33% et 66%, rouge en dessous
// (avec pulsation) — seuils faciles à ajuster si besoin.
function TimerBar({ timeLeft, max = TURN_SECONDS }) {
  const pct = Math.max(0, Math.min(1, timeLeft / max));
  const color = pct > 0.66 ? "green" : pct > 0.33 ? "orange" : "red";
  return (
    <div className="timer-bar-wrap">
      <div className={`timer-bar-fill ${color}`} style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

const APP_STYLES = `
        html, body { margin: 0; background: #0a0810; }
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Spectral:ital,wght@0,400;0,600;1,400&display=swap');

        /* Option d'accessibilité "animations réduites" : neutralise toutes les animations et
           transitions plutôt que de reprendre chacune des ~49 @keyframes une par une. */
        .reduced-motion, .reduced-motion * {
          animation-duration: 0.001s !important;
          animation-delay: 0s !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001s !important;
        }
        /* La regle ci-dessus fige les animations mais laisse les elements en place. Pour
           le brasier de la carte du mode Histoire, on veut en plus qu'il ne reste QUE la
           lueur chaude : les langues de feu et les braises figees en plein vol seraient
           des taches immobiles sans lecture possible. Meme traitement que le media query
           prefers-reduced-motion plus bas. */
        .reduced-motion .sm-flamme-bas,
        .reduced-motion .sm-braise-cote,
        .reduced-motion .sm-coulee-veine { display: none !important; }
        .reduced-motion .sm-brasier-lueur { opacity: 0.55 !important; }

        /* Reference de positionnement du bouton Retour : la racine, qui defile avec la
           page, et non le conteneur d'ecran. */
        .emprise-root { position: relative; }
        .emprise-root {
          --bg: #14111c; --panel: #1e1a29; --gold: #cba456; --gold-bright: #e8c877; --bone: #eee7d8; --muted: #948aa3;
          --blue: #3f6fb0; --blue-bright: #6fa4e6; --red: #a8443c; --red-bright: #e0655a; --combo: #8a63c9;
          --poison: #6ea35c; --mue: #4bc9c9; --portee: #6cc0ff; --percee: #d8d8d8; --devour: #a15fc4; --attract: #d98f3c;
          --malus: #e15b52; --bonus: #5fcf6e;
          min-height: 100vh; min-height: 100dvh; background: radial-gradient(ellipse at 50% -10%, #241e33 0%, var(--bg) 55%), var(--bg);
          color: var(--bone); font-family: 'Spectral', Georgia, serif; padding: 62px 14px 22px;
          display: flex; flex-direction: column; align-items: center; gap: 12px; box-sizing: border-box;
        }
        .landing {
          position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 14px; padding: 32px 24px;
          text-align: center;
          background:
            radial-gradient(ellipse at 50% 20%, rgba(60,50,80,0.35), transparent 60%),
            repeating-linear-gradient(115deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 5px),
            repeating-linear-gradient(25deg, rgba(0,0,0,0.25) 0px, rgba(0,0,0,0.25) 2px, transparent 2px, transparent 7px),
            linear-gradient(180deg, #100d16, #0a0810 70%);
        }
        .landing-hero {
          position: absolute; top: 0; left: 50%; transform: translateX(-50%);
          width: 100%; max-width: 480px; height: 52%; object-fit: cover; object-position: center 8%;
          -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.1) 55%, transparent 100%);
          mask-image: linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.1) 55%, transparent 100%);
          opacity: 1; filter: brightness(1.8) contrast(1.05) saturate(1.15); pointer-events: none; z-index: -1;
        }

        /* ---------- Séquence d'entrée de l'accueil ----------
           Trois étapes pilotées par les classes intro-e0 / e1 / e2 / e3 posées sur
           .landing (voir introEtape). On anime uniquement opacity et transform, les deux
           proprietes que le navigateur sait traiter sans repeindre : l'entree reste fluide
           meme sur un telephone modeste. L'etape 3 ne porte aucune regle : c'est l'etat
           normal de l'accueil, une fois l'intro finie. */
        /* Le voile est le noir d'ou tout sort. Il passe DERRIERE l'arene (z-index 40
           contre 41) : l'arene se detache ainsi sur le noir pendant qu'il s'efface, au
           lieu d'attendre qu'il ait fini. */
        .landing-voile {
          position: absolute; inset: 0; z-index: 40; pointer-events: none;
          background: #000000;
          transition: opacity 2.1s ease;
        }
        .landing.intro-e0 .landing-voile { opacity: 1; }
        .landing.intro-e1 .landing-voile { opacity: 0; }
        .landing.intro-e0 .hub-arene, .landing.intro-e1 .hub-arene { position: relative; z-index: 41; }

        /* L'ARENE ouvre la marche : elle sort du noir pendant que tout le reste attend.
           Aucune regle a l'etape 3 — l'accueil y est dans son etat normal, et l'arene y
           retrouve sa transition courte, celle qui la fait avancer sous le doigt. */
        .landing.intro-e0 .hub-arene { opacity: 0; transform: translateY(18px) scale(0.94); }
        .landing.intro-e1 .hub-arene,
        .landing.intro-e2 .hub-arene {
          opacity: 1; transform: none;
          transition: opacity 1.5s ease, transform 1.9s cubic-bezier(.22,.9,.3,1);
        }
        /* Le nom de l'arene suit son illustration, sans decalage : ils ne font qu'un. */
        .landing.intro-e0 .hub-arene-nom { opacity: 0; }
        .landing.intro-e1 .hub-arene-nom, .landing.intro-e2 .hub-arene-nom {
          opacity: 1; transition: opacity 1.5s ease .2s;
        }

        /* L'illustration de fond : elle montait des l'etape 1, elle attend maintenant
           l'etape 2 pour ne pas voler la vedette a l'arene. */
        .landing.intro-e0 .landing-hero,
        .landing.intro-e1 .landing-hero { opacity: 0; transform: translateX(-50%) scale(1.05); }
        .landing.intro-e2 .landing-hero,
        .landing.intro-e3 .landing-hero {
          opacity: 1; transform: translateX(-50%) scale(1);
          transition: opacity 1.7s ease, transform 2.2s cubic-bezier(.22,.9,.3,1);
        }

        /* Titre, sous-titre, badge et bouton : caches pendant les deux premieres etapes,
           puis remontent ensemble avec un leger decalage entre eux. */
        .landing.intro-e0 .landing-emblem, .landing.intro-e1 .landing-emblem,
        .landing.intro-e0 .landing-title, .landing.intro-e1 .landing-title,
        .landing.intro-e0 .landing-subtitle, .landing.intro-e1 .landing-subtitle,
        .landing.intro-e0 .league-badge, .landing.intro-e1 .league-badge,
        .landing.intro-e0 .hub-haut, .landing.intro-e1 .hub-haut,
        .landing.intro-e0 .hub-jouer-rang, .landing.intro-e1 .hub-jouer-rang,
        .landing.intro-e0 .hub-nav, .landing.intro-e1 .hub-nav,
        .landing.intro-e0 .hub-avis, .landing.intro-e1 .hub-avis,
        .landing.intro-e0 .landing-link, .landing.intro-e1 .landing-link {
          opacity: 0; transform: translateY(18px);
        }
        .landing.intro-e2 .landing-emblem, .landing.intro-e3 .landing-emblem,
        .landing.intro-e2 .landing-title, .landing.intro-e3 .landing-title,
        .landing.intro-e2 .landing-subtitle, .landing.intro-e3 .landing-subtitle,
        .landing.intro-e2 .league-badge, .landing.intro-e3 .league-badge,
        .landing.intro-e2 .hub-haut, .landing.intro-e3 .hub-haut,
        .landing.intro-e2 .hub-jouer-rang, .landing.intro-e3 .hub-jouer-rang,
        .landing.intro-e2 .hub-nav, .landing.intro-e3 .hub-nav,
        .landing.intro-e2 .hub-avis, .landing.intro-e3 .hub-avis,
        .landing.intro-e2 .landing-link, .landing.intro-e3 .landing-link {
          opacity: 1; transform: translateY(0);
          transition: opacity .85s ease, transform .85s cubic-bezier(.22,.9,.3,1);
        }
        /* Decalage : le titre d'abord, puis le sous-titre, le badge, le bouton, l'engrenage. */
        .landing.intro-e2 .landing-emblem { transition-delay: 0s; }
        .landing.intro-e2 .landing-title { transition-delay: .1s; }
        .landing.intro-e2 .landing-subtitle { transition-delay: .24s; }
        .landing.intro-e2 .league-badge { transition-delay: .36s; }
        .landing.intro-e2 .hub-haut { transition-delay: 0s; }
        .landing.intro-e2 .hub-jouer-rang { transition-delay: .34s; }
        .landing.intro-e2 .hub-nav { transition-delay: .5s; }
        /* Le titre garde son reflet dore, mais seulement une fois pose : sinon les deux
           animations (reflet + glissement) se disputent la meme propriete. */
        .landing.intro-e0 .landing-title, .landing.intro-e1 .landing-title,
        .landing.intro-e2 .landing-title { animation: none; }

        /* Engrenage des parametres, en haut a droite. */
        /* Volontairement discret : l'engrenage ne doit pas concurrencer "Nouvelle partie".
           Il reste dans un coin, a peine dessine, et ne se revele qu'au survol ou au
           toucher, sa zone cliquable, elle, garde ses 42 px pour rester facile a viser.
           La discretion passe par la COULEUR et la BORDURE, jamais par opacity : la
           sequence d'intro pilote deja opacity sur cet element (.landing.intro-e3 ...),
           regle plus specifique qui ecraserait toute valeur posee ici. */

        /* Modale Parametres : lignes cliquables, avec une bascule pour les reglages. */
        /* 380 px et pas plus : le voile qui entoure le panneau a 24 px de marge
           interieure de chaque cote. Au-dela, sur un ecran de 390 px, il toucherait les
           bords. C'est une limite mesuree, pas un choix esthetique. */
        .settings-panel { max-width: 420px; }
        .info-panel.settings-panel { max-width: 380px; }
        /* Mesure : ce n'est pas max-width qui bridait la largeur, c'est le voile qui
           entoure le panneau, avec ses 24 px de marge interieure de chaque cote. Sur un
           ecran de 390, il plafonnait donc a 342 px quoi qu'on ecrive. On desserre le
           voile pour les seuls Parametres, en gardant 14 px pour que le panneau ne
           touche jamais les bords. */
        .info-overlay:has(.settings-panel) { padding: 20px 14px; }
        .settings-row {
          display: flex; align-items: center; gap: 14px; width: 100%;
          padding: 13px 15px; margin-bottom: 10px; border-radius: 12px; cursor: pointer;
          background: var(--panel); border: 1px solid rgba(203,164,86,0.15);
          transition: border-color .2s, background .2s;
        }
        .settings-row:hover { border-color: rgba(203,164,86,0.5); background: rgba(203,164,86,0.06); }
        .settings-texte { flex: 1; text-align: left; }
        .settings-nom { font-family: 'Cinzel', serif; font-size: 14px; color: var(--gold-bright); }
        .settings-desc { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.35; }
        .settings-fleche { font-size: 22px; color: var(--muted); line-height: 1; }
        .settings-bascule {
          width: 44px; height: 25px; border-radius: 999px; flex-shrink: 0;
          background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
          position: relative; transition: background .2s, border-color .2s;
        }
        .settings-bascule span {
          position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%;
          background: var(--muted); transition: transform .2s ease, background .2s;
        }
        .settings-bascule.on { background: rgba(203,164,86,0.35); border-color: var(--gold); }
        .settings-bascule.on span { transform: translateX(19px); background: var(--gold-bright); }

        @media (prefers-reduced-motion: reduce) {
          .landing-voile { display: none; }
        }
        .landing-emblem { display: flex; align-items: center; gap: 14px; margin-bottom: 4px; }
        .landing-line-single { width: 110px; height: 1px; background: linear-gradient(90deg, transparent, var(--gold), transparent); }
        .landing-title {
          font-family: 'Cinzel', serif; font-weight: 700; font-size: 44px; letter-spacing: 0.14em; margin: 0;
          background: linear-gradient(115deg, #7d745f 30%, #cfc6b0 45%, #fff8e0 50%, #cfc6b0 55%, #7d745f 70%);
          background-size: 250% 100%;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          text-shadow: 0 2px 18px rgba(0,0,0,0.6);
          animation: title-shine 9s ease-in-out infinite;
        }
        @keyframes title-shine {
          0% { background-position: 200% 0; }
          50%, 100% { background-position: -60% 0; }
        }
        .landing-subtitle { font-family: 'Spectral', Georgia, serif; font-style: italic; font-size: 13px; color: var(--muted); margin: 0 0 26px; }
        .league-badge {
          font-family: 'Cinzel', serif; font-size: 12px; color: var(--gold-bright);
          border: 1px solid rgba(203,164,86,0.35); border-radius: 999px; padding: 5px 14px;
          margin: -14px 0 20px; background: rgba(203,164,86,0.08);
        }

        /* ==================== HUB D'ACCUEIL ====================
           Structure de hub mobile (bandeau haut, pages, navigation basse) posee
           PAR-DESSUS l'ecran d'accueil existant : le fond, le heros et la sequence
           d'entree (intro-eN) sont conserves tels quels. */
        .landing.hub {
          justify-content: flex-start; text-align: center;
          padding: 0; gap: 0;
        }
        .hub-haut {
          width: 100%; box-sizing: border-box;
          display: flex; align-items: center; justify-content: space-between;
          padding: calc(10px + env(safe-area-inset-top, 0px)) 14px 10px;
          background: linear-gradient(180deg, rgba(10,8,15,0.92), rgba(10,8,15,0.55) 75%, transparent);
          flex: none;
        }
        .hub-joueur { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .hub-pseudo {
          background: none; border: none; padding: 0; cursor: pointer; text-align: left;
          font: inherit;
          font-family: 'Cinzel', serif; font-size: 15px; font-weight: 700;
          letter-spacing: 0.12em; color: var(--bone);
          text-shadow: 0 1px 3px rgba(0,0,0,0.8);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .hub-trophees {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 9px 3px 6px; border-radius: 999px;
          background: rgba(8,6,12,0.75); border: 1px solid rgba(203,164,86,0.4);
        }
        .hub-icone-coupe { width: 14px; height: 14px; fill: var(--gold-bright); }
        .hub-trophees-nombre {
          font-family: 'Cinzel', serif; font-size: 12.5px; font-weight: 700; color: var(--gold-bright);
        }
        .hub-haut-boutons { display: flex; gap: 8px; flex: none; }
        .histo-vide { text-align: center; padding: 14px 6px 6px; color: var(--muted); font-size: 12.5px; }
        .histo-vide p { margin: 0 0 4px; }
        .histo-vide-sous { font-size: 11px; }
        .histo-ligne {
          width: 100%; box-sizing: border-box; text-align: left;
          padding: 9px 11px; border-radius: 10px; margin-bottom: 7px;
          background: rgba(8,6,12,0.55); border: 1px solid rgba(203,164,86,0.16);
        }
        .histo-resultat {
          font-family: 'Cinzel', serif; font-size: 12.5px; font-weight: 700;
          letter-spacing: 0.08em; color: var(--bone);
        }
        .histo-resultat.gagnee { color: var(--gold-bright); }
        .histo-resultat.perdue { color: var(--red-bright); }
        .histo-motif { font-family: 'Spectral', Georgia, serif; font-weight: 400; font-size: 11px; color: var(--muted); letter-spacing: 0; }
        .histo-detail {
          display: flex; align-items: baseline; gap: 10px; margin-top: 3px;
          font-size: 11px; color: var(--muted);
        }
        .histo-mode { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .histo-score b { font-family: 'Cinzel', serif; font-size: 12px; }
        .histo-sb { color: var(--blue-bright); }
        .histo-sr { color: var(--red-bright); }
        .histo-quand { flex: none; }
        .hub-rouage {
          width: 36px; height: 36px; flex: none;
          display: flex; align-items: center; justify-content: center;
          background: rgba(8,6,12,0.6); border: 1px solid rgba(203,164,86,0.25);
          border-radius: 10px; cursor: pointer; padding: 0;
          transition: border-color .2s, transform .35s ease;
        }
        .hub-rouage svg { width: 19px; height: 19px; fill: rgba(203,164,86,0.75); }
        /* La roue de pierre remplace le pictogramme. Le bouton tourne deja au survol :
           l'illustration suit le mouvement. */
        .hub-rouage-img { width: 26px; height: 26px; object-fit: contain; display: block; }
        .hub-rouage:hover { border-color: var(--gold); transform: rotate(30deg); }
        .hub-rouage:active { transform: rotate(30deg) scale(0.94); }
        .hub-pages {
          flex: 1; width: 100%; min-height: 0; overflow: hidden;
          display: flex; flex-direction: column; align-items: center;
        }
        /* Filet de securite sur les ecrans tres bas : mieux vaut un defilement
           que du contenu inatteignable. */
        @media (max-height: 600px) {
          .hub-pages { overflow-y: auto; -webkit-overflow-scrolling: touch; }
        }
        .hub-page {
          width: 100%; max-width: 540px; box-sizing: border-box; height: 100%;
          padding: 4px 18px 10px;
          display: flex; flex-direction: column; align-items: center; gap: 9px;
          animation: hub-page-entre 0.28s ease-out both;
        }
        /* Bloc de titre resserre : le hub doit tenir sans defilement vertical. */
        .landing.hub .landing-title { font-size: clamp(26px, 8vw, 34px); }
        .landing.hub .landing-emblem { margin: 0; }
        .landing.hub .landing-subtitle { margin: 0; }
        .landing.hub .league-badge { margin: 0 0 2px; }
        /* Glissement d'entree : transform et opacity uniquement, en une seule passe. */
        .hub-glisse-droite { --hub-depart: 26px; }
        .hub-glisse-gauche { --hub-depart: -26px; }
        @keyframes hub-page-entre {
          from { opacity: 0; transform: translateX(var(--hub-depart, 26px)); }
          to { opacity: 1; transform: translateX(0); }
        }
        .hub-page-titre {
          font-family: 'Cinzel', serif; font-size: 17px; letter-spacing: 0.14em;
          text-transform: uppercase; color: var(--gold-bright); margin: 6px 0 0;
        }
        .hub-page-sous { font-size: 11.5px; color: var(--muted); margin: 0 0 4px; }
        .hub-boutique-vide {
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          margin: auto 0; padding: 46px 20px;
        }
        .hub-boutique-icone { width: 44px; height: 44px; fill: rgba(203,164,86,0.45); }
        .hub-boutique-titre {
          font-family: 'Cinzel', serif; font-size: 18px; letter-spacing: 0.16em;
          text-transform: uppercase; color: var(--gold-bright); margin: 4px 0 0;
        }
        .hub-boutique-texte {
          font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 0.2em;
          text-transform: uppercase; color: var(--bone); margin: 0;
        }
        .hub-boutique-sous { font-size: 11.5px; color: var(--muted); margin: 2px 0 0; }
        .hub-jouer-classe {
          width: 100%; max-width: 240px; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; gap: 1px;
          margin-top: 4px; padding: 8px 14px 7px;
          background: linear-gradient(180deg, #e8c877, #b98d3e 82%);
          border: 1px solid #f2dfae; border-radius: 14px; cursor: pointer;
          box-shadow: 0 8px 22px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.35);
          transition: filter .2s, transform .15s;
        }
        .hub-jouer-classe:hover { filter: brightness(1.06); }
        /* Appui : le bouton s'enfonce, l'ombre exterieure rentre, une ombre interne
           apparait. La sensation d'entrer DANS le bouton. */
        .hub-jouer-classe:active {
          transform: scale(0.93);
          box-shadow: 0 3px 8px rgba(0,0,0,0.45), inset 0 3px 8px rgba(60,40,10,0.45);
          filter: brightness(0.96);
        }
        .hub-jouer-classe { transition: filter .15s, transform .12s ease-in, box-shadow .12s; }
        .hub-jouer-classe svg { width: 16px; height: 16px; fill: #241d10; }
        .hub-jouer-classe-titre {
          font-family: 'Cinzel', serif; font-size: 14px; font-weight: 800;
          letter-spacing: 0.2em; text-transform: uppercase; color: #241d10;
        }
        .hub-jouer-classe-sous {
          font-size: 10.5px; letter-spacing: 0.08em; color: rgba(36,29,16,0.75);
        }
        .hub-avis {
          max-width: 340px; margin: 8px 0 0; cursor: pointer;
        }
        /* Une victoire par abandon adverse emprunte le meme canal qu'un message d'echec :
           elle s'annonce en or pour qu'on ne la lise pas comme un probleme. */
        .hub-avis.avis-bon { color: var(--gold-bright); font-weight: 600; }
        /* L'arene : elle occupe la hauteur libre entre le titre et les boutons, et se
           reduit d'elle-meme sur les ecrans bas plutot que de pousser les boutons dehors. */
        .hub-arene {
          flex: 1 1 auto; min-height: 0; width: 100%;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 5px; margin-top: 2px;
          background: none; border: none; padding: 0; font: inherit; cursor: pointer;
          transition: transform .16s ease-out;
        }
        /* On entre dans l'arene : elle avance vers le doigt avant de s'ouvrir. */
        .hub-arene:active { transform: scale(1.05); }
        .hub-arene:active .hub-arene-img { filter: drop-shadow(0 16px 26px rgba(0,0,0,0.6)) brightness(1.15); }

        /* ---------- Galerie des arenes ---------- */
        .arenes-voile {
          padding: 0; align-items: stretch; justify-content: stretch;
          animation: arenes-ouvre 0.32s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes arenes-ouvre {
          from { opacity: 0; backdrop-filter: blur(0); }
          to { opacity: 1; }
        }
        .arenes-defile {
          width: 100%; height: 100dvh; overflow-y: auto; overflow-x: hidden;
          scroll-snap-type: y mandatory; -webkit-overflow-scrolling: touch;
          overscroll-behavior-y: contain;
          scrollbar-width: none;
        }
        .arenes-defile::-webkit-scrollbar { display: none; }
        .arene-page {
          height: 100dvh; scroll-snap-align: center; scroll-snap-stop: always;
          display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
          gap: 6px; padding: 52px 20px 30px; box-sizing: border-box; position: relative;
        }
        .arene-page-entete {
          flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px;
        }
        /* L'illustration prend toute la hauteur qui reste sous le nom. */
        .arene-page-corps {
          flex: 1; min-height: 0; width: 100%; position: relative;
          display: flex; align-items: center; justify-content: center;
        }
        /* Arene pas encore atteinte : on la voit, mais eteinte, et le cadenas tranche. */
        .arene-page-corps.verrouillee .arene-page-img,
        .arene-page-corps.verrouillee .arene-page-chantier {
          filter: grayscale(0.75) brightness(0.42) contrast(0.9);
        }
        /* Le cadenas enchaine, pose au centre de l'arene eteinte, dans un disque sombre :
           sur une arene claire (Argent, Platine) il se perdait dans le decor. */
        .arene-cadenas-rond {
          position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
          width: 82px; height: 82px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 42%, rgba(20,16,28,0.94) 62%, rgba(8,6,12,0.9) 100%);
          border: 1px solid rgba(203,164,86,0.35);
          box-shadow: 0 10px 24px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,240,205,0.08);
          animation: arene-cadenas-pose 0.5s cubic-bezier(.22,1,.36,1) both;
        }
        .arene-cadenas-rond img {
          width: auto; height: 54px; object-fit: contain; display: block;
          filter: drop-shadow(0 3px 6px rgba(0,0,0,0.7));
        }
        @keyframes arene-cadenas-pose {
          from { opacity: 0; transform: translate(-50%, -50%) scale(1.25); }
          to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        .arene-page-seuil.a-conquerir { color: var(--gold); font-weight: 700; }
        .arene-page-img {
          max-width: min(84vw, 380px); max-height: 100%; width: auto; height: auto;
          object-fit: contain; display: block;
          filter: drop-shadow(0 18px 30px rgba(0,0,0,0.65));
          animation: arene-page-monte 0.5s ease-out both;
        }
        @keyframes arene-page-monte {
          from { opacity: 0; transform: translateY(14px) scale(0.96); }
          to { opacity: 1; transform: none; }
        }
        .arene-page-chantier {
          width: min(70vw, 260px); aspect-ratio: 4 / 3; border-radius: 16px;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
          background: rgba(255,255,255,0.03); border: 1px dashed rgba(203,164,86,0.3);
        }
        .arene-page-chantier svg { width: 34px; height: 34px; fill: var(--gold); opacity: 0.7; }
        .arene-page-chantier span {
          font-family: 'Cinzel', serif; font-size: 11px; letter-spacing: 0.16em;
          text-transform: uppercase; color: var(--muted);
        }
        .arene-page-nom {
          font-family: 'Cinzel', serif; font-size: 19px; font-weight: 700;
          letter-spacing: 0.16em; text-transform: uppercase; color: var(--gold-bright);
          text-shadow: 0 2px 8px rgba(0,0,0,0.9);
        }
        .arene-page-seuil { font-size: 12px; color: var(--muted); }
        .arene-page-ici {
          margin-top: 6px; padding: 3px 12px; border-radius: 999px;
          font-family: 'Cinzel', serif; font-size: 10.5px; font-weight: 700;
          letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--gold-bright); background: rgba(203,164,86,0.16);
          border: 1px solid rgba(203,164,86,0.5);
        }
        .arene-page-fleche {
          position: absolute; left: 0; right: 0; top: 14px;
          display: flex; flex-direction: column; align-items: center; gap: 2px;
          font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted);
          animation: arene-fleche-respire 2.2s ease-in-out infinite;
        }
        .arene-page-fleche svg {
          width: 16px; height: 16px; fill: none; stroke: var(--gold);
          stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
        }
        @keyframes arene-fleche-respire {
          0%, 100% { opacity: 0.45; transform: translateY(3px); }
          50% { opacity: 1; transform: translateY(-3px); }
        }
        .arenes-fermer {
          position: fixed; top: 14px; right: 14px; z-index: 5;
          width: 38px; height: 38px; border-radius: 50%; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          background: rgba(8,6,12,0.75); border: 1px solid rgba(203,164,86,0.4);
        }
        .arenes-fermer svg {
          width: 17px; height: 17px; fill: none; stroke: var(--bone);
          stroke-width: 2; stroke-linecap: round;
        }
        @media (prefers-reduced-motion: reduce) {
          .arenes-voile, .arene-page-img, .arene-page-fleche { animation: none; }
        }
        .hub-arene-img {
          max-width: min(88vw, 380px); max-height: 100%; width: auto; height: auto;
          object-fit: contain; display: block;
          filter: drop-shadow(0 16px 26px rgba(0,0,0,0.6));
          animation: hub-arene-parait 0.7s ease-out both;
        }
        @keyframes hub-arene-parait {
          from { opacity: 0; transform: translateY(10px) scale(0.97); }
          to { opacity: 1; transform: none; }
        }
        .hub-arene-nom {
          font-family: 'Cinzel', serif; font-size: 12px; font-weight: 700;
          letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold);
          text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        }
        /* Rangee Classe + Modes : le Classe domine, le second bouton ouvre le panneau.
           margin-top: auto les colle au bas de la page, sous l'arene. */
        .hub-jouer-rang {
          display: flex; align-items: stretch; gap: 9px; flex: none;
          width: 100%; max-width: 340px; margin-top: auto; padding-top: 6px;
        }
        .hub-jouer-rang .hub-jouer-classe { margin-top: 0; flex: 1.6; max-width: none; }
        /* Les haches croisees remplacent le pictogramme : illustration detouree, posee
           sans cadre, elle porte le bouton a elle seule. */
        .hub-jouer-classe-img {
          width: 40px; height: 40px; object-fit: contain; display: block;
          filter: drop-shadow(0 3px 7px rgba(0,0,0,0.75));
        }
        .hub-jouer-modes-btn {
          flex: 1; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
          padding: 10px 10px 8px;
          background: linear-gradient(180deg, #2c2340, #171221 75%);
          border: 1px solid rgba(203,164,86,0.5); border-radius: 14px; cursor: pointer;
          box-shadow: 0 8px 22px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,240,205,0.12);
          transition: filter .15s, transform .12s ease-in, border-color .2s;
        }
        .hub-jouer-modes-btn:hover { border-color: var(--gold-bright); }
        .hub-jouer-modes-btn:active { transform: scale(0.94); }
        .hub-jouer-modes-btn svg { width: 16px; height: 16px; fill: var(--gold-bright); }
        .hub-jouer-modes-btn .hub-jouer-classe-titre { color: var(--gold-bright); }
        .hub-jouer-modes-btn .hub-jouer-classe-sous { color: var(--muted); }
        /* Panneau des modes : les tuiles du hub, rangees par famille. */
        .modes-groupe-titre {
          width: 100%; text-align: left;
          font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700;
          letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold);
          margin: 10px 0 6px; padding-bottom: 4px;
          border-bottom: 1px solid rgba(203,164,86,0.18);
        }
        .modes-groupe {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%;
        }
        .modes-panel .reset-btn { margin-top: 14px; }
        .hub-mode-tuile {
          display: flex; align-items: center; gap: 9px;
          padding: 8px 10px; min-height: 46px; box-sizing: border-box;
          background: var(--panel); border: 1px solid rgba(203,164,86,0.2);
          border-radius: 11px; cursor: pointer; color: var(--bone); text-align: left;
          transition: border-color .2s, transform .15s;
        }
        .hub-mode-tuile:hover { border-color: var(--gold); }
        .hub-mode-tuile:active { transform: scale(0.97); }
        .hub-mode-tuile img {
          width: 30px; height: 30px; border-radius: 8px; object-fit: cover; flex: none;
          border: 1px solid rgba(203,164,86,0.3);
        }
        .hub-mode-tuile span {
          font-family: 'Cinzel', serif; font-size: 10.5px; font-weight: 700;
          letter-spacing: 0.04em; line-height: 1.3;
        }
        .hub-mode-tuile.test { opacity: 0.72; }
        /* Page de maitrise : 4 Ordres par ligne, chacun avec sa vague et son
           pourcentage. Trois lignes tiennent sous le titre sans defiler. */
        .hub-ordres-grille4 {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px 8px;
          width: 100%; max-width: 420px; padding: 4px 2px 8px; box-sizing: border-box;
        }
        .hub-ordre-vignette {
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          min-width: 0;
        }
        /* Triple selecteur a dessein : la vignette de base du selecteur d'Ordres impose
           height 200px plus loin dans la feuille, il faut la battre en specificite.
           Carre et non 3/4 : trois lignes doivent tenir sous le titre sans defiler. */
        .hub-ordres-grille4 .hub-ordre-vignette .order-thumb-wrap,
        .hub-ordres-grille4 .hub-ordre-vignette .teaser-wrap {
          width: 100%; height: auto; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden;
          border: 1px solid rgba(203,164,86,0.28);
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .hub-ordres-grille4 .hub-ordre-vignette .thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
        /* Le cadre porte le nom : reference de position pour l'incrustation. */
        .hub-ordres-grille4 .hub-ordre-cadre { position: relative; width: 100%; }
        /* Nom pose EN HAUT de la carte, sur un voile qui descend : opaque derriere le
           texte, transparent plus bas pour laisser voir le portrait. */
        .hub-ordre-vignette-nom {
          position: absolute; top: 0; left: 0; right: 0; z-index: 5;
          padding: 4px 3px 9px; border-radius: 10px 10px 0 0; pointer-events: none;
          background: linear-gradient(180deg, rgba(8,6,12,0.92) 0%, rgba(8,6,12,0.62) 55%, rgba(8,6,12,0) 100%);
          font-family: 'Cinzel', serif; font-size: 8.5px; font-weight: 700;
          letter-spacing: 0.04em; text-transform: uppercase; color: var(--bone);
          text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .hub-ordre-vignette.scellee .hub-ordre-vignette-nom { color: var(--muted); }
        /* La vignette est un bouton : on neutralise le style natif et on lui donne une
           reponse au doigt — elle grossit, puis s'ouvre. */
        .hub-ordres-grille4 .hub-ordre-vignette {
          background: none; border: none; padding: 0; cursor: pointer; font: inherit;
          transition: transform .18s cubic-bezier(.22,.9,.3,1);
        }
        .hub-ordres-grille4 .hub-ordre-vignette:not(:disabled):active { transform: scale(1.08); z-index: 2; }
        .hub-ordres-grille4 .hub-ordre-vignette:disabled { cursor: default; }
        /* Le pourcentage, en haut a droite de la carte, sur le meme voile que le nom. */
        /* Le pourcentage vit en BAS de la carte, sur un voile qui monte : a cote du nom, il
           lui volait 30 px et coupait "Pestiférés" sur les ecrans de 390 px et moins. */
        /* Discret : petit, cale a gauche en bas de la carte, sur un voile qui monte. */
        .hub-ordre-pourcent {
          position: absolute; left: 0; right: 0; bottom: 0; z-index: 6; pointer-events: none;
          padding: 9px 4px 3px 5px; border-radius: 0 0 10px 10px;
          background: linear-gradient(0deg, rgba(8,6,12,0.88) 0%, rgba(8,6,12,0.5) 60%, rgba(8,6,12,0) 100%);
          font-family: 'Cinzel', serif; font-size: 8px; font-weight: 700; text-align: left;
          letter-spacing: 0.02em; color: var(--gold); text-shadow: 0 1px 3px rgba(0,0,0,0.95);
        }

        /* ---------- La vague de maitrise ---------- */
        .vague-maitrise {
          position: relative; width: 100%; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden;
          border: 1px solid rgba(203,164,86,0.28);
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          background: #0b0910;
        }
        .vague-maitrise img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
        /* Le portrait grise : ce qui reste a conquerir. Entierement gris si jamais joue. */
        .vague-gris { filter: grayscale(1) brightness(0.42) contrast(0.95); }
        /* La partie remplie : un cadre ancre en bas, qui grandit vers le haut. Le portrait en
           couleur y est cale sur le BAS, pour rester aligne avec le gris en dessous. */
        .vague-pleine {
          position: absolute; left: 0; right: 0; bottom: 0; overflow: hidden;
          /* Sous la crete, un socle plein : sans lui, une lame de 6 px n'avait que des
             bosses, la couche pleine du masque ne commencant qu'a 13 px. */
          transition: height 1.6s cubic-bezier(.22,.9,.3,1);
          /* La crete : une vague repetee sur 14 px en haut, plein en dessous. Le masque
             derive vers la gauche sans fin, c'est ce qui fait la maree. */
          -webkit-mask-image:
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 14' preserveAspectRatio='none'%3E%3Cpath d='M0 8 C 13 0, 27 0, 40 8 S 67 16, 80 8 V14 H0 Z' fill='%23000'/%3E%3C/svg%3E"),
            linear-gradient(#000, #000);
          mask-image:
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 14' preserveAspectRatio='none'%3E%3Cpath d='M0 8 C 13 0, 27 0, 40 8 S 67 16, 80 8 V14 H0 Z' fill='%23000'/%3E%3C/svg%3E"),
            linear-gradient(#000, #000);
          -webkit-mask-size: 80px 14px, 100% 100%;
          mask-size: 80px 14px, 100% 100%;
          -webkit-mask-position: 0 0, 0 13px;
          mask-position: 0 0, 0 13px;
          -webkit-mask-repeat: repeat-x, no-repeat;
          mask-repeat: repeat-x, no-repeat;
          animation: vague-derive 3.2s linear infinite;
        }
        @keyframes vague-derive {
          from { -webkit-mask-position: 0 0, 0 13px; mask-position: 0 0, 0 13px; }
          to { -webkit-mask-position: 80px 0, 0 13px; mask-position: 80px 0, 0 13px; }
        }
        /* Ordre acheve : la vague depasse le cadre (hauteur 130 %), le masque ne sert plus. */
        .vague-maitrise.pleine .vague-pleine {
          -webkit-mask-image: none; mask-image: none; animation: none;
        }
        /* Le portrait couleur est cale en BAS et mesure la hauteur de la carte entiere
           (pas celle de la zone remplie) : ainsi il se superpose exactement au gris, et la
           crete revele l'image au lieu de la decaler. */
        .vague-maitrise .vague-pleine .vague-couleur {
          top: auto; bottom: 0; height: var(--vague-cote); inset: auto 0 0 0;
        }
        /* Le voile de couleur : dense sur la crete, il s'eclaircit en descendant pour
           laisser respirer le portrait. C'est lui qui fait la vague "de la couleur de la
           carte". */
        .vague-teinte {
          position: absolute; inset: 0;
          background: linear-gradient(180deg, var(--vague-couleur) 0%, transparent 38%);
          mix-blend-mode: screen;
        }
        .vague-maitrise.vide .vague-pleine { display: none; }
        /* Version agrandie, dans le panneau de detail. */
        .vague-maitrise.grand {
          border-radius: 14px; border-color: rgba(203,164,86,0.5);
          box-shadow: 0 14px 34px rgba(0,0,0,0.6);
        }
        .vague-maitrise.grand .vague-pleine {
          -webkit-mask-size: 120px 20px, 100% 100%;
          mask-size: 120px 20px, 100% 100%;
          -webkit-mask-position: 0 0, 0 19px;
          mask-position: 0 0, 0 19px;
          animation-name: vague-derive-grand;
        }
        @keyframes vague-derive-grand {
          from { -webkit-mask-position: 0 0, 0 19px; mask-position: 0 0, 0 19px; }
          to { -webkit-mask-position: 120px 0, 0 19px; mask-position: 120px 0, 0 19px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .vague-pleine { animation: none; transition: none; }
        }

        /* ---------- Detail d'un Ordre ---------- */
        .ordre-detail {
          position: relative;
          display: flex; align-items: flex-start; gap: 14px;
          width: 100%; max-width: 400px; box-sizing: border-box;
          padding: 16px; border-radius: 18px;
          background: var(--panel); border: 1px solid var(--gold);
          box-shadow: 0 20px 50px rgba(0,0,0,0.6);
          animation: ordre-detail-zoom .34s cubic-bezier(.22,1,.36,1) both;
        }
        @keyframes ordre-detail-zoom {
          from { opacity: 0; transform: scale(0.72); }
          to { opacity: 1; transform: scale(1); }
        }
        /* La carte du detail : un portrait en HAUTEUR, plus grand qu'en grille, et en
           fondu — pas de cadre, ses bords s'effacent dans le panneau. */
        .ordre-detail-carte { flex: 0 0 46%; max-width: 190px; }
        .ordre-detail-carte .vague-maitrise.grand {
          aspect-ratio: 3 / 4; border: none; border-radius: 0; box-shadow: none; background: none;
          -webkit-mask-image: radial-gradient(82% 78% at 50% 48%, #000 46%, rgba(0,0,0,0.6) 72%, transparent 100%);
          mask-image: radial-gradient(82% 78% at 50% 48%, #000 46%, rgba(0,0,0,0.6) 72%, transparent 100%);
          animation: ordre-detail-fondu 0.9s ease-out both;
        }
        @keyframes ordre-detail-fondu {
          from { opacity: 0; transform: scale(1.05); }
          to { opacity: 1; transform: none; }
        }
        .ordre-detail-carte .vague-maitrise.grand img { object-position: center 20%; }
        @media (prefers-reduced-motion: reduce) { .ordre-detail-carte .vague-maitrise.grand { animation: none; } }
        .ordre-detail-texte { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .ordre-detail-pourcent {
          font-family: 'Cinzel', serif; font-size: 22px; font-weight: 700; line-height: 1;
          color: var(--gold-bright); text-shadow: 0 2px 8px rgba(0,0,0,0.8);
        }
        .ordre-detail-nom {
          font-family: 'Cinzel', serif; font-size: 14px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase; color: var(--bone);
        }
        .ordre-detail-rang {
          display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
          margin-top: 3px; padding: 2px 9px 2px 4px; border-radius: 999px;
          font-family: 'Cinzel', serif; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
          color: var(--gold-bright); background: rgba(203,164,86,0.14); border: 1px solid rgba(203,164,86,0.45);
        }
        .ordre-detail-rang-num {
          padding: 1px 6px; border-radius: 999px; font-size: 9.5px;
          background: rgba(203,164,86,0.25);
        }
        .ordre-detail-parties { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
        .ordre-detail-desc {
          margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: var(--bone);
          padding-top: 8px; border-top: 1px solid rgba(203,164,86,0.18);
        }
        .ordre-detail-fermer { position: absolute; top: -14px; right: -14px; width: 34px; height: 34px; }
        @media (prefers-reduced-motion: reduce) { .ordre-detail { animation: none; } }
        /* ---------- Barre de navigation : socle de pierre et metal ----------
           Le rendu vise une barre d'interface de jeu, pas une barre d'onglets de site :
           un socle sombre borde d'un liseré clair en haut (l'arete captant la lumiere),
           des icones en metal dore avec ombre portee, et une hierarchie franche entre
           l'onglet actif, encadre et lumineux, et les autres, assombris. */
        .hub-nav {
          position: relative;
          width: 100%; box-sizing: border-box; flex: none;
          display: flex; align-items: flex-end; justify-content: space-around;
          padding: 8px 8px calc(9px + env(safe-area-inset-bottom, 0px));
          background:
            linear-gradient(180deg, rgba(46,37,62,0.55) 0%, rgba(18,14,26,0.97) 42%, rgba(9,7,14,1) 100%);
          border-top: 1px solid rgba(203,164,86,0.32);
          box-shadow: 0 -6px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,240,205,0.09);
        }
        /* Le <defs> du degrade ne doit rien occuper dans la mise en page. */
        .hub-nav-defs { position: absolute; width: 0; height: 0; pointer-events: none; }
        .hub-onglet {
          flex: 1; max-width: 150px; position: relative;
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          padding: 8px 6px; cursor: pointer;
          background: #000000;
          border: 1px solid rgba(203,164,86,0.16); border-radius: 13px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.045);
          color: var(--muted);
          transition: color .22s, transform .18s, background .22s, border-color .22s;
        }
        .hub-onglet svg { width: 23px; height: 23px; }
        /* Icones fournies en image : memes traitements de relief et de hierarchie que
           les traces SVG de secours. */
        /* cover et non contain : les illustrations fournies sont paysage avec de
           larges marges sombres, le recadrage central isole l'icone elle-meme. */
        /* Les trois icones sont detourees (fond transparent) : elles se posent sur la
           barre sans artifice. object-fit: contain, jamais cover — le bouclier est plus
           haut que large, on ne le rogne pas. */
        .hub-onglet-img {
          width: 34px; height: 34px; object-fit: contain; border: none;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
          transition: filter .22s, opacity .22s, transform .22s;
        }
        /* Pas de pastille ronde derriere l'icone : c'est le BOUTON entier qui porte le
           fond sombre, d'un bord a l'autre de sa surface. */
        .hub-onglet:not(.actif) .hub-onglet-img {
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8)) saturate(0.5) brightness(0.62);
          opacity: 0.85;
        }
        .hub-onglet.actif {
          border-color: rgba(203,164,86,0.55);
          box-shadow: inset 0 1px 0 rgba(255,240,205,0.12), 0 0 14px rgba(203,164,86,0.16);
        }
        .hub-onglet.actif .hub-onglet-img {
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8)) drop-shadow(0 0 8px rgba(232,200,119,0.55)) brightness(1.08);
          transform: scale(1.06);
        }
        .hub-onglet-central .hub-onglet-img { width: 44px; height: 44px; }
        /* Le metal : degrade sur le trace lui-meme, ombre portee pour detacher l'icone
           du socle. Le filtre porte sur le SVG, donc l'ombre epouse la silhouette. */
        .hub-onglet svg path {
          fill: url(#or-metal); stroke: url(#or-metal);
          stroke-width: 0.9; stroke-linejoin: round; paint-order: stroke fill;
        }
        .hub-onglet svg {
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
          transition: filter .22s, opacity .22s;
        }
        /* Onglets au repos : memes icones, mais eteintes et en retrait. */
        .hub-onglet:not(.actif) svg {
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8)) saturate(0.35) brightness(0.62);
          opacity: 0.8;
        }
        .hub-onglet span {
          font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700;
          letter-spacing: 0.11em; text-transform: uppercase;
          text-shadow: 0 1px 2px rgba(0,0,0,0.9);
        }
        /* Onglet actif : cadre dore net, fond legerement eclaire, icone qui rayonne. */
        .hub-onglet.actif {
          color: var(--gold-bright);
          background: #000000;
          border-color: rgba(232,200,119,0.65);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 3px 10px rgba(0,0,0,0.4),
                      0 0 14px rgba(203,164,86,0.16);
        }
        .hub-onglet.actif svg {
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8)) drop-shadow(0 0 7px rgba(232,200,119,0.6));
        }
        /* Onglet central : plus grand et sureleve, comme l'onglet de bataille de Clash
           Royale, mais dans la sobriete du jeu. Socle en relief, arete claire en haut. */
        .hub-onglet-central {
          transform: translateY(-10px);
          background: #000000;
          border: 1px solid rgba(203,164,86,0.5);
          box-shadow:
            0 8px 18px rgba(0,0,0,0.55),
            inset 0 1px 0 rgba(255,240,205,0.14),
            inset 0 -2px 6px rgba(0,0,0,0.5);
          padding: 12px 12px 10px;
        }
        .hub-onglet-central svg { width: 28px; height: 28px; }
        .hub-onglet-central span { font-size: 11px; }
        .hub-onglet-central.actif {
          border-color: var(--gold-bright);
          background: #000000;
          box-shadow:
            0 8px 20px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(255,240,205,0.24),
            0 0 16px rgba(232,200,119,0.28);
        }
        /* Lueur qui respire autour de l'onglet central actif. Un calque a ombre FIXE
           dont seule l'opacite varie : jamais de box-shadow anime en boucle. */
        .hub-onglet-central.actif::after {
          content: ""; position: absolute; inset: -2px; border-radius: inherit;
          pointer-events: none; opacity: 0; will-change: opacity;
          box-shadow: 0 0 22px rgba(232,200,119,0.55);
          animation: halo-respire 3.2s ease-in-out infinite;
        }
        .hub-onglet-central:active { transform: translateY(-8px) scale(0.97); }
        @media (prefers-reduced-motion: reduce) {
          .hub-onglet-central.actif::after { animation: none; opacity: 0.5; }
        }
        /* La sequence d'entree du hub est decrite plus haut, avec celle de l'accueil :
           l'arene sort du noir la premiere, le reste la rejoint a l'etape 2. Cacher ici
           toute la page (.hub-pages) empechait justement l'arene de paraitre avant. */

        .landing-link {
          margin-top: 14px; background: none; border: none; cursor: pointer;
          font-family: 'Spectral', Georgia, serif; font-size: 12.5px; color: var(--muted);
          text-decoration: underline; text-underline-offset: 3px;
        }
        .landing-link:hover { color: var(--gold-bright); }

        /* RETOUR : repere fixe en haut a gauche, au-dessus du titre, en miroir de
           l'engrenage de l'accueil qui occupe le coin droit a la meme hauteur.
           Il est sorti du flux exprès : le bouton est ecrit douze fois dans le JSX, un
           par ecran, et sa place variait selon ce qui le precedait. Une seule regle ici
           les aligne tous, et tout ecran ajoute plus tard heritera du bon placement. */
        .back-btn {
          /* absolute, ancre sur .emprise-root : le bouton doit DEFILER avec la page.
             En fixed il restait colle a l'ecran pendant qu'on faisait defiler la liste des
             Ordres, ce qui donnait l'impression qu'il etait bloque.
             .order-picker portait position: relative et captait l'ancrage (le bouton
             retombait a y=132, sous le titre) : il passe en static juste en dessous, ce
             qui fait de .emprise-root la reference. */
          position: absolute; top: 18px; left: 14px; z-index: 40;
          margin-bottom: 0; background: rgba(203,164,86,0.06); cursor: pointer;
          border: 1px solid rgba(203,164,86,0.55); border-radius: 8px; padding: 8px 16px;
          font-family: 'Spectral', Georgia, serif; font-size: 14px; color: var(--gold);
          transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
        }
        .back-btn:hover { color: var(--gold-bright); border-color: var(--gold-bright); background: rgba(203,164,86,0.14); }


        .tut-text { text-align: center; max-width: 380px; margin: 0 0 4px; }
        .tut-board-wrap {
          display: flex; flex-direction: column; align-items: center; gap: 14px;
        }
        .tut-board-wrap .table { gap: 4px; padding: 6px; }
        .tut-board-wrap .cell,
        .tut-board-wrap .card:not(.hand) { width: 66px !important; height: 88px !important; }
        .tut-board-wrap .card.hand { width: 60px !important; height: 80px !important; }
        .tut-board-wrap .rank { width: 19px !important; height: 19px !important; font-size: 11px !important; }
        .tut-board-wrap .icon { font-size: 22px !important; }
        .cell.tut-highlight { cursor: pointer; border: 2px solid var(--gold-bright); animation: tut-pulse 1.2s ease-in-out infinite; }
        @keyframes tut-pulse {
          0%, 100% { box-shadow: 0 0 0 2px rgba(232,200,119,0.2), 0 0 10px rgba(232,200,119,0.25); }
          50% { box-shadow: 0 0 0 5px rgba(232,200,119,0.45), 0 0 22px rgba(232,200,119,0.55); }
        }



        .rules-panel { max-height: 78vh; overflow-y: auto; }
        .rules-section { text-align: left; margin-bottom: 12px; }
        .rules-h { font-family: 'Cinzel', serif; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gold-bright); margin-bottom: 3px; }
        .rules-p { font-size: 11.5px; color: var(--bone); line-height: 1.5; }

        .eyebrow { font-family: 'Cinzel', serif; letter-spacing: 0.32em; font-size: 10.5px; color: var(--gold); text-transform: uppercase; }
        .title { font-family: 'Cinzel', serif; font-weight: 700; font-size: 34px; letter-spacing: 0.08em; margin: 2px 0 0;
          background: linear-gradient(115deg, #b9ae95 30%, var(--bone) 45%, #fff8e0 50%, var(--bone) 55%, #b9ae95 70%);
          background-size: 250% 100%;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          animation: title-shine 9s ease-in-out infinite; }


        /* ---------- Bras de fer : les deux camps poussent vers le centre ----------
           Remplace les deux pastilles .inline-score, qui etaient aux extremites de
           l'ecran et obligeaient a balayer toute la page pour comparer.
           Lecture : chaque camp avance depuis son bord, l'espace sombre au milieu est
           ce qui reste a conquerir, et le repere dore central marque la majorite. Le
           camp qui depasse le centre a gagne, la regle se lit sans un mot.
           Le glissement est retarde de 1,1 s pour tomber au moment ou la carte pivote,
           pas avant : sinon le score bougeait alors que la carte n'avait pas bascule.
           .emprise-root est un flex en colonne centre : sans width 100 % la barre se
           reduit a son contenu et la piste tombe a 2 px de large. Mesure faite, pas devinee.
           Aucune apostrophe inversee ici : APP_STYLES est une chaine template. */
        .bras-de-fer { display: flex; align-items: center; gap: 9px; margin: 3px 0 8px;
          width: 100%; box-sizing: border-box; padding: 0 2px; }
        /* Les chiffres doivent tenir sur N'IMPORTE quel fond : une arene claire comme
           Argent les effacait. L'ombre portee sombre les detache sans les alourdir. */
        .bdf-num { font-family: 'Cinzel', serif; font-size: 16px; font-weight: 700;
          min-width: 20px; text-align: center; transition: text-shadow 0.5s ease;
          text-shadow: 0 1px 3px rgba(8,6,12,0.95), 0 0 8px rgba(8,6,12,0.8); }
        .bdf-num.blue { color: var(--blue-bright); }
        .bdf-num.red { color: var(--red-bright); }
        .bdf-num.acquis { text-shadow: 0 1px 3px rgba(8,6,12,0.95), 0 0 10px currentColor, 0 0 20px currentColor; }
        /* Fond franchement opaque et halo sombre autour : sur une arene, la piste se
           detachait a peine du decor. Elle doit rester lisible sans dependre du fond. */
        .bdf-piste { position: relative; flex: 1; min-width: 0; height: 10px; border-radius: 999px;
          background: linear-gradient(180deg, #2b2439, #16121f);
          border: 1px solid rgba(203,164,86,0.45);
          box-shadow: inset 0 1px 3px rgba(0,0,0,0.7), 0 0 0 3px rgba(10,8,15,0.55);
          overflow: hidden; }
        .bdf-cote { position: absolute; top: 0; bottom: 0;
          transition: width 0.7s cubic-bezier(0.22, 1, 0.36, 1) 1.1s; }
        .bdf-azur { left: 0; border-radius: 999px 0 0 999px;
          background: linear-gradient(90deg, #2c4d7c, var(--blue-bright));
          box-shadow: 0 0 8px rgba(111,164,230,0.55); }
        .bdf-ecarlate { right: 0; border-radius: 0 999px 999px 0;
          background: linear-gradient(270deg, #7c332c, var(--red-bright));
          box-shadow: 0 0 8px rgba(224,101,90,0.55); }
        /* Le repere central. Il passe en or vif des qu'un camp le franchit. */
        .bdf-seuil { position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px; z-index: 2;
          background: rgba(203,164,86,0.5); transition: background 0.5s ease, box-shadow 0.5s ease; }
        .bras-de-fer.franchi .bdf-seuil {
          background: var(--gold-bright); box-shadow: 0 0 6px var(--gold-bright), 0 0 12px rgba(232,200,119,0.6); }
        @media (max-width: 380px) {
          .bras-de-fer { gap: 7px; }
          .bdf-num { font-size: 14px; min-width: 17px; }
        }

        /* ---------- Dernier coup : la carte posee porte l'or, un tour ----------
           La bordure passe a l'or (regle a 4 classes : elle gagne sur la couleur de
           camp), et un anneau dore respire sur ::after, jamais sur la propriete
           animation de la carte elle-meme, deja occupee par l'atterrissage et le halo
           de camp. Le marqueur saute de lui-meme a la carte du coup suivant. */
        .card.dernier-coup.dernier-coup:not(.hand) { border-color: var(--gold-bright); }
        /* Celui-ci animait deja l'opacite, mais la partait de 0,8 : le navigateur devait
           donc composer un calque opaque en permanence. Meme animation, meme rendu, mais
           promue explicitement pour ne plus etre reevaluee a chaque image. */
        .card.dernier-coup:not(.hand)::after {
          content: ""; position: absolute; inset: -2px; border-radius: 10px; pointer-events: none;
          box-shadow: 0 0 0 1.5px rgba(232,200,119,0.95), 0 0 10px rgba(232,200,119,0.55), 0 0 22px rgba(203,164,86,0.3);
          will-change: opacity;
          animation: or-dernier 2.6s ease-in-out infinite;
        }
        @keyframes or-dernier { 0%, 100% { opacity: 0.8; } 50% { opacity: 1; } }

        /* ---------- Ceremonie de Victoire ----------
           5 temps : le voile tombe, une lame de lumiere traverse, le titre se forge
           lettre a lettre (blanc brulant vers or froid), l'onde et le trait scellent,
           le recap monte. Un toucher pose tout a l'etat final via .cer-pose (meme
           mecanique que le mode animations reduites : toutes les animations utilisent
           both, l'etat final est donc toujours atteint). z-index 300 : au-dessus du
           fan-backdrop (66) et des vignettes. Aucun accent grave dans ce bloc. */
        .cer-fin { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .cer-pose, .cer-pose * { animation-duration: 0.001s !important; animation-delay: 0s !important; }
        .cer-voile { position: absolute; inset: 0; opacity: 0;
          background: radial-gradient(ellipse at 50% 40%, rgba(20,17,28,0.84), rgba(9,7,15,0.97) 76%);
          animation: cer-apparait 0.4s ease-out both; }
        @keyframes cer-apparait { to { opacity: 1; } }
        .cer-scene { position: relative; display: flex; flex-direction: column; align-items: center;
          width: 100%; max-width: 420px; padding: 0 18px; }
        .cer-titre { display: flex; font-family: 'Cinzel', serif; font-weight: 700;
          font-size: clamp(38px, 13vw, 56px); letter-spacing: 0.1em; color: var(--gold-bright); }
        .cer-titre span { display: inline-block; opacity: 0;
          animation: cer-lettre 0.62s cubic-bezier(0.2, 1.1, 0.3, 1) both;
          animation-delay: calc(0.25s + var(--li) * 0.08s);
          text-shadow: 0 0 16px rgba(232,200,119,0.5), 0 2px 4px rgba(0,0,0,0.6); }
        @keyframes cer-lettre {
          0% { opacity: 0; transform: translateY(30px) scale(1.8); filter: blur(9px);
               color: #fff8e0; text-shadow: 0 0 30px #fff8e0, 0 0 55px var(--gold-bright); }
          55% { opacity: 1; filter: blur(0); }
          100% { opacity: 1; transform: translateY(0) scale(1); color: var(--gold-bright); } }
        .cer-onde { position: absolute; top: 16%; left: 50%; width: 240px; height: 240px;
          margin: -120px 0 0 -120px; border-radius: 50%; opacity: 0;
          border: 1.5px solid rgba(232,200,119,0.8);
          animation: cer-onde-passe 0.9s ease-out 1.05s both; }
        @keyframes cer-onde-passe { 0% { transform: scale(0.25); opacity: 0.9; } 100% { transform: scale(1.7); opacity: 0; } }
        .cer-trait { height: 1.5px; width: min(230px, 62vw); margin-top: 12px; transform: scaleX(0);
          background: linear-gradient(90deg, transparent, var(--gold-bright), transparent);
          box-shadow: 0 0 8px rgba(232,200,119,0.7);
          animation: cer-forge 0.5s ease-out 1.15s both; }
        @keyframes cer-forge { to { transform: scaleX(1); } }
        .cer-sous-titre { margin-top: 13px; font-family: 'Cinzel', serif; font-size: 12.5px;
          letter-spacing: 0.22em; text-transform: uppercase; color: var(--bone); opacity: 0;
          animation: cer-apparait 0.6s ease-out 1.4s both; }
        .cer-recap { margin-top: 26px; width: 100%; max-width: 300px; padding: 18px 18px 16px;
          border-radius: 14px; background: var(--panel); border: 1px solid rgba(203,164,86,0.3);
          box-shadow: 0 18px 40px rgba(0,0,0,0.5), inset 0 0 24px rgba(203,164,86,0.05);
          opacity: 0; transform: translateY(26px);
          animation: cer-monte 0.65s cubic-bezier(0.2, 1, 0.3, 1) 1.75s both;
          display: flex; flex-direction: column; align-items: center; gap: 12px; }
        @keyframes cer-monte { to { opacity: 1; transform: translateY(0); } }
        .cer-score { font-family: 'Cinzel', serif; font-size: 30px; font-weight: 700;
          display: flex; gap: 12px; align-items: baseline; }
        .cer-sb { color: var(--blue-bright); } .cer-sr { color: var(--red-bright); }
        .cer-sep { color: var(--muted); font-size: 18px; }
        .cer-piste { width: 100%; }
        .cer-recap .bdf-cote { transition: none; }
        .cer-continuer { width: 100%; }
        .cer-braises { position: absolute; inset: 0; pointer-events: none; }
        .cer-braises span { position: absolute; bottom: -8px; border-radius: 50%; opacity: 0;
          background: radial-gradient(circle, #ffe9b0, var(--gold) 65%, transparent 75%);
          box-shadow: 0 0 6px rgba(232,200,119,0.8);
          animation-name: cer-braise; animation-timing-function: linear; animation-iteration-count: infinite; }
        @keyframes cer-braise {
          0% { transform: translate(0, 0); opacity: 0; }
          8% { opacity: 0.9; } 80% { opacity: 0.5; }
          100% { transform: translate(var(--derive, 0px), -105vh); opacity: 0; } }

        /* ==========================================================================
           DEFAITE, storyboard et identite visuelle de Gemini, cablage et finitions ici.
           4 temps : onde de choc sombre, fracture du plateau, blason qui tombe, ruine.
           Notes d'integration (voir aussi le commentaire du patch) :
           - backdrop-filter reste STATIQUE, seule l'opacite est animee. L'animer coutait
             18,6 ms d'ecart median contre 16,9, et deux fois plus d'images sautees, pour
             un effet invisible derriere un fond opaque a 85 %.
           - Cinzel n'est charge qu'en 500 et 700 : pas de 900, le navigateur l'aurait
             faussement graisse.
           - Aucun accent grave dans ce bloc : APP_STYLES est une chaine template.
           ========================================================================== */
        .defeat-overlay {
          position: fixed; inset: 0; z-index: 300;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          background: rgba(5, 3, 8, 0.85);
          backdrop-filter: grayscale(0.9) brightness(0.35);
          -webkit-backdrop-filter: grayscale(0.9) brightness(0.35);
          opacity: 0; overflow: hidden;
          animation: defeatFadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes defeatFadeIn { to { opacity: 1; } }

        /* Phase 2, la fracture du plateau. La classe existait mais rien ne la posait :
           elle est desormais appliquee sur .table quand la Defaite se declenche.
           Le filter: opacity(0.5) de la version d'origine a ete retire : avec forwards,
           il laissait le plateau a moitie transparent bien apres la fin. */
        .board-defeat-shake {
          animation: boardCollapse 0.8s cubic-bezier(0.36, 0.07, 0.19, 0.97) 0.4s both !important;
        }
        @keyframes boardCollapse {
          0% { transform: translate3d(0, 0, 0); }
          10%, 90% { transform: translate3d(-3px, 2px, 0) rotate(-0.5deg); }
          20%, 80% { transform: translate3d(4px, -2px, 0) rotate(0.5deg); }
          30%, 50%, 70% { transform: translate3d(-6px, 4px, 0) scale(0.99); }
          40%, 60% { transform: translate3d(6px, -4px, 0) scale(0.98); }
          100% { transform: translate3d(0, 10px, 0) scale(0.96); }
        }

        /* Phase 3, le blason tombe du haut avec un impact lourd. */
        .defeat-title-container {
          display: flex; flex-direction: column; align-items: center;
          opacity: 0; transform: translate3d(0, -50px, 0) scale(0.8);
          animation: defeatTitleImpact 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) 0.6s forwards;
        }
        @keyframes defeatTitleImpact {
          0% { opacity: 0; transform: translate3d(0, -80px, 0) scale(1.3); filter: blur(10px); }
          70% { opacity: 1; transform: translate3d(0, 5px, 0) scale(0.98); filter: blur(0); }
          100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); filter: blur(0); }
        }
        .defeat-title {
          font-family: 'Cinzel', 'Georgia', serif; font-weight: 600;
          font-size: clamp(1.9rem, 6.6vw, 3rem); letter-spacing: 0.3em; text-indent: 0.3em;
          color: #8b0000; text-transform: uppercase; margin: 0;
          text-shadow: 0 0 20px rgba(139, 0, 0, 0.8), 0 4px 10px rgba(0, 0, 0, 0.9), 0 0 2px #ff3333;
        }
        .defeat-divider {
          width: min(180px, 55vw); height: 2px; margin: 15px 0; opacity: 0; transform: scaleX(0);
          background: linear-gradient(90deg, transparent, #8b0000, #ff3333, #8b0000, transparent);
          box-shadow: 0 0 12px #8b0000;
          animation: dividerExpand 1s ease-out 0.9s forwards;
        }
        @keyframes dividerExpand { to { opacity: 1; transform: scaleX(1); } }
        .defeat-subtitle {
          font-family: 'Cinzel', 'Georgia', serif; font-size: 0.85rem; letter-spacing: 0.2em;
          color: var(--muted); margin: 8px 0 0; text-transform: uppercase; opacity: 0.85; text-align: center;
        }

        /* Phase 4, la fumee de ruine. Decrite dans le storyboard, sans CSS fourni :
           ecrite ici. Le voile monte du bas, les braises ETEINTES retombent (derive
           inversee et translation positive, l'exact contraire des braises de Victoire). */
        .defeat-ruine { position: absolute; inset: 0; pointer-events: none; }
        .defeat-ruine::before {
          content: ""; position: absolute; left: -10%; right: -10%; bottom: -40%; height: 90%;
          background: radial-gradient(ellipse at 50% 100%, rgba(90, 30, 26, 0.5), rgba(20, 10, 12, 0.75) 45%, transparent 72%);
          opacity: 0; filter: blur(22px);
          animation: ruineMonte 1.4s ease-out 1.5s forwards;
        }
        @keyframes ruineMonte { to { opacity: 1; } }
        .defeat-ruine span {
          position: absolute; top: -10px; border-radius: 50%; opacity: 0;
          background: radial-gradient(circle, #6b5a52, #34272a 70%, transparent 78%);
          animation-name: cendreTombe; animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        @keyframes cendreTombe {
          0% { transform: translate(0, 0); opacity: 0; }
          10% { opacity: 0.75; } 85% { opacity: 0.35; }
          100% { transform: translate(calc(var(--derive, 0px) * -1), 105vh); opacity: 0; }
        }

        /* Recap : meme ossature que la Victoire, habillee en ruine. */
        .defeat-recap {
          margin-top: 30px; width: 100%; max-width: 300px; padding: 18px 18px 14px;
          border-radius: 8px; background: linear-gradient(180deg, #1a0a0a, #050202);
          border: 1px solid #5c1d1d;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.8), inset 0 0 14px rgba(139, 0, 0, 0.3);
          opacity: 0; transform: translate3d(0, 20px, 0);
          animation: buttonFadeUp 0.6s ease-out 1.5s forwards;
          display: flex; flex-direction: column; align-items: center; gap: 12px;
        }
        @keyframes buttonFadeUp { to { opacity: 1; transform: translate3d(0, 0, 0); } }
        .defeat-recap .cer-piste { filter: saturate(0.45) brightness(0.8); }
        .defeat-button {
          width: 100%; padding: 12px 32px; cursor: pointer; border-radius: 4px;
          background: linear-gradient(180deg, #2a1010 0%, #0a0404 100%);
          border: 1px solid #5c1d1d; color: #d4b896;
          font-family: 'Cinzel', serif; font-size: 0.85rem; letter-spacing: 0.15em; text-transform: uppercase;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.8), inset 0 0 10px rgba(139, 0, 0, 0.3);
          transition: border-color 0.3s, box-shadow 0.3s;
        }
        .defeat-button:active { transform: scale(0.96); border-color: #ff3333; box-shadow: 0 0 15px rgba(255, 51, 51, 0.5); }
        .defeat-lien {
          background: none; border: none; cursor: pointer; color: var(--muted);
          font-family: 'Cinzel', serif; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
        }
        .defeat-lien:hover { color: var(--bone); }

        /* LA DALLE dans laquelle les alveoles sont taillees.
           Meme regle physique que les cases, appliquee a l'envers : une dalle est un
           RELIEF vu de dessus, donc son bord superieur capte la lumiere (clair) et son
           bord inferieur tombe dans l'ombre (sombre). Les alveoles, elles, font
           l'inverse. C'est ce couple relief/creux qui donne l'epaisseur de la pierre.
           Le padding passe de 8 a 13 px : sans marge, un rebord n'a nulle part ou
           exister, il se confondrait avec la premiere rangee de cases. */
        .table { position: relative; display: grid; isolation: isolate; grid-template-columns: repeat(var(--board-cols, 5), 1fr); gap: 5px;
          background: linear-gradient(180deg, #2b2438 0%, #241d31 46%, #17121f 100%);
          padding: 13px; border-radius: 16px;
          border: 1px solid rgba(203,164,86,0.16);
          box-shadow:
            inset 0 1.5px 0 rgba(255,240,205,0.10),
            inset 0 -2px 3px rgba(0,0,0,0.75),
            inset 0 0 46px rgba(0,0,0,0.5),
            0 3px 0 rgba(10,8,14,0.9),
            0 22px 42px rgba(0,0,0,0.45); }
        /* En mode arene le cadre de la ligue joue deja ce role : la dalle s'efface pour
           ne pas empiler deux bordures. */
        .table.arene { padding: 20px; box-shadow: none; }
        /* Arène de ligue : un CALQUE placé derrière le plateau, jamais un padding.
           La première version gonflait le plateau par un padding en %, qui débordait du
           conteneur et se faisait couper. Ici le plateau garde exactement sa taille ; le
           cadre peint s'étend au-delà via inset négatif (piloté par --arene-marge, l'épaisseur
           du cadre mesurée sur chaque image) et le conteneur l'autorise à dépasser.
           Trois choses le fondent dans la page au lieu de faire "image collée" :
           - un masque radial qui évapore les bords extérieurs vers le fond de la page ;
           - un voile de la teinte du jeu (mix-blend multiply léger via gradient) ;
           - une respiration lente de luminosité, coupée si animations réduites. */
        /* ═══ ÉCRAN DE JEU : tout tient dans la hauteur, sans jamais faire défiler ═══
           Le verrouillage ne vaut QUE pendant la partie (classe posée sur la racine quand
           phase === "play"). Les menus, l'Histoire et les règles gardent leur défilement :
           les figer aurait tronqué leurs textes longs.
           Le vrai coupable du débordement : les cases étaient dimensionnées en vw, donc
           d'après la LARGEUR de l'écran. Sur un téléphone étroit et haut, cinq colonnes
           tenaient en largeur mais les quatre lignes dépassaient en hauteur. Elles se
           calent maintenant sur la plus contraignante des deux dimensions. */
        .emprise-root.ecran-jeu { padding-top: 4px; }
        .emprise-root.ecran-jeu {
          height: 100dvh; max-height: 100dvh;
          /* Filet de securite : une partie normale tient dans l'ecran et ne defile
             jamais. Mais le bac a sable ajoute le choix d'arene, celui des Herauts et
             deux mains de onze vignettes ; en coupant net, on rendait le bouton Quitter
             inatteignable. Mieux vaut un defilement qu'un joueur enferme. Pendant qu'une
             carte est tenue, le glissement natif reste bloque (voir bloqueDefilement),
             le geste de pose n'est donc pas confondu avec un defilement. */
          overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain;
          -webkit-overflow-scrolling: touch;
          display: flex; flex-direction: column; justify-content: space-between;
          padding-top: 4px; padding-bottom: 4px; gap: 2px;
        }
        /* La ligne est vide la plupart du temps depuis qu'on a retire l'invite
           permanente. Hauteur reservee : sans elle, le plateau remonte et redescend
           a chaque fois qu'un message apparait ou disparait. */
        .emprise-root.ecran-jeu .status-line {
          margin: 2px 0; font-size: 12px; min-height: 1.25em;
        }
        .emprise-root.ecran-jeu .hand-row { padding: 5px 7px; gap: 5px; }
        .emprise-root.ecran-jeu .table { gap: 4px; }
        /* Hauteur de case = la plus petite des deux contraintes. Le rapport 1,333 est celui
           d'une carte ; la largeur en découle, jamais l'inverse.
           Les coefficients vw (22,4 / 16,8) exploitent la largeur d'écran qui restait
           inutilisée : le plateau laissait 56 à 70 px de marges latérales vides, d'où des
           cartes inutilement étroites. 16,8 est le maximum mesuré qui garde une marge
           latérale confortable (18 px sur un iPhone 13) ; au-delà les cases touchent les
           bords de l'écran. Les coefficients dvh (11,2 / 8,4) sont volontairement
           inchangés : ils prennent le relais sur les écrans courts (iPhone SE et compagnie),
           déjà pleins en hauteur à 4 px près, là, les cases gardent exactement leur taille
           d'avant au lieu de pousser la main et les boutons hors de l'écran. Mesuré écran par
           écran avant d'être appliqué. */
        .emprise-root.ecran-jeu .cell {
          height: min(22.4vw, 11.2dvh); width: min(16.8vw, 8.4dvh);
        }
        /* La carte posée épouse exactement sa case. Sans cette règle elle gardait sa taille
           d'origine, plus grande que la case réduite : les cartes du plateau se chevauchaient. */
        .emprise-root.ecran-jeu .cell > .card { width: 100%; height: 100%; }
        .emprise-root.ecran-jeu .card.hand {
          height: min(14.5vw, 8dvh); width: min(11vw, 6dvh);
        }
        /* Cartes en éventail : nettement plus grandes que la main repliée, c'est tout
           l'intérêt des vignettes, qui libèrent la place pour les lire confortablement le
           temps de choisir. Le sélecteur à 3 classes l'emporte sur la règle ci-dessus. */
        .emprise-root.ecran-jeu .card.hand.in-fan {
          height: min(21vw, 12dvh); width: min(16vw, 9.1dvh);
        }
        .emprise-root.ecran-jeu .card.hand.in-fan .rank {
          width: min(5.6vw, 3.1dvh); height: min(5.6vw, 3.1dvh); font-size: min(3.2vw, 1.8dvh);
        }

        /* Les pastilles de rang étaient d'une taille fixe (20 px). Sur des cartes réduites
           pour tenir dans l'écran, elles occupaient presque toute la place et se touchaient :
           d'où l'impression d'écrasement. Elles suivent maintenant la taille de la carte. */
        .emprise-root.ecran-jeu .rank {
          width: min(4.6vw, 2.6dvh); height: min(4.6vw, 2.6dvh);
          font-size: min(2.7vw, 1.55dvh); border-width: 1.5px;
        }
        .emprise-root.ecran-jeu .card.hand .rank {
          width: min(4.2vw, 2.4dvh); height: min(4.2vw, 2.4dvh); font-size: min(2.5vw, 1.45dvh);
        }
        @media (min-width: 700px) and (min-height: 760px) {
          .emprise-root.ecran-jeu .rank,
          .emprise-root.ecran-jeu .card.hand .rank { width: 20px; height: 20px; font-size: 11px; border-width: 2px; }
        }
        .emprise-root.ecran-jeu .arene-test { margin: 2px 0 0; gap: 4px; }
        .emprise-root.ecran-jeu .arene-test button { padding: 3px 7px; font-size: 9px; }
        /* Sur écran large (ordinateur), rien ne change : on retrouve les tailles d'origine. */
        @media (min-width: 700px) and (min-height: 760px) {
          .emprise-root.ecran-jeu .cell { width: clamp(50px, 16vw, 66px); height: clamp(68px, 21vw, 88px); }
          .emprise-root.ecran-jeu .card.hand { width: clamp(58px, 17vw, 72px); height: clamp(78px, 23vw, 96px); }
          .emprise-root.ecran-jeu .card.hand.in-fan { width: clamp(64px, 19vw, 84px); height: clamp(86px, 26vw, 114px); }
          .emprise-root.ecran-jeu .order-tile { width: 54px; height: 54px; }
        }

        .table.arene { background: transparent; border: none; box-shadow: none; overflow: visible; padding: 20px; }
        /* Sur un ecran court (iPhone SE et compagnie) il n'y a pas de place a reprendre :
           mesure, le cadre agrandi remontait sur la barre de score. On y garde l'ancien
           reglage. Le gain vertical ne profite qu'aux ecrans qui ont de quoi le donner. */
        @media (max-height: 700px) {
          .arene-cadre { inset: calc(var(--arene-marge, 16) * -0.4%) calc(var(--arene-marge, 16) * -0.7%) !important; }
          .table.arene .cell { height: min(17.5vw, 10.1dvh); }
        }
        /* Avec une arene, les cases se resserraient d'environ 10 % pour que les cartes des
           quatre coins ne viennent pas coller au cadre.
           La LARGEUR garde ce retrait : c'est elle qui plafonne, le cadre est deja a 4 px
           des bords de l'ecran. La HAUTEUR, elle, est rendue : le cadre s'ecarte desormais
           vers le haut et vers le bas (voir .arene-cadre), il y a la place. Les cartes
           gagnent en presence sans qu'aucun bord ne soit coupe. */
        .table.arene .cell { width: min(13.2vw, 7.6dvh); height: min(18.1vw, 10.5dvh); }

        /* ---- 1. AMBIANCE : la teinte de la ligue diffusée dans la page ----
           Même image, agrandie et floutée, effacée bien avant le haut et le bas de l'écran.
           C'est elle qui supprime l'effet "image collée" : le regard ne rencontre plus
           aucun bord d'image, seulement une couleur qui s'éteint. */
        .arene-ambiance {
          content: ""; position: absolute; z-index: -3; pointer-events: none;
          /* Suit l'agrandissement vertical du cadre : sinon le halo colore s'eteignait
             avant lui et on revoyait un bord d'image franc, exactement ce que cette
             couche sert a supprimer. */
          inset: -34% -30%;
          background-image: var(--arene);
          background-size: cover; background-position: center;
          /* Plus flou et plus large qu'avant : le halo doit DEBORDER le cadre, pas
             s'arreter avant lui. C'est ce debordement qui raccorde l'image a la page ;
             tant qu'il s'eteignait en deca, il ne raccordait rien du tout. */
          filter: blur(42px) saturate(1.2) brightness(0.6);
          opacity: 0.82;
          /* Le premier palier est passe de 16 % a 30 % : au-dela, le halo remontait
             derriere la barre de score et lui mangeait son contraste. Il deborde toujours
             autant sur les cotes et vers le bas, la ou c'est utile. */
          -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 30%, #000 76%, transparent 100%);
          mask-image: linear-gradient(180deg, transparent 0%, #000 30%, #000 76%, transparent 100%);
        }

        /* ---- 2. CADRE : l'image nette, autour de la seule aire de jeu ----
           Le débordement latéral reste piloté par --arene-marge (l'épaisseur de cadre
           mesurée sur chaque image), mais le fondu du haut est désormais franc : le cadre
           ne monte plus jusqu'aux boutons de ligue, il s'éteint avant. */
        .arene-cadre {
          position: absolute; z-index: -2; pointer-events: none; overflow: hidden;
          /* Vertical porte de -0,4 % a -0,75 %. Mesure : il restait 303 px libres au-dessus
             du cadre et 173 en dessous. Un premier essai a -2,2 % a ete rejete a l'oeil, le
             cadre avalait la barre de score et mordait sur la main ; -1,0 % mordait encore
             le score sur iPhone 13 et la main sur SE. L'horizontal ne bouge
             pas : a 382 px sur un ecran de 390, il ne reste que 4 px de chaque cote. */
          inset: calc(var(--arene-marge, 16) * -0.75%) calc(var(--arene-marge, 16) * -0.7%);
          background-image: linear-gradient(180deg, rgba(20,17,28,0.16), rgba(20,17,28,0.26)), var(--arene);
          background-size: 100% 100%, 100% 100%; background-position: center;
          border-radius: 18px;
          /* Trois couches, et il en faut trois : l'ellipse arrondit l'extinction, le
             degrade vertical efface le haut et le bas, l'HORIZONTAL efface les cotes.
             C'est ce dernier qui manquait : les bords gauche et droit se terminaient
             sur une arete franche, la signature meme de l'image collee.
             Le fondu part de 46 % du rayon au lieu de 78 %, en trois paliers : plus de
             cassure, seulement une extinction progressive.
             ATTENTION : trois couches demandent DEUX operations de composition. Avec une
             seule valeur, la troisieme est ignoree en silence. */
          -webkit-mask-image:
            radial-gradient(ellipse 112% 106% at 50% 50%, #000 46%, rgba(0,0,0,0.72) 70%, rgba(0,0,0,0.28) 87%, transparent 100%),
            linear-gradient(180deg, transparent 0%, #000 11%, #000 87%, transparent 100%),
            linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%);
          mask-image:
            radial-gradient(ellipse 112% 106% at 50% 50%, #000 46%, rgba(0,0,0,0.72) 70%, rgba(0,0,0,0.28) 87%, transparent 100%),
            linear-gradient(180deg, transparent 0%, #000 11%, #000 87%, transparent 100%),
            linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%);
          -webkit-mask-composite: source-in, source-in; mask-composite: intersect, intersect;
          animation: arene-respire 7s ease-in-out infinite;
        }
        /* La lueur pulse sur le cadre lui-même. drop-shadow suit la forme réelle de l'image
           une fois masquée, contrairement à box-shadow qui n'aurait éclairé qu'un rectangle. */
        @keyframes arene-respire {
          0%, 100% { filter: brightness(0.94) saturate(0.98) drop-shadow(0 0 6px var(--arene-braise, rgba(203,164,86,0.5))); }
          50%      { filter: brightness(1.08) saturate(1.06) drop-shadow(0 0 18px var(--arene-braise, rgba(203,164,86,0.85))); }
        }

        /* ---- 3 bis. GEMMES : scintillement posé sur les pierres de l'image ----
           Le point est centré sur la gemme et pulse en décalé d'un coin à l'autre, pour que
           le cadre respire au lieu de clignoter d'un bloc. mix-blend-mode: screen fait que
           la lueur s'ajoute à la pierre au lieu de la recouvrir. */
        .arene-gemme {
          position: absolute; width: 5.5%; aspect-ratio: 1; transform: translate(-50%, -50%);
          border-radius: 50%; pointer-events: none; mix-blend-mode: screen;
          background: radial-gradient(circle, var(--gemme) 0%, transparent 68%);
          animation: arene-gemme-brille 3.6s ease-in-out infinite;
        }
        /* Ornements des milieux de côté : plus fins que les gemmes d'angle, donc un point
           plus petit et un peu moins vif, décalé d'un demi-temps pour alterner avec eux. */
        .arene-gemme.mid { width: 3.6%; opacity: 0.8; }
        @keyframes arene-gemme-brille {
          0%, 100% { opacity: 0.25; filter: blur(2px); }
          45%      { opacity: 0.95; filter: blur(0.5px); }
          62%      { opacity: 0.6; filter: blur(1px); }
        }

        /* ---- 4. FUMEROLLES ET ÉTINCELLES ---- */
        .arene-fumee { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: visible; }
        .arene-particule {
          position: absolute; display: block; border-radius: 50%;
          width: var(--taille, 3px); height: var(--taille, 3px);
          animation-name: arene-monte; animation-timing-function: ease-out;
          animation-iteration-count: infinite; opacity: 0;
        }
        .arene-particule.etincelle {
          background: var(--arene-braise, rgba(255,170,80,0.9));
          box-shadow: 0 0 6px var(--arene-braise, rgba(255,170,80,0.9)), 0 0 12px rgba(255,120,40,0.55);
        }
        .arene-particule.fumee {
          background: radial-gradient(circle, rgba(190,190,205,0.16) 0%, transparent 70%);
          filter: blur(5px);
        }
        @keyframes arene-monte {
          0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
          14%  { opacity: 0.85; }
          70%  { opacity: 0.5; }
          100% { transform: translate(var(--derive, 12px), -230px) scale(1.5); opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .arene-cadre { animation: none; filter: brightness(1) saturate(1); }
          .arene-fumee { display: none; }
        }
        /* Sélecteur d'arène du bac à sable, bloc temporaire, à retirer avant publication. */
        .arene-test { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin: 8px 0 2px; position: relative; z-index: 5; }
        .arene-test button {
          font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
          color: #b8ab8d; background: rgba(30,25,42,0.9); border: 1px solid rgba(203,164,86,0.35);
          padding: 5px 9px; border-radius: 6px; cursor: pointer;
        }
        .arene-test button.actif { color: #14111c; background: var(--gold); border-color: var(--gold); }
        /* Bascule des capacités supérieures, bloc temporaire lui aussi. L'étiquette porte
           le sens une seule fois, les boutons ne portent plus que le nom de l'Ordre. */
        .heraut-test { align-items: center; }
        .heraut-test-label {
          font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--muted); margin-right: 2px;
        }
        /* Nom de la règle qui vient de se déclencher, affiché en grand par-dessus le plateau
           pour que le joueur comprenne immédiatement ce qu'il vient de se passer. */
        .ability-banner {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
          z-index: 20; pointer-events: none; font-family: 'Cinzel', serif; font-weight: 700;
          font-size: clamp(14px, 4vw, 20px); letter-spacing: 0.08em; text-transform: uppercase;
          white-space: nowrap; animation: banner-pop 2.8s ease;
        }
        .ability-banner.banner-resonance { color: #fff; text-shadow: 0 0 10px #fff, 0 0 22px var(--gold-bright), 0 0 40px var(--gold-bright); }
        .ability-banner.banner-onde { color: #fff; text-shadow: 0 0 10px #fff, 0 0 22px var(--combo), 0 0 40px var(--combo); }
        @keyframes banner-pop {
          0% { opacity: 0; scale: 0.6; }
          15% { opacity: 1; scale: 1.1; }
          25% { scale: 1; }
          78% { opacity: 1; scale: 1; }
          100% { opacity: 0; scale: 1.15; }
        }
        .table.table-shake { animation: table-shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97); }
        @keyframes table-shake {
          0%, 100% { transform: translate(0, 0); }
          15% { transform: translate(-1.5px, 0.5px); }
          30% { transform: translate(1.5px, -0.5px); }
          45% { transform: translate(-1px, -0.5px); }
          60% { transform: translate(1px, 0.5px); }
          75% { transform: translate(-0.5px, 0); }
        }
        /* Onde : micro-secousse amplifiée du plateau entier, uniquement quand la chaîne de
           combo dépasse 2 cartes (chaîne longue = impact plus marqué). */
        .table.table-shake-big { animation: table-shake-big 0.55s cubic-bezier(0.36, 0.07, 0.19, 0.97); }
        @keyframes table-shake-big {
          0%, 100% { transform: translate(0, 0); }
          12% { transform: translate(-4px, 1.5px); }
          25% { transform: translate(4px, -1.5px); }
          38% { transform: translate(-3px, -1px); }
          51% { transform: translate(3px, 1.5px); }
          64% { transform: translate(-2px, -1px); }
          77% { transform: translate(2px, 1px); }
          88% { transform: translate(-1px, 0); }
        }
        /* ALVEOLE CREUSEE DANS LA PIERRE, et non case en pointilles.
           Le pointille est le motif du "champ a remplir" : sur un plateau, l'oeil y lit un
           formulaire. Ici on creuse.
           La regle physique qui fait tout : une cavite recoit la lumiere par le HAUT, donc
           son bord superieur est SOMBRE (dans l'ombre du rebord) et son bord inferieur est
           CLAIR (il capte la lumiere). C'est l'inverse exact d'un bouton en relief, et
           c'est ce qui distingue un creux d'une bosse. Deux ombres internes suffisent,
           aucune image.
           Le liseré dore n'est pas supprime : il devient un filet grave au fond, discret,
           pour que la case jouable (qui garde un or franc) tranche enfin nettement. */
        .cell { position: relative; width: clamp(50px, 16vw, 66px); height: clamp(68px, 21vw, 88px); border-radius: 9px;
          background: linear-gradient(180deg, rgba(0,0,0,0.42), rgba(255,255,255,0.028) 62%, rgba(255,255,255,0.045));
          border: 1px solid rgba(203,164,86,0.09);
          box-shadow:
            inset 0 3px 6px rgba(0,0,0,0.72),
            inset 0 -1.5px 0 rgba(255,240,205,0.07),
            inset 0 0 14px rgba(0,0,0,0.45);
          display: flex; align-items: center; justify-content: center; }
        /* La case ou l'on peut poser : la pierre s'allume par en dessous, comme si la
           faille affleurait. L'ombre du creux reste, sinon la case redeviendrait plate. */
        .cell.empty.can-play { cursor: pointer; border: 1px solid var(--gold);
          background: linear-gradient(180deg, rgba(0,0,0,0.3), rgba(203,164,86,0.10) 65%, rgba(203,164,86,0.17));
          box-shadow: inset 0 3px 6px rgba(0,0,0,0.55), inset 0 -2px 0 rgba(232,200,119,0.28), 0 0 12px rgba(203,164,86,0.18); }
        .cell.empty.can-play:hover { background: linear-gradient(180deg, rgba(0,0,0,0.26), rgba(203,164,86,0.18) 65%, rgba(203,164,86,0.26)); }
        .cell.drag-target { border: 2px solid var(--gold-bright); background: rgba(203,164,86,0.16); box-shadow: 0 0 14px rgba(203,164,86,0.25); }
        .cell.cell-previewing { background: rgba(203,164,86,0.1); }
        .card.previewing { opacity: 0.72; animation: preview-pulse 1s ease-in-out infinite; }
        @keyframes preview-pulse { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }
        .cell.hint-target { border: 2px solid #6ec9e8; box-shadow: 0 0 14px rgba(110,201,232,0.4); animation: hint-pulse 1.4s ease-in-out infinite; }
        .card.hand.draggable { cursor: grab; touch-action: none; }
        /* Les vignettes aussi : un doigt qui s'y pose ne devient JAMAIS un defilement,
           que le groupe soit glissable (1 carte) ou a eventail (le tap suffit). Sans ca,
           iOS recuperait le geste et faisait defiler l'ecran au lieu de la carte. */
        .order-tile { touch-action: none; }
        .card.hand.draggable:active { cursor: grabbing; }
        .card.hand.dragging-source { opacity: 0.35; }
        .card.hand.hint-source { outline: 2px solid #6ec9e8; outline-offset: 2px; animation: hint-pulse 1.4s ease-in-out infinite; }
        @keyframes hint-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        .drag-ghost { position: fixed; top: 0; left: 0; transform: translate(-50%, -50%); pointer-events: none; z-index: 999; opacity: 0.95; }
        .drag-ghost .card { transform: scale(1.08); box-shadow: 0 12px 24px rgba(0,0,0,0.5); }
        /* ================= POISON : montée de la dose ================= */
        /* Gaz, venin, acide. Aucun chiffre, aucun symbole. Le niveau se lit à la quantité
           de toxine : un voile, puis des gouttelettes, puis une flaque, puis un brouillard.
           ⚠️ Structure importante : le flou du gaz est porté par les pseudo-éléments du
           calque, JAMAIS par le calque lui-même. Un filter s'applique à tous les
           descendants, le poser sur .poison-fx floutait la flaque et les bulles. */
        
        /* --- La case : la bordure vire du vert clair au jaune d'alerte --- */
        .cell.poisoned{border-style:solid;border-color:#8fc855;
          background:rgba(90,150,45,.10);
          box-shadow:inset 0 0 12px rgba(90,150,45,.35)}
        .cell.poisoned.can-play{border-color:var(--gold)}
        /* Pendant le survol d'une carte en glisser : la case montre l'apercu de pose,
           les pastilles de dose se retirent pour ne pas se superposer a la carte. */
        .cell.poisoned.drag-target::after{display:none}
        /* --- Compteur de dose : 1 à 4 pastilles, au CENTRE de la case.
           Centrées volontairement : en haut elles recouvriraient le rang supérieur de la
           carte pendant l'aperçu de pose, et en bas la flaque les avalerait à partir du
           niveau 3. Au-dessus de toutes les couches, donc lisibles même dans le brouillard.
           Jusqu'à quatre, l'œil les compte d'un seul regard. --- */
        .cell.poisoned::after{
          content:"";position:absolute;z-index:5;left:50%;top:50%;margin-top:-2.5px;
          width:5px;height:5px;border-radius:50%;margin-left:-2.5px;
          color:#eaffb4;background:currentColor;
          filter:drop-shadow(0 0 4px rgba(170,240,70,1)) drop-shadow(0 1px 1px rgba(0,0,0,.9))}
        .cell.poisoned.poison-lvl-2::after{margin-left:-7.5px;color:#f2ffc6;
          box-shadow:10px 0 0 currentColor}
        .cell.poisoned.poison-lvl-3::after{margin-left:-12.5px;color:#f8ffdc;
          box-shadow:10px 0 0 currentColor,20px 0 0 currentColor;
          filter:drop-shadow(0 0 5px rgba(168,232,60,1)) drop-shadow(0 1px 1px rgba(0,0,0,.9))}
        .cell.poisoned.poison-lvl-4::after{margin-left:-17.5px;color:#ffffff;
          box-shadow:10px 0 0 currentColor,20px 0 0 currentColor,30px 0 0 currentColor;
          animation:toxicPips .5s steps(1,end) infinite}
        /* Les pastilles clignotent en phase avec la bordure du niveau critique. */
        @keyframes toxicPips{
          0%,49%   {filter:drop-shadow(0 0 6px rgba(232,240,58,1)) drop-shadow(0 1px 1px rgba(0,0,0,.9))}
          50%,100% {filter:drop-shadow(0 0 6px rgba(125,255,58,1)) drop-shadow(0 1px 1px rgba(0,0,0,.9))}
        }
        
        .cell.poisoned.poison-lvl-2{border-color:#c3d93f;
          background:rgba(140,175,35,.20);
          box-shadow:inset 0 0 18px rgba(150,185,40,.55),0 0 7px rgba(195,217,63,.4)}
        .cell.poisoned.poison-lvl-3{border-color:#a8e83c;
          background:rgba(110,190,35,.28);
          box-shadow:inset 0 0 22px rgba(120,210,40,.7),0 0 12px rgba(168,232,60,.6)}
        .cell.poisoned.poison-lvl-4{border-color:#e8f03a;
          background:rgba(150,200,30,.38);
          animation:toxicPulse .5s steps(1,end) infinite}
        @keyframes toxicPulse{
          0%,49%   {border-color:#e8f03a;box-shadow:inset 0 0 26px rgba(200,225,40,.9),0 0 18px rgba(232,240,58,.95)}
          50%,100% {border-color:#7dff3a;box-shadow:inset 0 0 26px rgba(110,235,45,.9),0 0 18px rgba(125,255,58,.95)}
        }
        
        /* --- Le calque : simple conteneur, SANS filtre --- */
        .poison-fx{position:absolute;inset:0;border-radius:8px;overflow:hidden;pointer-events:none;
          z-index:1;--densite:.42;--flaque:0%}
        .cell.poison-lvl-2 .poison-fx{--densite:.68}
        .cell.poison-lvl-3 .poison-fx{--densite:.8;--flaque:55%}
        .cell.poison-lvl-4 .poison-fx{--densite:.97;--flaque:64%}
        
        /* NIVEAU 1, Voile de gaz : deux nappes floutées qui dérivent en sens inverse. */
        .poison-fx::before,.poison-fx::after{content:"";position:absolute;inset:-16%;border-radius:12px}
        .poison-fx::before{
          background:
            radial-gradient(ellipse 58% 44% at 34% 66%,rgba(150,220,70,.85),transparent 68%),
            radial-gradient(ellipse 48% 38% at 70% 40%,rgba(120,195,55,.7),transparent 66%);
          filter:blur(5px);opacity:var(--densite);
          animation:floatSmoke 7s ease-in-out infinite}
        .poison-fx::after{
          background:
            radial-gradient(ellipse 62% 46% at 62% 72%,rgba(185,225,60,.8),transparent 70%),
            radial-gradient(ellipse 44% 36% at 26% 34%,rgba(150,205,50,.65),transparent 66%);
          filter:blur(6px);opacity:calc(var(--densite) * .82);
          animation:floatSmoke 5.2s ease-in-out infinite reverse}
        @keyframes floatSmoke{
          0%,100%{transform:translate(0,0) scale(1)}
          33%    {transform:translate(3px,-6px) scale(1.1)}
          66%    {transform:translate(-3px,-3px) scale(1.05)}
        }
        /* NIVEAU 2 : le gaz s'épaissit et vire au jaune. */
        .cell.poison-lvl-2 .poison-fx::before{animation-duration:5.5s;
          background:
            radial-gradient(ellipse 60% 46% at 34% 66%,rgba(195,225,60,.9),transparent 68%),
            radial-gradient(ellipse 50% 40% at 70% 40%,rgba(165,205,45,.8),transparent 66%)}
        .cell.poison-lvl-3 .poison-fx::before{animation-duration:4.2s}
        .cell.poison-lvl-3 .poison-fx::after{animation-duration:3.4s}
        /* NIVEAU 4 : brouillard saturé. */
        .cell.poison-lvl-4 .poison-fx::before{animation-duration:3s;
          background:
            radial-gradient(ellipse 78% 60% at 42% 60%,rgba(210,240,70,.98),rgba(150,205,45,.8) 55%,transparent 82%),
            radial-gradient(ellipse 62% 50% at 72% 38%,rgba(190,230,55,.92),transparent 74%)}
        .cell.poison-lvl-4 .poison-fx::after{filter:blur(9px);animation-duration:2.3s;
          background:radial-gradient(ellipse 80% 62% at 60% 70%,rgba(225,245,80,.95),rgba(160,210,45,.75) 58%,transparent 84%)}
        
        /* NIVEAU 2, Gouttelettes de venin le long des bords. Nettes, hors du flou. */
        .poison-fx i:nth-child(1){position:absolute;inset:8%;opacity:0;z-index:2;
          background-image:
            radial-gradient(circle at 1% 0%  ,rgba(215,255,120,.95) 0 2.6px,transparent 3.3px),
            radial-gradient(circle at 99% 14%,rgba(200,245,100,.85) 0 2.1px,transparent 2.8px);
          filter:drop-shadow(0 0 3px rgba(180,240,80,.9))}
        .poison-fx i:nth-child(1)::before{content:"";position:absolute;inset:0;
          background-image:
            radial-gradient(circle at 1% 8% ,rgba(205,250,110,.9) 0 2.2px,transparent 2.9px),
            radial-gradient(circle at 99% 2%,rgba(215,255,120,.8) 0 1.8px,transparent 2.5px);
          animation:venomDrip 3.1s ease-in infinite;animation-delay:-1.6s}
        .cell.poison-lvl-2 .poison-fx i:nth-child(1),
        .cell.poison-lvl-3 .poison-fx i:nth-child(1),
        .cell.poison-lvl-4 .poison-fx i:nth-child(1){opacity:1;animation:venomDrip 4.4s ease-in infinite}
        .cell.poison-lvl-3 .poison-fx i:nth-child(1){animation-duration:3.2s}
        .cell.poison-lvl-4 .poison-fx i:nth-child(1){animation-duration:2.4s}
        @keyframes venomDrip{
          0%  {transform:translateY(0) scaleY(.6);opacity:0}
          12% {transform:translateY(4px) scaleY(1);opacity:1}
          70% {transform:translateY(46px) scaleY(1.25);opacity:1}
          92% {transform:translateY(66px) scaleY(1.5);opacity:.5}
          100%{transform:translateY(72px) scaleY(1.6);opacity:0}
        }
        
        /* NIVEAU 3, La flaque de venin. Nette, elle aussi hors du flou. */
        .poison-fx i:nth-child(2){position:absolute;left:6%;right:6%;bottom:0;
          height:var(--flaque);z-index:3;
          background:linear-gradient(180deg,rgba(200,250,90,.92),rgba(110,190,35,.95) 38%,rgba(45,95,15,.98));
          border-radius:46% 54% 5px 5px / 14px 11px 5px 5px;
          box-shadow:inset 0 0 14px rgba(190,245,80,.7),0 0 10px rgba(140,215,50,.55);
          animation:venomSurface 2.4s ease-in-out infinite}
        .cell.poison-lvl-4 .poison-fx i:nth-child(2){animation-duration:1.5s}
        @keyframes venomSurface{
          0%,100%{border-radius:46% 54% 5px 5px / 14px 11px 5px 5px;transform:translateY(0)}
          50%    {border-radius:54% 46% 5px 5px / 10px 15px 5px 5px;transform:translateY(-2.5px)}
        }
        
        /* NIVEAU 3, Bulles de gaz qui montent DANS la flaque et crèvent EN SURFACE.
           Le calque est borné à la hauteur de la flaque : elles ne peuvent pas s'en échapper. */
        .poison-fx i:nth-child(3){position:absolute;left:6%;right:6%;bottom:0;
          height:var(--flaque);opacity:0;z-index:4;
          background-image:
            radial-gradient(circle at 28% 100%,rgba(240,255,190,.95) 0 3px,transparent 3.8px),
            radial-gradient(circle at 67% 100%,rgba(225,255,160,.85) 0 2.2px,transparent 2.9px)}
        .poison-fx i:nth-child(3)::before{content:"";position:absolute;inset:0;
          background-image:
            radial-gradient(circle at 46% 100%,rgba(245,255,205,.9) 0 2.5px,transparent 3.3px),
            radial-gradient(circle at 84% 100%,rgba(225,255,160,.8) 0 1.9px,transparent 2.6px);
          animation:gasBurst 1.6s linear infinite;animation-delay:-.8s}
        .cell.poison-lvl-3 .poison-fx i:nth-child(3),
        .cell.poison-lvl-4 .poison-fx i:nth-child(3){opacity:1;animation:gasBurst 2.2s linear infinite}
        .cell.poison-lvl-4 .poison-fx i:nth-child(3){animation-duration:1.4s}
        @keyframes gasBurst{
          0%  {transform:translateY(2px) scale(.7);opacity:0}
          18% {transform:translateY(-2px) scale(1);opacity:1}
          72% {transform:translateY(-88%) scale(1);opacity:1}
          86% {transform:translateY(-96%) scale(1.8);opacity:.5}
          100%{transform:translateY(-100%) scale(2.4);opacity:0}
        }
        
        /* ---- Réaction de la carte posée dans le venin ---- */
        .card.card-acide.card-acide{animation:carte-acide .95s ease-out}
        @keyframes carte-acide{
          0%  {filter:brightness(2.6) saturate(.3) hue-rotate(65deg)}
          9%  {filter:brightness(1.7) saturate(1.4) hue-rotate(55deg)}
          16% {filter:brightness(.4) saturate(1.7) hue-rotate(45deg)}
          24% {filter:brightness(.45) saturate(1.6) hue-rotate(40deg)}
          33% {filter:brightness(.6) saturate(1.5) hue-rotate(34deg)}
          43% {filter:brightness(.75) saturate(1.35) hue-rotate(26deg)}
          54% {filter:brightness(.85) saturate(1.25) hue-rotate(18deg)}
          66% {filter:brightness(.92) saturate(1.15) hue-rotate(11deg)}
          79% {filter:brightness(.97) saturate(1.07) hue-rotate(5deg)}
          100%{filter:none}
        }
        .cell.poisoned.can-play { border-color: var(--gold); }
        /* Bouffée de brume toxique quand une case vient d'être empoisonnée */
        .cell.poison-burst::before {
          content: ""; position: absolute; inset: -5px; border-radius: 13px; pointer-events: none; z-index: 3;
          background: radial-gradient(circle, rgba(170,210,80,0.8), rgba(130,185,65,0.4) 52%, transparent 78%);
          opacity: 0; animation: poison-burst-cloud 1.9s ease;
        }
        @keyframes poison-burst-cloud {
          0% { opacity: 0; transform: scale(0.45); }
          28% { opacity: 1; transform: scale(1.25); }
          58% { opacity: 0.8; transform: scale(1.02); }
          100% { opacity: 0; transform: scale(1.32); }
        }
        .cell.poison-previewing::after { animation: preview-pulse 1s ease-in-out infinite; }

        .card { position: relative; width: clamp(50px, 16vw, 66px); height: clamp(68px, 21vw, 88px); border-radius: 9px; display: flex; flex-direction: column;
          align-items: center; justify-content: center; font-family: 'Cinzel', serif; user-select: none;
          transform-style: preserve-3d; transition: transform .5s cubic-bezier(.4,.2,.2,1); overflow: visible; will-change: transform; }
/* HALO DE CAMP — le plus gros gain de performance du fichier.
           Il animait box-shadow sur CHAQUE carte du plateau. Une ombre ne peut pas etre
           confiee au processeur graphique : le navigateur redessinait donc les 14 cartes
           a chaque image. Mesure : 11 images par seconde, contre 57 sans lui.
           Ici l'ombre est FIXE et posee sur un pseudo-element ; seule son opacite pulse,
           et l'opacite est composee par le processeur graphique, sans redessin.
           L'apparence est identique. REGLE POUR LA SUITE : en boucle, n'animer que
           transform et opacity. */
        .card.blue:not(.hand) { background: linear-gradient(160deg, #2c4d7c, #1c3252 65%); border: 1.5px solid #7fc8ff;
          box-shadow: 0 0 3px rgba(127,200,255,0.6), 0 0 8px rgba(90,170,255,0.4), 0 0 14px rgba(70,150,255,0.25), 0 6px 14px rgba(0,0,0,0.4);
          /* Couleurs pour les retournements de capture : une carte DEVENUE bleue etait
             rouge — le flip garde son ancienne robe jusqu'au moment ou elle est de profil,
             puis revele la nouvelle. Sans ces variables, la couleur changeait des la mise a
             jour du plateau, plusieurs secondes AVANT l'animation d'Onde. */
          --flip-ancien-bg: linear-gradient(160deg, #7c332c, #4e1f1a 65%);
          --flip-ancien-bord: #ff7a68;
          --flip-ancien-ombre: 0 0 3px rgba(255,122,104,0.6), 0 0 8px rgba(255,90,70,0.4), 0 0 14px rgba(255,70,50,0.25), 0 6px 14px rgba(0,0,0,0.4);
          --flip-nouveau-bg: linear-gradient(160deg, #2c4d7c, #1c3252 65%);
          --flip-nouveau-bord: #7fc8ff; }
        .card.blue:not(.hand)::before, .card.red:not(.hand)::before {
          content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
          opacity: 0; will-change: opacity; z-index: 0;
          animation: halo-respire 2.6s ease-in-out infinite;
        }
        .card.blue:not(.hand)::before {
          box-shadow: 0 0 4px rgba(127,200,255,0.75), 0 0 11px rgba(90,170,255,0.55), 0 0 18px rgba(70,150,255,0.35);
        }
        .card.red:not(.hand)::before {
          box-shadow: 0 0 4px rgba(255,122,104,0.75), 0 0 11px rgba(255,90,70,0.55), 0 0 18px rgba(255,70,50,0.35);
        }
        @keyframes halo-respire { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
        /* Pendant un retournement de capture (immediat ou en attente d'Onde), le halo
           respirant pulse deja aux couleurs du NOUVEAU camp : il revelerait la couleur
           avant l'animation. On le coupe le temps de la sequence. */
        .card.flash-basic.flash-basic::before,
        .card.flash-same.flash-same::before,
        .card.flash-combo.flash-combo::before { animation: none; opacity: 0; }
        .card.red:not(.hand) { background: linear-gradient(160deg, #7c332c, #4e1f1a 65%); border: 1.5px solid #ff7a68;
          box-shadow: 0 0 3px rgba(255,122,104,0.6), 0 0 8px rgba(255,90,70,0.4), 0 0 14px rgba(255,70,50,0.25), 0 6px 14px rgba(0,0,0,0.4);
          --flip-ancien-bg: linear-gradient(160deg, #2c4d7c, #1c3252 65%);
          --flip-ancien-bord: #7fc8ff;
          --flip-ancien-ombre: 0 0 3px rgba(127,200,255,0.6), 0 0 8px rgba(90,170,255,0.4), 0 0 14px rgba(70,150,255,0.25), 0 6px 14px rgba(0,0,0,0.4);
          --flip-nouveau-bg: linear-gradient(160deg, #7c332c, #4e1f1a 65%);
          --flip-nouveau-bord: #ff7a68; }
        .card.hand.blue { background: linear-gradient(160deg, #2c4d7c, #1c3252 65%); border: 1px solid var(--blue-bright);
          box-shadow: 0 0 0 1px rgba(111,164,230,0.15), 0 6px 14px rgba(0,0,0,0.4); }
        .card.hand.red { background: linear-gradient(160deg, #7c332c, #4e1f1a 65%); border: 1px solid var(--red-bright);
          box-shadow: 0 0 0 1px rgba(224,101,90,0.15), 0 6px 14px rgba(0,0,0,0.4); }

        .card .portrait-frame { width: 100%; flex: 1; display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.14), transparent 70%);
          border-radius: 6px; overflow: hidden; }
        .card .portrait-frame img { width: 100%; height: 100%; object-fit: cover; }
        .card .icon { font-size: 22px; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.5)); }

        /* --- Game feel : pose de carte (zoom arrière + rebond élastique) --- */
        .card.flash-place.flash-place { animation: card-land 1.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
        /* Pose du bot : en plus du rebond d'atterrissage, la carte vient visiblement d'en
           haut (où se trouve sa main) au lieu d'apparaître directement sur la case, évite
           l'effet "téléportation" qu'on n'a pas avec le joueur, qui glisse sa carte à l'écran.
           Le !important est nécessaire : .card.red a déjà sa propre animation en boucle (halo
           qui pulse) qui gagnerait sinon le conflit et empêcherait celle-ci de jouer. */
        .card.flash-place-slow.flash-place-slow { animation: card-land-bot 3.5s cubic-bezier(0.34, 1.56, 0.64, 1) !important; }
        /* La carte de l'Echo tombait de 400 px en 1,6 s : pendant tout ce temps on voyait
           l'alveole VIDE avec une carte suspendue au-dessus. Ce n'etait pas genant tant
           que les cases etaient de simples pointilles ; depuis qu'elles sont creusees, le
           trou beant se voit.
           La chute part maintenant de 150 px et se termine a 18 % (0,63 s au lieu de 1,6),
           et la carte reste transparente au depart : elle n'apparait qu'a mi-chemin, deja
           proche de sa case. La duree totale ne bouge pas, c'est elle qui signale ou
           l'Echo vient de jouer. */
        @keyframes card-land-bot {
          0%   { transform: translateY(-150px) scale(1.22); opacity: 0; box-shadow: 0 26px 40px rgba(0,0,0,0.55); }
          8%   { opacity: 0.85; }
          18%  { transform: translateY(0) scale(0.94); opacity: 1; box-shadow: 0 2px 6px rgba(0,0,0,0.6); }
          30%  { transform: translateY(0) scale(1.04); }
          40%  { transform: translateY(0) scale(1); }
          100% { transform: translateY(0) scale(1); }
        }
        @keyframes card-land {
          0%   { transform: scale(1.45); opacity: 0; box-shadow: 0 26px 40px rgba(0,0,0,0.55); }
          55%  { transform: scale(0.94); opacity: 1; box-shadow: 0 2px 6px rgba(0,0,0,0.6); }
          75%  { transform: scale(1.04); }
          100% { transform: scale(1); }
        }

        /* --- Game feel : survol des cartes en main (élévation + scale + tilt 3D suivant le curseur) --- */
        .card.hand.draggable { will-change: transform; --tilt-x: 0deg; --tilt-y: 0deg;
          transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease; }
        .card.hand.draggable:hover { transform: perspective(600px) translateY(-8px) scale(1.05) rotateX(var(--tilt-x)) rotateY(var(--tilt-y)); z-index: 5;
          transition: transform 0.06s linear, box-shadow 0.22s ease; /* suivi du curseur quasi instantané pendant le survol */
          box-shadow: 0 14px 22px rgba(0,0,0,0.5), 0 0 12px rgba(203,164,86,0.2); }

        /* ---------- Retournement vs decoration : deux couloirs separes ----------
           La propriete animation est UNIQUE. Les regles .card.flash-X.flash-X avaient
           toutes la meme specificite : sur une carte qui porte plusieurs classes a la fois
           (Eveil + capture, Gardien + capture, Onde emettrice + capture...), la DERNIERE
           declaree gagnait et le retournement disparaissait purement et simplement.
           Mesure avant correctif : 31,8 % des cartes censees se retourner ne le faisaient pas.
           Desormais chaque decoration ecrit AUSSI sa valeur dans --anim-deco (une variable,
           donc aucune concurrence), et les retournements, passes a 4 classes, composent la
           liste var(--anim-deco) puis le flip. Le flip est en DERNIER : il gagne sur transform.
           --flip-delay laisse d abord jouer les decorations dont le transform porte du sens.
           A RETENIR : toute nouvelle animation posee sur .card doit ecrire dans --anim-deco
           si elle est decorative, sinon elle avalera de nouveau le retournement.
           A RETENIR AUSSI : aucun accent grave ici, APP_STYLES est une chaine template. */
        .card.flash-basic.flash-basic.flash-basic { animation: var(--anim-deco, none), flip-gold 1.6s cubic-bezier(0.34, 1.4, 0.64, 1) var(--flip-delay, 0s) backwards; }
        .card.flash-same.flash-same.flash-same { animation: var(--anim-deco, none), flip-resonance 1.6s cubic-bezier(0.34, 1.4, 0.64, 1) var(--flip-delay, 0s) backwards; }
        .card.flash-combo.flash-combo.flash-combo { animation: var(--anim-deco, none), flip-combo 1.6s cubic-bezier(0.34, 1.4, 0.64, 1) var(--flip-delay, 0s) backwards; }
        .card.flash-mue-h.flash-mue-h.flash-mue-h { animation: var(--anim-deco, none), mue-flip-h 1.6s ease var(--flip-delay, 0s); }
        .card.flash-mue-v.flash-mue-v.flash-mue-v { animation: var(--anim-deco, none), mue-flip-v 1.6s ease var(--flip-delay, 0s); }
        .card.flash-mue-self.flash-mue-self { animation: mue-self-pulse 1.6s ease; --anim-deco: mue-self-pulse 1.6s ease; }
        .card.flash-percee.flash-percee { animation: percee-slash 1.6s cubic-bezier(0.2, 0.8, 0.3, 1); position: relative; --anim-deco: percee-slash 1.6s cubic-bezier(0.2, 0.8, 0.3, 1); }
        .card.flash-percee-self.flash-percee-self { animation: percee-thrust 1.6s ease; --anim-deco: percee-thrust 1.6s ease; }
        .card.flash-portee.flash-portee { animation: portee-impact 1.6s ease; position: relative; --anim-deco: portee-impact 1.6s ease; }
        .card.flash-devoreuse.flash-devoreuse { animation: devoreuse-void 1.6s ease; position: relative; --anim-deco: devoreuse-void 1.6s ease; --flip-delay: 1.6s; }
        /* Croissance des Maudits : effet retardé (voir mauditBoostDelay côté JS), porté par un
           calque indépendant (.maudit-swell-fx) plutôt que par la carte elle-même, pour ne
           jamais entrer en conflit avec l'animation de capture (qui, elle, joue tout de suite). */
        .maudit-swell-fx {
          position: absolute; inset: -4px; pointer-events: none; z-index: 7; border-radius: 12px;
          animation: maudit-swell 1.6s ease; animation-delay: var(--maudit-delay, 0ms); animation-fill-mode: both;
        }
        /* ---------- Eveil (Dores) : le troc de rangs ----------
           L'ancienne version dilatait un simple cercle depuis le centre : joli, mais elle
           ne racontait pas l'echange et convenait a n'importe quelle capacite. Ici, sur
           CHAQUE cote qui troque, deux traits de lumiere glissent en sens inverse le long
           de la bordure partagee et se croisent, c'est le croisement qui dit "echange".
           Tout est en transform + opacity, les deux seules proprietes qui ne forcent pas
           le navigateur a redessiner : indispensable, jusqu'a 4 cotes peuvent s'animer en
           meme temps sur la carte posee.
           Duree totale 1,3 s : 0-0,3 s la bordure s'allume, 0,3-0,9 s les deux flux se
           croisent, 0,9-1,3 s l'impact et l'extinction. */
        .card.flash-eveil-self.flash-eveil-self,
        .card.flash-eveil.flash-eveil { position: relative; overflow: visible; }

        /* La bordure partagee : une bande fine posee sur le cote concerne, qui sert de
           rail aux deux flux et s'allume d'abord toute seule (phase 1). */
        .eveil-edge {
          position: absolute; pointer-events: none; z-index: 6; overflow: hidden;
          animation: eveil-bord 1.6s ease-out both;
        }
        .eveil-edge-top    { top: -2px; left: 6%; right: 6%; height: 4px; }
        .eveil-edge-bottom { bottom: -2px; left: 6%; right: 6%; height: 4px; }
        .eveil-edge-left   { left: -2px; top: 6%; bottom: 6%; width: 4px; }
        .eveil-edge-right  { right: -2px; top: 6%; bottom: 6%; width: 4px; }
        @keyframes eveil-bord {
          0%   { opacity: 0; box-shadow: none; }
          20%  { opacity: 1; box-shadow: 0 0 10px rgba(232,200,119,0.85), 0 0 20px rgba(255,250,240,0.5); }
          70%  { opacity: 1; box-shadow: 0 0 8px rgba(232,200,119,0.7); }
          100% { opacity: 0; box-shadow: none; }
        }

        /* Les deux flux. Ils parcourent le rail dans des sens opposes : celui qui part
           (or) et celui qui arrive (blanc chaud). Leur croisement au milieu du cote est
           le coeur de l'effet. */
        .eveil-flux {
          position: absolute; display: block; border-radius: 3px;
          animation-duration: 1.3s; animation-timing-function: cubic-bezier(.35,.02,.24,1);
          animation-fill-mode: both;
        }
        .eveil-flux-out { background: linear-gradient(90deg, rgba(232,200,119,0), #e8c877, rgba(232,200,119,0)); }
        .eveil-flux-in  { background: linear-gradient(90deg, rgba(255,250,240,0), #fffaf0, rgba(255,250,240,0)); }
        /* Cotes horizontaux : les flux glissent de gauche a droite et inversement. */
        .eveil-edge-top .eveil-flux, .eveil-edge-bottom .eveil-flux { top: 0; height: 100%; width: 46%; }
        .eveil-edge-top .eveil-flux-out, .eveil-edge-bottom .eveil-flux-out { left: 0; animation-name: eveil-glisse-droite; }
        .eveil-edge-top .eveil-flux-in,  .eveil-edge-bottom .eveil-flux-in  { right: 0; animation-name: eveil-glisse-gauche; }
        /* Cotes verticaux : meme principe, de haut en bas et inversement. */
        .eveil-edge-left .eveil-flux, .eveil-edge-right .eveil-flux { left: 0; width: 100%; height: 46%; }
        .eveil-edge-left .eveil-flux-out, .eveil-edge-right .eveil-flux-out { top: 0; animation-name: eveil-glisse-bas; }
        .eveil-edge-left .eveil-flux-in,  .eveil-edge-right .eveil-flux-in  { bottom: 0; animation-name: eveil-glisse-haut; }
        .eveil-edge-left .eveil-flux-out, .eveil-edge-right .eveil-flux-out,
        .eveil-edge-left .eveil-flux-in,  .eveil-edge-right .eveil-flux-in {
          background: linear-gradient(180deg, rgba(232,200,119,0), #e8c877, rgba(232,200,119,0));
        }
        .eveil-edge-left .eveil-flux-in, .eveil-edge-right .eveil-flux-in {
          background: linear-gradient(180deg, rgba(255,250,240,0), #fffaf0, rgba(255,250,240,0));
        }
        /* 0-23% : rien ne bouge, la bordure s'allume. 23-69% : la traversee. Puis sortie. */
        @keyframes eveil-glisse-droite {
          0%, 23% { transform: translateX(-110%); opacity: 0; }
          30%     { opacity: 1; }
          69%     { transform: translateX(130%); opacity: 1; }
          100%    { transform: translateX(130%); opacity: 0; }
        }
        @keyframes eveil-glisse-gauche {
          0%, 23% { transform: translateX(110%); opacity: 0; }
          30%     { opacity: 1; }
          69%     { transform: translateX(-130%); opacity: 1; }
          100%    { transform: translateX(-130%); opacity: 0; }
        }
        @keyframes eveil-glisse-bas {
          0%, 23% { transform: translateY(-110%); opacity: 0; }
          30%     { opacity: 1; }
          69%     { transform: translateY(130%); opacity: 1; }
          100%    { transform: translateY(130%); opacity: 0; }
        }
        @keyframes eveil-glisse-haut {
          0%, 23% { transform: translateY(110%); opacity: 0; }
          30%     { opacity: 1; }
          69%     { transform: translateY(-130%); opacity: 1; }
          100%    { transform: translateY(-130%); opacity: 0; }
        }

        /* La carte elle-meme : une breve respiration a l'instant de l'impact (0,9 s), pas
           avant, c'est le moment ou les valeurs ont fini de se croiser. */
        .card.flash-eveil-self.flash-eveil-self,
        .card.flash-eveil.flash-eveil { animation: eveil-impact 1.6s ease-out both; --anim-deco: eveil-impact 1.6s ease-out both; --flip-delay: 1.6s; }
        @keyframes eveil-impact {
          0%, 66%  { transform: scale(1); filter: brightness(1); }
          73%      { transform: scale(1.025); filter: brightness(1.35); }
          85%      { transform: scale(0.998); filter: brightness(1.1); }
          100%     { transform: scale(1); filter: brightness(1); }
        }

        /* Les rangs concernes s'illuminent. On n'utilise QUE filter, color et text-shadow :
           les pastilles se centrent sur les bords avec transform, y toucher les ferait
           sauter hors de la carte. */
        /* On n'anime QUE le halo (text-shadow / box-shadow) et la luminosite. Surtout pas
           la propriete color : la pastille est blanche (#fff) par defaut, et lui imposer
           une autre couleur de depart la faisait virer au sombre pendant toute l'animation.
           Ni transform : les pastilles s'en servent pour se centrer sur les bords, y
           toucher les enverrait hors de la carte. */
        .rank.rank-eveil { animation: eveil-rang 1.3s ease-out both; }
        @keyframes eveil-rang {
          0%   { text-shadow: none; box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 0 6px rgba(203,164,86,0.35), 0 2px 4px rgba(0,0,0,0.5); }
          18%  { text-shadow: 0 0 10px #e8c877, 0 0 18px #fffaf0;
                 box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 0 14px rgba(232,200,119,0.9), 0 2px 4px rgba(0,0,0,0.5); }
          66%  { text-shadow: 0 0 9px #e8c877, 0 0 15px rgba(255,250,240,0.8);
                 box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 0 12px rgba(232,200,119,0.8), 0 2px 4px rgba(0,0,0,0.5); }
          73%  { text-shadow: 0 0 16px #fffaf0, 0 0 28px #e8c877; filter: brightness(1.7);
                 box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 0 22px rgba(255,250,240,1), 0 2px 4px rgba(0,0,0,0.5); }
          100% { text-shadow: none; filter: brightness(1);
                 box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 0 6px rgba(203,164,86,0.35), 0 2px 4px rgba(0,0,0,0.5); }
        }
        .card.flash-attraction.flash-attraction { animation: ember-flicker 1.6s ease; position: relative; overflow: visible; --anim-deco: ember-flicker 1.6s ease; }
        .card.flash-attraction-pull.flash-attraction-pull { animation: pull-in 1.6s cubic-bezier(0.22, 1.05, 0.36, 1); opacity: 0.9; position: relative; overflow: visible; z-index: 6; --anim-deco: pull-in 1.6s cubic-bezier(0.22, 1.05, 0.36, 1); --flip-delay: 1.6s; }
        .card.flash-attraction-pull::before {
          content: ""; position: absolute; inset: -16px; border-radius: 16px; pointer-events: none; z-index: 4;
          background:
            radial-gradient(circle at 15% 85%, rgba(255,140,50,1) 0 4px, transparent 6px),
            radial-gradient(circle at 70% 20%, rgba(255,170,80,0.95) 0 4px, transparent 6px),
            radial-gradient(circle at 45% 65%, rgba(255,120,40,0.9) 0 3px, transparent 5px),
            radial-gradient(circle at 88% 75%, rgba(255,190,90,0.95) 0 4px, transparent 6px),
            radial-gradient(circle at 25% 20%, rgba(255,150,60,0.9) 0 3px, transparent 5px),
            radial-gradient(circle at 55% 92%, rgba(255,200,100,0.9) 0 3.5px, transparent 5.5px),
            radial-gradient(circle at 8% 45%, rgba(255,130,45,0.9) 0 3px, transparent 5px),
            radial-gradient(circle at 92% 40%, rgba(255,160,70,0.9) 0 3.5px, transparent 5.5px);
          animation: ember-particles 1.6s ease-out; opacity: 0;
        }
        @keyframes ember-particles {
          0%   { opacity: 0; transform: scale(1.9) rotate(0deg); filter: blur(1px); }
          20%  { opacity: 1; filter: blur(0); }
          65%  { opacity: 0.85; transform: scale(0.75) rotate(25deg); }
          100% { opacity: 0; transform: scale(0.25) rotate(45deg); }
        }
        .card.flash-guardian.flash-guardian { animation: guardian-shield 1.6s ease; position: relative; --anim-deco: guardian-shield 1.6s ease; }
        .card.flash-guardian-place.flash-guardian-place { animation: guardian-raise 1.6s ease; --anim-deco: guardian-raise 1.6s ease; }
        .card.flash-poison.flash-poison { animation: poison-hit 1.6s ease; position: relative; --anim-deco: poison-hit 1.6s ease; }

        /* Pseudo-éléments : la couche visuelle supplémentaire propre à chaque capacité */
        /* Le cercle qui se dilatait sur la carte touchee par les Archers a ete retire :
           il debordait largement de la carte et se lisait comme un halo parasite. La
           capacite reste racontee par portee-impact sur la carte elle-meme. */
        .maudit-swell-fx::after {
          content: ""; position: absolute; inset: 50%; width: 6px; height: 6px; margin: -3px; border-radius: 50%;
          pointer-events: none; border: 2px solid var(--red-bright);
          animation: devoreuse-ring 1.6s ease; animation-delay: var(--maudit-delay, 0ms); animation-fill-mode: both; z-index: 4;
        }
        .maudit-swell-fx::before {
          content: ""; position: absolute; top: 50%; left: -30%; width: 160%; height: 3px; pointer-events: none; z-index: 5;
          background: linear-gradient(90deg, transparent, #ff2a2a 42%, #fff 50%, #ff2a2a 58%, transparent);
          transform: translateY(-50%) rotate(-22deg) scaleX(0); opacity: 0;
          box-shadow: 0 0 10px #ff2a2a, 0 0 20px rgba(140,0,0,0.8);
          animation: maudit-bolt 1s cubic-bezier(0.2, 0.85, 0.3, 1); animation-delay: var(--maudit-delay, 0ms); animation-fill-mode: both;
        }
        .rank.rank-maudit-boost { animation: maudit-rank 1.4s ease; }
        @keyframes maudit-bolt {
          0% { opacity: 0; transform: translateY(-50%) rotate(-22deg) scaleX(0); transform-origin: left center; }
          20% { opacity: 1; transform: translateY(-50%) rotate(-22deg) scaleX(1.1); }
          55% { opacity: 0.85; transform: translateY(-50%) rotate(-22deg) scaleX(1); }
          100% { opacity: 0; transform: translateY(-50%) translateX(24%) rotate(-22deg) scaleX(0.7); transform-origin: right center; }
        }
        @keyframes maudit-rank {
          0% { scale: 1; }
          40% { scale: 1.25; color: #fff; text-shadow: 0 0 8px #ff2a2a, 0 0 15px rgba(180,0,0,0.9); }
          70% { scale: 0.96; }
          100% { scale: 1; }
        }
        .card.flash-guardian::after {
          content: ""; position: absolute; inset: 50%; width: 8px; height: 8px; margin: -4px; border-radius: 50%;
          pointer-events: none; border: 3px solid #9cc0e6;
          animation: guardian-ring 1.6s ease; z-index: 4;
        }
        /* Champ de force sur le bord attaqué : barre bleu-acier lumineuse qui encaisse le choc */
        .guardian-edge {
          position: absolute; pointer-events: none; z-index: 6; border-radius: 5px;
          background: linear-gradient(90deg, transparent, #cfe4f7, #9cc0e6, #cfe4f7, transparent);
          box-shadow: 0 0 10px #9cc0e6, 0 0 20px rgba(75,127,168,0.75); opacity: 0;
        }
        .guardian-edge.edge-from-left, .guardian-edge.edge-from-right {
          background: linear-gradient(0deg, transparent, #cfe4f7, #9cc0e6, #cfe4f7, transparent);
        }
        /* Résonance : onde de choc circulaire qui part du point de contact (le bord qui a matché) */
        .resonance-ring {
          position: absolute; pointer-events: none; z-index: 6; width: 10px; height: 10px; margin: -5px;
          border-radius: 50%; border: 3px solid #ffffff; opacity: 0;
          box-shadow: 0 0 10px #fff, 0 0 20px var(--gold-bright);
          animation: resonance-shockwave 1.8s ease-out;
        }
        .resonance-ring.ring-from-top { top: 0; left: 50%; }
        .resonance-ring.ring-from-bottom { top: 100%; left: 50%; }
        .resonance-ring.ring-from-left { top: 50%; left: 0; }
        .resonance-ring.ring-from-right { top: 50%; left: 100%; }
        @keyframes resonance-shockwave { 0% { opacity: 1; scale: 1; } 60% { opacity: 0.7; } 100% { opacity: 0; scale: 9; } }
        .edge-from-top { left: 8%; width: 84%; top: -3px; height: 5px; animation: shield-edge 1.2s ease; }
        .edge-from-bottom { left: 8%; width: 84%; bottom: -3px; height: 5px; animation: shield-edge 1.2s ease; }
        .edge-from-left { top: 8%; height: 84%; left: -3px; width: 5px; animation: shield-edge 1.2s ease; }
        .edge-from-right { top: 8%; height: 84%; right: -3px; width: 5px; animation: shield-edge 1.2s ease; }
        @keyframes shield-edge {
          0% { opacity: 0; filter: brightness(2.2); }
          22% { opacity: 1; }
          60% { opacity: 0.9; }
          100% { opacity: 0; }
        }
        .card.flash-poison::before {
          content: ""; position: absolute; inset: -6px; border-radius: 14px; pointer-events: none;
          background: radial-gradient(circle, rgba(94,201,120,0.65), rgba(94,201,120,0.3) 55%, transparent 75%);
          opacity: 0; animation: poison-cloud 1.6s ease; z-index: 4;
        }

        /* Flèche directionnelle des Archers : entre par le bord touché, file jusqu'au centre */
        .portee-arrow {
          position: absolute; z-index: 5; pointer-events: none;
          filter: drop-shadow(0 0 6px rgba(120,195,255,0.95)) drop-shadow(0 0 12px rgba(90,175,255,0.75)) drop-shadow(0 0 2px rgba(20,20,30,0.9));
        }
        .arrow-from-top { top: -30px; left: 50%; transform: translateX(-50%) rotate(90deg); animation: arrow-fall-top 1.45s cubic-bezier(0.55, 0, 0.95, 0.42) forwards; }
        .arrow-from-bottom { bottom: -30px; left: 50%; transform: translateX(-50%) rotate(-90deg); animation: arrow-fall-bottom 1.45s cubic-bezier(0.55, 0, 0.95, 0.42) forwards; }
        .arrow-from-left { left: -30px; top: 50%; transform: translateY(-50%) rotate(0deg); animation: arrow-fall-left 1.45s cubic-bezier(0.55, 0, 0.95, 0.42) forwards; }
        .arrow-from-right { right: -30px; top: 50%; transform: translateY(-50%) rotate(180deg); animation: arrow-fall-right 1.45s cubic-bezier(0.55, 0, 0.95, 0.42) forwards; }
        @keyframes arrow-fall-top { 0%{top:-30px; opacity:0} 12%{opacity:1} 94%{opacity:1} 100%{top:42%; opacity:0} }
        @keyframes arrow-fall-bottom { 0%{bottom:-30px; opacity:0} 12%{opacity:1} 94%{opacity:1} 100%{bottom:42%; opacity:0} }
        @keyframes arrow-fall-left { 0%{left:-30px; opacity:0} 12%{opacity:1} 94%{opacity:1} 100%{left:42%; opacity:0} }
        @keyframes arrow-fall-right { 0%{right:-30px; opacity:0} 12%{opacity:1} 94%{opacity:1} 100%{right:42%; opacity:0} }

        /* Petite étoile discrète en coin, sur une carte dont le Héraut est actif */
        .hero-active-badge {
          position: absolute; top: 4px; left: 4px; z-index: 6; pointer-events: none;
          font-size: 12px; color: var(--gold-bright); text-shadow: 0 0 4px rgba(240,207,130,0.9), 0 1px 2px rgba(0,0,0,0.6);
        }

        /* Badge flottant +N / -N (vert = bonus, rouge = malus) */
        .delta-badge {
          position: absolute; top: -12px; right: -8px; z-index: 6; pointer-events: none;
          font-family: 'Cinzel', serif; font-weight: 700; font-size: 13px; padding: 2px 7px; border-radius: 999px;
          animation: delta-pop 1.3s ease both;
        }
        .delta-badge.delta-pos { background: rgba(20,17,28,0.9); border: 1px solid var(--bonus); color: var(--bonus); box-shadow: 0 0 10px rgba(95,207,110,0.6); }
        .delta-badge.delta-neg { background: rgba(20,17,28,0.9); border: 1px solid var(--malus); color: var(--malus); box-shadow: 0 0 10px rgba(225,91,82,0.6); }
        @keyframes delta-pop {
          0% { opacity: 0; transform: translateY(4px) scale(0.7); }
          20% { opacity: 1; transform: translateY(-6px) scale(1.15); }
          35% { transform: translateY(-6px) scale(1); }
          80% { opacity: 1; }
          100% { opacity: 0; transform: translateY(-16px) scale(0.9); }
        }

        @keyframes flip-gold {
          0%   { transform: rotateY(0); background: var(--flip-ancien-bg, inherit); border-color: var(--flip-ancien-bord, currentColor); box-shadow: var(--flip-ancien-ombre, none); }
          38%  { background: var(--flip-ancien-bg, inherit); border-color: var(--flip-ancien-bord, currentColor); }
          40%  { transform: rotateY(90deg) scale(1.14); box-shadow: 0 0 34px var(--gold-bright), 0 0 60px rgba(232,200,119,0.5); filter: brightness(1.6); background: var(--flip-nouveau-bg, inherit); border-color: var(--flip-nouveau-bord, currentColor); }
          70%  { transform: rotateY(270deg) scale(1.06); filter: brightness(1.2); }
          88%  { transform: rotateY(368deg) scale(1.02); }
          100% { transform: rotateY(360deg) scale(1); filter: brightness(1); }
        }
        /* Résonance : petit séisme de 2px sur la carte avant qu'elle ne bascule (contact du
           rang égal, puis la carte change de camp) */
        @keyframes flip-resonance {
          0%   { transform: translate(0, 0) rotateY(0); background: var(--flip-ancien-bg, inherit); border-color: var(--flip-ancien-bord, currentColor); box-shadow: var(--flip-ancien-ombre, none); }
          4%   { transform: translate(-2px, 0) rotateY(0); }
          8%   { transform: translate(2px, 0) rotateY(0); }
          12%  { transform: translate(-2px, 0) rotateY(0); }
          16%  { transform: translate(0, 0) rotateY(0); }
          48%  { background: var(--flip-ancien-bg, inherit); border-color: var(--flip-ancien-bord, currentColor); }
          50%  { transform: translate(0, 0) rotateY(90deg) scale(1.14); box-shadow: 0 0 34px #fff, 0 0 60px var(--gold-bright); filter: brightness(1.7); background: var(--flip-nouveau-bg, inherit); border-color: var(--flip-nouveau-bord, currentColor); }
          76%  { transform: translate(0, 0) rotateY(270deg) scale(1.06); filter: brightness(1.2); }
          90%  { transform: translate(0, 0) rotateY(368deg) scale(1.02); }
          100% { transform: translate(0, 0) rotateY(360deg) scale(1); filter: brightness(1); }
        }
        @keyframes flip-combo {
          0%   { transform: translate(0, 0) rotateY(0); background: var(--flip-ancien-bg, inherit); border-color: var(--flip-ancien-bord, currentColor); box-shadow: var(--flip-ancien-ombre, none); }
          20%  { transform: translate(var(--knock-x, 0px), var(--knock-y, 0px)) rotateY(0); }
          48%  { background: var(--flip-ancien-bg, inherit); border-color: var(--flip-ancien-bord, currentColor); }
          50%  { transform: translate(0, 0) rotateY(90deg) scale(1.14); box-shadow: 0 0 34px var(--combo), 0 0 60px rgba(138,99,201,0.5); filter: brightness(1.6); background: var(--flip-nouveau-bg, inherit); border-color: var(--flip-nouveau-bord, currentColor); }
          76%  { transform: translate(0, 0) rotateY(270deg) scale(1.06); filter: brightness(1.2); }
          90%  { transform: translate(0, 0) rotateY(368deg) scale(1.02); }
          100% { transform: translate(0, 0) rotateY(360deg) scale(1); filter: brightness(1); }
        }
        /* Recul de 5px dans le sens du choc, avant le basculement, la direction dépend
           du côté qui vient d'être touché (voir comboVictimEvent.dir côté JS). */
        .card.combo-hit-from-top { --knock-x: 0px; --knock-y: 5px; }
        .card.combo-hit-from-bottom { --knock-x: 0px; --knock-y: -5px; }
        .card.combo-hit-from-left { --knock-x: 5px; --knock-y: 0px; }
        .card.combo-hit-from-right { --knock-x: -5px; --knock-y: 0px; }
        /* Onde : la carte émettrice (qui vient de capturer et transmet le choc) clignote
           avec un drop-shadow néon violet, sans se retourner (elle a déjà basculé avant). */
        .card.flash-combo-emit.flash-combo-emit { animation: combo-emit-glow 1.6s ease; --anim-deco: combo-emit-glow 1.6s ease; }
        @keyframes combo-emit-glow {
          0%, 100% { filter: drop-shadow(0 0 0 transparent); }
          40% { filter: drop-shadow(0 0 10px var(--combo)) drop-shadow(0 0 20px var(--combo)) brightness(1.5); }
        }
        /* Impulsion projetée vers la carte suivante de la chaîne */
        .combo-impulse {
          position: absolute; pointer-events: none; z-index: 6; background: var(--combo);
          box-shadow: 0 0 8px var(--combo), 0 0 14px var(--combo); opacity: 0; border-radius: 3px;
          animation: combo-impulse-shoot 1.1s ease-out;
        }
        .combo-impulse.impulse-from-top { left: 46%; width: 8%; top: -14px; height: 14px; }
        .combo-impulse.impulse-from-bottom { left: 46%; width: 8%; bottom: -14px; height: 14px; }
        .combo-impulse.impulse-from-left { top: 46%; height: 8%; left: -14px; width: 14px; }
        .combo-impulse.impulse-from-right { top: 46%; height: 8%; right: -14px; width: 14px; }
        @keyframes combo-impulse-shoot { 0% { opacity: 1; scale: 0.3; } 70% { opacity: 1; } 100% { opacity: 0; scale: 1.6; } }
        /* Chimères : la carte se retourne en 3D sur l'axe attaqué, avec un flou de
           mouvement, puis se remet en place (aller-retour complet). */
        @keyframes mue-flip-h {
          0%,100% { transform: rotateY(0deg); filter: blur(0); box-shadow: none; }
          25% { filter: blur(2px); box-shadow: 0 0 22px var(--mue); }
          50% { transform: rotateY(180deg); filter: blur(2px); box-shadow: 0 0 26px var(--mue); }
          75% { filter: blur(2px); box-shadow: 0 0 22px var(--mue); }
        }
        @keyframes mue-flip-v {
          0%,100% { transform: rotateX(0deg); filter: blur(0); box-shadow: none; }
          25% { filter: blur(2px); box-shadow: 0 0 22px var(--mue); }
          50% { transform: rotateX(180deg); filter: blur(2px); box-shadow: 0 0 26px var(--mue); }
          75% { filter: blur(2px); box-shadow: 0 0 22px var(--mue); }
        }
        /* Chimères qui active Mue : un simple pouls cyan, pas de transformation, seule la cible se retourne */
        @keyframes mue-self-pulse { 0%,100%{box-shadow:none} 45%{box-shadow:0 0 18px var(--mue)} }

        /* Dorés, balayage de lumière dorée */

        /* Piques : la victime se fait trancher, l'attaquante donne le coup (deux animations bien distinctes) */
        @keyframes percee-slash {
          0%   { transform: translateX(0); filter: brightness(1); }
          18%  { transform: translateX(-6px) rotate(-1.2deg); filter: brightness(2); }
          34%  { transform: translateX(5px) rotate(0.8deg); filter: brightness(1.5); }
          52%  { transform: translateX(-3px); filter: brightness(1.2); }
          70%  { transform: translateX(2px); filter: brightness(1.05); }
          100% { transform: translateX(0); filter: brightness(1); }
        }
        @keyframes percee-thrust { 0%,100%{transform:scale(1)} 25%{transform:scale(1.12,0.94); box-shadow:0 0 20px var(--percee)} 50%{transform:scale(0.96,1.08)} 70%{transform:scale(1.05,0.98); box-shadow:0 0 16px var(--percee)} }
        /* Piques : rangée de pointes qui jaillit du bord touché de la carte transpercée,
           du côté d'où vient l'attaque, puis se rétracte. */
        .percee-spikes {
          position: absolute; pointer-events: none; z-index: 6;
          background: linear-gradient(#ffffff, var(--percee));
          filter: drop-shadow(0 0 5px #fff) drop-shadow(0 0 9px var(--percee));
        }
        .percee-spikes.spikes-from-top {
          left: -2%; right: -2%; width: 104%; top: -15px; height: 16px;
          transform-origin: bottom center; transform: scaleY(0); opacity: 0;
          clip-path: polygon(0% 100%, 7% 0%, 14% 100%, 21% 0%, 28% 100%, 36% 0%, 43% 100%, 50% 0%, 57% 100%, 64% 0%, 72% 100%, 79% 0%, 86% 100%, 93% 0%, 100% 100%);
          animation: spikes-pop-y 1s cubic-bezier(0.2, 0.9, 0.3, 1);
        }
        .percee-spikes.spikes-from-bottom {
          left: -2%; right: -2%; width: 104%; top: 100%; height: 16px;
          transform-origin: top center; transform: scaleY(0); opacity: 0;
          clip-path: polygon(0% 0%, 7% 100%, 14% 0%, 21% 100%, 28% 0%, 36% 100%, 43% 0%, 50% 100%, 57% 0%, 64% 100%, 72% 0%, 79% 100%, 86% 0%, 93% 100%, 100% 0%);
          animation: spikes-pop-y 1s cubic-bezier(0.2, 0.9, 0.3, 1);
        }
        @keyframes spikes-pop-y {
          0%   { transform: scaleY(0); opacity: 0; }
          22%  { transform: scaleY(1.2); opacity: 1; }
          42%  { transform: scaleY(0.92); opacity: 1; }
          70%  { transform: scaleY(1); opacity: 0.85; }
          100% { transform: scaleY(0); opacity: 0; }
        }

        /* Archers, impact en anneau, façon flèche qui frappe */
        @keyframes portee-impact { 0%{transform:scale(0.4); opacity:0.4; filter:brightness(1)} 50%{transform:scale(1.18); opacity:1; filter:brightness(2.1)} 70%{filter:brightness(1.3)} 100%{transform:scale(1); filter:brightness(1)} }

        /* Abysses, plus ample : la carte s'affaisse puis rebondit fort, ondes violettes plus larges */
        @keyframes devoreuse-void { 0%,100%{transform:scale(1); filter:drop-shadow(0 0 0 var(--devour))} 40%{transform:scale(0.8); box-shadow:0 0 34px var(--devour); filter:drop-shadow(0 0 14px var(--devour))} 70%{transform:scale(1.28); filter:drop-shadow(0 0 10px var(--devour))} 88%{transform:scale(0.96)} }
        .card.flash-devoreuse .rank { animation: devour-rank 1.6s ease; }
        /* Abysses : tentacules d'ombre qui jaillissent de la carte puis se rétractent */
        .abysse-tentacles {
          position: absolute; inset: -22%; width: 144%; height: 144%; pointer-events: none; z-index: 4;
          overflow: visible; transform-origin: center; opacity: 0;
          filter: drop-shadow(0 0 6px var(--devour)) blur(0.4px);
          animation: tentacle-writhe 1.7s cubic-bezier(0.3, 0.8, 0.4, 1);
        }
        .abysse-tentacles path { fill: var(--devour); opacity: 0.66; }
        @keyframes tentacle-writhe {
          0%   { opacity: 0; transform: scale(0.2) rotate(-10deg); }
          28%  { opacity: 0.95; transform: scale(1.12) rotate(5deg); }
          52%  { opacity: 0.85; transform: scale(0.92) rotate(-4deg); }
          74%  { opacity: 0.7; transform: scale(1.06) rotate(3deg); }
          100% { opacity: 0; transform: scale(1.25) rotate(-2deg); }
        }
        @keyframes devour-rank { 0%{scale:1} 35%{scale:1.28; color:#fff; text-shadow:0 0 9px var(--devour), 0 0 16px var(--devour)} 60%{scale:0.94} 100%{scale:1} }
        @keyframes maudit-swell { 0%,100%{transform:scale(1)} 40%{transform:scale(0.85); box-shadow:0 0 34px var(--red-bright)} 70%{transform:scale(1.22)} 88%{transform:scale(0.97)} }
        @keyframes devoreuse-ring { 0%{opacity:1; transform:scale(1)} 100%{opacity:0; transform:scale(13)} }

        /* Cendres, braises qui crépitent, flash à chaque pose */
        @keyframes ember-flicker {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          20% { transform: scale(1.05) rotate(-0.4deg); filter: brightness(1.22) saturate(1.2); box-shadow: 0 0 18px var(--attract), 0 0 36px rgba(217,143,60,0.3); }
          40% { transform: scale(1.02) rotate(0.3deg); filter: brightness(1.1); }
          60% { transform: scale(1.06) rotate(-0.3deg); filter: brightness(1.26) saturate(1.22); box-shadow: 0 0 20px var(--attract), 0 0 40px rgba(217,143,60,0.32); }
          80% { transform: scale(1.01); filter: brightness(1.06); }
        }
        /* La carte part de sa case d'origine (--pull-dx / --pull-dy, posés en JS d'après la
           direction et le nombre de cases franchies), résiste un instant, puis est happée.
           Le trajet occupe les 55 premiers pourcents : on VOIT la carte traverser le plateau
           avant le rebond d'arrivée. */
        @keyframes pull-in {
          0%   { transform: translate(var(--pull-dx, 0%), var(--pull-dy, 0%)) scale(0.9); opacity: 0.35; filter: blur(2px) saturate(1.35); }
          12%  { transform: translate(calc(var(--pull-dx, 0%) * 1.06), calc(var(--pull-dy, 0%) * 1.06)) scale(0.88); opacity: 0.75; filter: blur(1.5px) saturate(1.35); }
          55%  { transform: translate(0%, 0%) scale(1.14); opacity: 1; filter: blur(0) saturate(1.25); box-shadow: 0 0 24px var(--attract), 0 0 44px rgba(217,143,60,0.4); }
          70%  { transform: scale(0.96); box-shadow: 0 0 14px var(--attract); }
          84%  { transform: scale(1.05); box-shadow: 0 0 18px var(--attract), 0 0 32px rgba(217,143,60,0.28); }
          100% { transform: scale(1); }
        }

        /* Gardiens, flash de pose (bouclier qui se lève) + onde de choc en défense */
        @keyframes guardian-raise { 0%,100%{transform:scale(1); box-shadow:none} 40%{transform:scale(1.05); box-shadow:0 0 18px rgba(203,164,86,0.5)} }
        @keyframes guardian-shield { 0%,100%{transform:translate(0,0) scale(1)} 18%{transform:translate(0,1px) scale(0.98); box-shadow:0 0 0 3px rgba(140,185,220,0.55), 0 0 24px rgba(75,127,168,0.65)} 42%{transform:translate(0,0) scale(1.03); box-shadow:0 0 0 6px rgba(140,185,220,0.18), 0 0 14px rgba(75,127,168,0.35)} 65%{transform:scale(1)} }
        @keyframes guardian-ring { 0%{opacity:1; transform:scale(1)} 100%{opacity:0; transform:scale(10)} }

        /* Pestiférés, nuage toxique bien visible, la carte vire au vert */
        @keyframes poison-hit { 0%,100%{filter:brightness(1) saturate(1)} 40%{filter:brightness(0.65) saturate(2) hue-rotate(60deg); box-shadow:0 0 26px var(--poison)} }
        @keyframes poison-cloud { 0%{opacity:0; transform:scale(0.7)} 35%{opacity:1; transform:scale(1.15)} 70%{opacity:0.7} 100%{opacity:0; transform:scale(1.35)} }

        .rank { position: absolute; width: 20px; height: 20px; border-radius: 50%; background: #0c0a12;
          border: 2px solid var(--gold-bright); color: #fff; font-size: 11px; font-weight: 700;
          display: flex; align-items: center; justify-content: center; z-index: 3;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.7), 0 0 6px rgba(203,164,86,0.35), 0 2px 4px rgba(0,0,0,0.5); }
        /* Scribes : les "?" masqués scintillent d'une lueur bleutée mystique */
        .card-concealed .rank { animation: scribe-shimmer 1.9s ease-in-out infinite; }
        @keyframes scribe-shimmer {
          0%,100% { color: #cbe1ff; text-shadow: 0 0 4px rgba(120,170,230,0.6); }
          50% { color: #ffffff; text-shadow: 0 0 10px rgba(150,200,255,0.95), 0 0 17px rgba(100,150,220,0.7); }
        }
        /* Révélation : le "?" se dissout en encre (fondu + flou + dispersion) et laisse
           voir le vrai rang en dessous. Le "?" est peint par-dessus le chiffre via un
           pseudo-élément opaque, qui s'efface. */
        .card.flash-scribe-reveal .rank::before {
          content: "?"; position: absolute; inset: 0; border-radius: 50%; z-index: 2;
          display: flex; align-items: center; justify-content: center;
          background: #0c0a12; color: #cbe1ff; pointer-events: none;
          animation: scribe-ink-dissolve 1.6s ease forwards;
        }
        @keyframes scribe-ink-dissolve {
          0%   { opacity: 1; filter: blur(0); transform: scale(1); }
          55%  { opacity: 0.55; filter: blur(2px); transform: scale(1.25) rotate(-6deg); }
          100% { opacity: 0; filter: blur(6px); transform: scale(1.6) rotate(-12deg); }
        }
        /* Rang modifié par une capacité (+1 Gardien), chiffre en vert */
        /* Vos propres Scribes : vous voyez vos rangs normalement, mais ce badge rappelle
           qu'ils sont masqués POUR L'ADVERSAIRE, et pour combien de tours encore. */
        /* Compteur de dissimulation des Scribes. Empilé verticalement (œil au-dessus du
           chiffre) plutôt qu'en ligne : à l'horizontale il faisait 30 px de large et
           mordait sur le rang du haut, qui est centré et occupe la zone 23-43 px.
           En colonne il ne fait plus que 16 px et reste dans le coin, dégagé. */
        .scribe-hidden-badge {
          position: absolute; top: 3px; left: 3px; z-index: 6;
          display: flex; flex-direction: column; align-items: center; gap: 0;
          padding: 2px 3px; border-radius: 6px;
          background: rgba(20,17,28,0.86); border: 1px solid rgba(197,167,90,0.75);
          color: #d9c48a; font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700; line-height: 1;
          pointer-events: none;
        }
        .scribe-hidden-badge svg { display: block; margin-bottom: 1px; }
        /* Les rangs renforcés des Gardiens s'affichent désormais comme les autres :
           la valeur affichée tient déjà compte du +1, la couleur ne l'annonce plus. */
        /* Rang renforcé par le bouclier d'un Gardien, montré à l'aperçu sur le SEUL côté
           concerné par le combat. Le chiffre affiché est déjà la valeur augmentée : la pastille
           passe donc au bleu bouclier pour que le joueur voie que ce n'est pas le rang brut.
           PIÈGE : ne jamais toucher la propriété transform ici, les quatre positions
           (.rank.top, .rank.left...) s'en servent pour se centrer, et l'écraser ferait
           sauter le rang hors de la carte. */
        .rank.rank-boosted {
          color: #d6ecfb; border-color: #8cc4e8; background: #0a1420;
          box-shadow: 0 0 8px rgba(140,185,220,0.85), 0 0 16px rgba(75,127,168,0.55);
          text-shadow: 0 0 6px rgba(140,185,220,0.95), 0 1px 2px rgba(0,0,0,0.8);
          animation: rank-boost-in 0.5s ease-out;
        }
        @keyframes rank-boost-in {
          0%   { box-shadow: 0 0 0 rgba(140,185,220,0); filter: brightness(1); }
          40%  { box-shadow: 0 0 14px rgba(140,185,220,1), 0 0 28px rgba(75,127,168,0.8); filter: brightness(1.7); }
          100% { box-shadow: 0 0 8px rgba(140,185,220,0.85), 0 0 16px rgba(75,127,168,0.55); filter: brightness(1); }
        }
        /* Rang affaibli par le poison (-1), chiffre en rouge, distinct du bonus vert */
        .rank.rank-poisoned { color: var(--malus); text-shadow: 0 0 6px rgba(225,91,82,0.95), 0 0 11px rgba(225,91,82,0.6); }
        /* Résonance : les 2 rangs égaux qui se sont touchés clignotent en blanc avec un léger zoom */
        .rank.rank-resonance { animation: resonance-rank-flash 2s ease; }
        /* Aperçu (pendant le survol/glisser, avant de relâcher) : reste visible tant qu'on
           survole, contrairement au clignotement ponctuel joué à la vraie capture. */
        .rank.rank-resonance-preview { color: #ffffff; text-shadow: 0 0 6px #fff, 0 0 14px var(--gold-bright); animation: resonance-preview-pulse 1.1s ease infinite; }
        @keyframes resonance-preview-pulse { 0%, 100% { scale: 1; opacity: 0.85; } 50% { scale: 1.15; opacity: 1; } }
        @keyframes resonance-rank-flash {
          0%, 100% { color: inherit; text-shadow: none; scale: 1; }
          15%, 45% { color: #ffffff; text-shadow: 0 0 8px #fff, 0 0 16px #fff, 0 0 24px var(--gold-bright); scale: 1.2; }
          70% { color: #ffffff; text-shadow: 0 0 6px #fff; scale: 1.05; }
        }
        .rank.top { top: 2px; left: 50%; transform: translateX(-50%); }
        .rank.bottom { bottom: 2px; left: 50%; transform: translateX(-50%); }
        .rank.left { left: 2px; top: 50%; transform: translateY(-50%); }
        .rank.right { right: 2px; top: 50%; transform: translateY(-50%); }

        .hand-row { position: relative; display: flex; gap: 7px; padding: 10px 12px; border-radius: 14px; background: var(--panel);
          border: 1.5px solid rgba(203,164,86,0.3); box-shadow: 0 4px 16px rgba(0,0,0,0.35), inset 0 0 22px rgba(203,164,86,0.05);
          transition: border-color .25s, box-shadow .25s; flex-wrap: wrap;
          /* Le panneau epouse son contenu au lieu d'occuper d'office 320px : avec les
             vignettes d'Ordre, deux pastilles flottaient dans un grand cadre vide (releve
             par Alexandre). max-width garde le retour a la ligne des mains nombreuses
             (Confluence, bac a sable) ; margin auto centre le panneau Ecarlate, dont le
             parent est un simple bloc (Azur, lui, est deja centre par son parent flex). */
          width: fit-content; margin-left: auto; margin-right: auto;
          max-width: 320px; justify-content: center; }
        /* A QUI C'EST LE TOUR : dit par la couleur, pas par du texte.
           Depuis le retrait de la ligne "Au tour du camp Azur", le seul indice etait un
           cadre dore identique pour les deux camps : rien ne distinguait mon tour du sien.
           Le panneau actif prend maintenant la couleur de SON camp et respire lentement.
           L'or ne signale plus le tour, il redevient une simple bordure de panneau. */
        .hand-row.active { border-color: var(--gold-bright); box-shadow: 0 0 20px rgba(203,164,86,0.25), inset 0 0 22px rgba(203,164,86,0.08); }
        /* Meme traitement : ombre fixe, seule l'opacite du calque pulse. */
        .hand-row.active.camp-blue { border-color: var(--blue-bright);
          box-shadow: 0 0 16px rgba(111,164,230,0.26), inset 0 0 24px rgba(111,164,230,0.08); }
        .hand-row.active.camp-red { border-color: var(--red-bright);
          box-shadow: 0 0 16px rgba(224,101,90,0.26), inset 0 0 24px rgba(224,101,90,0.08); }
        .hand-row.active.camp-blue::after, .hand-row.active.camp-red::after {
          content: ""; position: absolute; inset: -1.5px; border-radius: inherit; pointer-events: none;
          opacity: 0; will-change: opacity;
          animation: halo-respire 2.8s ease-in-out infinite;
        }
        .hand-row.active.camp-blue::after { box-shadow: 0 0 30px rgba(111,164,230,0.5), inset 0 0 26px rgba(111,164,230,0.14); }
        .hand-row.active.camp-red::after { box-shadow: 0 0 30px rgba(224,101,90,0.5), inset 0 0 26px rgba(224,101,90,0.14); }
        /* Le nom du camp qui ne joue pas s'efface : le contraste entre les deux se lit
           plus vite qu'une lueur seule. */
        .turn-label { transition: opacity .3s, filter .3s; }
        .turn-label.en-attente { opacity: 0.38; filter: saturate(0.5); }
        .hand-row.disabled .card { opacity: 0.6; cursor: not-allowed; }
        .hand-row.compact { gap: 7px; padding: 10px 12px; max-width: 320px; }
        .hand-row.compact .card.hand { width: 66px; height: 88px; }
        .hand-row.compact .card.hand .icon { font-size: 20px; }
        .hand-row.compact .card.hand .rank { width: 19px; height: 19px; font-size: 10.5px; }

        /* ---------- Main en éventail ---------- */
        /* Vignette d'Ordre : représente à elle seule les cartes restantes d'un Ordre dans
           la main (dès qu'il en reste plus d'une, une seule carte s'affiche directement,
           voir renderHandGroups). Volontairement minimaliste : juste le portrait, rien
           d'autre, pas de compteur, pas d'effet de pile de cartes empilées. */
        .order-tile-wrap { position: relative; }
        .order-tile {
          width: min(13vw, 7.4dvh); height: min(13vw, 7.4dvh); min-width: 44px; min-height: 44px;
          border-radius: 50%; padding: 0; overflow: hidden; cursor: pointer; position: relative;
          background: var(--panel); border: 1.5px solid rgba(203,164,86,0.35);
          box-shadow: 0 4px 10px rgba(0,0,0,0.4);
          transition: border-color .2s, transform .2s, box-shadow .2s;
          /* Doit rester au-dessus de .fan-backdrop (z-index 65, plein écran) : sinon, dès
             qu'UN éventail est ouvert quelque part, son fond invisible intercepte le tap
             destiné à N'IMPORTE QUELLE vignette (y compris elle-même) avant qu'il
             n'atteigne le bouton, plus moyen de refermer avec l'animation ni de basculer
             vers un autre Ordre. Repéré en testant le scénario "bascule entre vignettes". */
          z-index: 66;
        }
        .order-tile:hover { border-color: var(--gold); transform: translateY(-2px); }
        /* Main a beaucoup d'Ordres (Confluence, bac a sable) : jusqu'a 11 vignettes par
           camp. A leur taille normale elles debordaient sur plusieurs rangees et mangeaient
           la hauteur du plateau, on les resserre donc. Le minimum de 34 px reste au-dessus
           de ce qu'un doigt peut viser sans se tromper de medaillon. */
        .hand-row.compact .order-tile {
          width: min(9vw, 5.2dvh); height: min(9vw, 5.2dvh); min-width: 34px; min-height: 34px;
        }
        .hand-row.compact { gap: 4px; padding: 7px 8px; max-width: 340px; }
        .order-tile:active { transform: translateY(0) scale(0.94); }
        .order-tile-portrait { width: 100%; height: 100%; object-fit: cover; display: block; }
        /* Compteur de cartes restantes, meme famille visuelle que la pastille du Heraut
           en haut du medaillon. Pose en BAS pour ne jamais la recouvrir. */
        .order-tile-compte {
          position: absolute; bottom: -1px; left: 50%; transform: translateX(-50%);
          min-width: 17px; padding: 0 4px; border-radius: 999px;
          font-family: 'Cinzel', serif; font-size: 10px; line-height: 15px; font-weight: 700;
          color: var(--bone); background: rgba(8,6,12,0.9);
          border: 1px solid rgba(203,164,86,0.55);
          box-shadow: 0 1px 4px rgba(0,0,0,0.6); pointer-events: none;
        }
        .order-tile-icon { font-size: 20px; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
        /* Éventail ouvert pour cette vignette : même halo doré que .hand-row.active,
           à l'échelle d'une seule vignette. */
        .order-tile-wrap.fan-open .order-tile { border-color: var(--gold-bright); box-shadow: 0 0 0 2px var(--gold-bright), 0 0 14px rgba(203,164,86,0.4); }
        /* Une carte de ce groupe est sélectionnée (clic) ou suggérée (Augure), mais
           l'éventail lui-même est refermé : le halo rappelle qu'il reste une action en
           attente dans cette vignette-là. */
        .order-tile.tile-pending { border-color: var(--gold-bright); box-shadow: 0 0 0 2px var(--gold-bright), 0 0 14px rgba(203,164,86,0.5); animation: hint-pulse 1.4s ease-in-out infinite; }
        .order-tile-hero { position: absolute; top: -2px; right: -2px; font-size: 11px; line-height: 1; color: var(--gold-bright); text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.6); pointer-events: none; }

        /* Éventail déployé : une SUPERPOSITION, jamais dans le flux, ne pousse aucun
           autre élément et se pose PAR-DESSUS le plateau (z-index élevé) plutôt que de
           le repousser. Le fond .fan-backdrop capte un tap "à côté" pour refermer, mais
           reste totalement transparent : rien ne doit jamais visuellement masquer le
           plateau, y compris le temps que l'éventail est ouvert. */
        .fan-backdrop { position: fixed; inset: 0; z-index: 65; background: transparent; }
        .card-fan { position: absolute; left: 50%; width: 0; z-index: 70; pointer-events: none; }
        .card-fan.fan-haut { bottom: 100%; margin-bottom: 10px; }
        .card-fan.fan-bas { top: 100%; margin-top: 10px; }
        .fan-slot {
          position: absolute; left: 50%; pointer-events: auto;
          transform: translateX(calc(-50% + var(--fan-x))) translateY(var(--fan-y)) rotate(var(--fan-rot));
          animation: fan-deploy 0.3s cubic-bezier(.34,1.4,.5,1) backwards;
          animation-delay: var(--fan-delay, 0ms);
        }
        .card-fan.fan-haut .fan-slot { bottom: 0; transform-origin: 50% 100%; }
        .card-fan.fan-bas .fan-slot { top: 0; transform-origin: 50% 0%; }
        /* Repli : fanClosing garde le groupe monté le temps de l'animation (voir
           toggleFan/fanCloseTimerRef), même mécanique que justPoisoned plus haut pour
           la bouffée de brume empoisonnée, appliquée cette fois à l'éventail. */
        .card-fan.fan-closing .fan-slot { animation: fan-retract 0.24s ease-in forwards; }
        @keyframes fan-deploy {
          from { transform: translateX(-50%) translateY(0) rotate(0deg) scale(0.55); opacity: 0; }
        }
        @keyframes fan-retract {
          to { transform: translateX(-50%) translateY(0) rotate(0deg) scale(0.55); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .fan-slot { animation-duration: 0.01s; }
          .card-fan.fan-closing .fan-slot { animation-duration: 0.01s; }
        }
        /* Cartes dans l'éventail : plus grandes que la taille "compact" (66×88) puisque
           les vignettes ont justement libéré la place pour les lire confortablement, le
           sélecteur à 3 classes l'emporte sur .hand-row.compact .card.hand (2 classes). */
        .card.hand.in-fan { width: clamp(64px, 19vw, 84px); height: clamp(86px, 26vw, 114px); }

        .card.hand { cursor: pointer; width: clamp(58px, 17vw, 72px); height: clamp(78px, 23vw, 96px); transform: none; overflow: visible; }
        .card.hand .icon { font-size: 22px; }
        .card.hand .rank { width: 21px; height: 21px; font-size: 11.5px; border-width: 2px; }
        .card.hand.selected { outline: 2px solid var(--gold-bright); outline-offset: 2px; transform: translateY(-5px); }

        .turn-label { font-family: 'Cinzel', serif; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--muted); margin-bottom: 4px; text-align: center; }
        .turn-label.blue-t { color: var(--blue-bright); }
        .turn-label.red-t { color: var(--red-bright); }

        .status-line { font-family: 'Cinzel', serif; font-size: 12.5px; letter-spacing: 0.06em; color: var(--muted); min-height: 18px; text-align: center; }

        .timer-bar-wrap {
          position: relative; width: 100%; max-width: 180px; height: 10px; border-radius: 999px;
          background: rgba(255,255,255,0.07); border: 1px solid rgba(203,164,86,0.25); overflow: hidden;
        }
        .timer-bar-fill {
          height: 100%; border-radius: 999px; transition: width 1s linear, background-color .4s ease;
        }
        .timer-bar-fill.green { background: #3d6b47; }
        .timer-bar-fill.orange { background: #8a6428; }
        .timer-bar-fill.red { background: #7a332f; animation: pulse-timer 0.8s ease infinite; }
        @keyframes pulse-timer { 0%,100%{opacity:1} 50%{opacity:0.55} }

        .reset-btn { font-family: 'Cinzel', serif; letter-spacing: 0.1em; font-size: 12px; text-transform: uppercase;
          color: var(--bg); background: linear-gradient(180deg, var(--gold-bright), var(--gold)); border: none;
          padding: 10px 20px; border-radius: 999px; cursor: pointer; box-shadow: 0 6px 16px rgba(203,164,86,0.25); }
        .reset-btn:hover { filter: brightness(1.06); }
        .reset-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .action-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
        .undo-btn { background: linear-gradient(180deg, #3a3450, #2a2438); color: var(--bone); box-shadow: 0 6px 16px rgba(0,0,0,0.25); }
        /* Quitter, pendant la partie : un simple lien fantome. C'est le meme bouton qui
           devient "Nouvelle partie" a la fin ; l'or est reserve a ce role-la. L'action
           destructrice ne doit jamais etre la plus visible de l'ecran de jeu. */
        /* Quitter : identifie par la COULEUR, pas par la taille. Contour rouge eteint,
           jamais rempli, l'or reste reserve a ce qui fait avancer (Nouvelle partie,
           Continuer), le rouge a ce qui fait sortir. Petit, mais jamais fantome. */
        .reset-btn.quitter-discret { background: rgba(168,68,60,0.07); color: #c07a72;
          border: 1px solid rgba(168,68,60,0.45); box-shadow: none;
          font-size: 11px; padding: 7px 15px; }
        .reset-btn.quitter-discret .btn-icone { opacity: 0.85; }
        /* Icones dessinees a la place des emojis : les emojis changent de dessin d'un
           telephone a l'autre et cassent l'alignement vertical du texte. */
        .btn-icone { width: 13px; height: 13px; flex: none; vertical-align: -1px;
          fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .reset-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
        .reset-btn.quitter-discret:hover { color: var(--red-bright);
          border-color: var(--red-bright); background: rgba(168,68,60,0.16); filter: none; }
        .hint-btn { background: linear-gradient(180deg, #2f4a5a, #223948); color: var(--bone); box-shadow: 0 6px 16px rgba(0,0,0,0.25); }


        /* position: static et non relative : sinon ce conteneur capte l'ancrage du bouton
           Retour, qui retombe dans le flux au lieu de se placer au-dessus du titre.
           isolation reste : elle sert au bon empilement des vignettes d'Ordre. */
        .order-picker, .diff-picker { width: 100%; max-width: 540px; display: flex; flex-direction: column; align-items: center; gap: 14px; position: static; isolation: isolate; }
        .order-picker h2, .diff-picker h2 { font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 0.1em; text-transform: uppercase; margin: 0; color: var(--blue-bright); }
        .order-picker h2.red-t { color: var(--red-bright); }
        .order-picker .sub { font-size: 11px; color: var(--muted); margin-top: -8px; }
        .join-code-input {
          width: 160px; text-align: center; font-family: 'Cinzel', serif; font-size: 22px; letter-spacing: 0.18em;
          text-transform: uppercase; background: var(--panel); border: 1px solid rgba(203,164,86,0.35); border-radius: 10px;
          color: var(--bone); padding: 10px 8px; margin: 6px 0;
        }
        .join-code-input:focus { outline: none; border-color: var(--gold); }
        /* Code de partie : c'est LA donnée que le joueur doit lire puis dicter à son
           adversaire. Il occupe donc toute la largeur disponible et se dimensionne en vw
           pour rester énorme sur un écran de téléphone, avec un plafond sur grand écran. */
        .game-code-display {
          font-family: 'Cinzel', serif; font-size: clamp(44px, 15vw, 76px); font-weight: 700;
          letter-spacing: 0.16em; text-indent: 0.16em; line-height: 1.1; color: var(--gold-bright);
          background: var(--panel); border: 2px solid rgba(203,164,86,0.55); border-radius: 14px;
          padding: 18px 16px; margin: 12px 0; width: 100%; text-align: center;
          text-shadow: 0 0 26px rgba(203,164,86,0.45); box-shadow: 0 0 0 1px rgba(203,164,86,0.18), 0 10px 30px rgba(0,0,0,0.45);
        }
        .code-copie { font-size: 11px; color: var(--gold-bright); margin-top: -4px; min-height: 14px; }
        /* Textes d'attente : un encart discret, hauteur reservee pour que le bloc ne
           saute pas d'une phrase a l'autre. */
        /* L'Ordre en vedette pendant la recherche d'adversaire. */
        .attente-ordre {
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          margin-top: 12px; width: 100%; max-width: 250px;
        }
        /* Cadre du portrait : reference de position pour le texte incruste. Plus de trait
           dore ni d'ombre portee : l'illustration ne doit plus se lire comme une carte
           posee sur la page, elle doit s'y fondre. */
        .attente-ordre-cadre {
          position: relative; display: block; border-radius: 14px;
        }
        /* Fondu a l'apparition, puis bords qui s'effacent : l'image sort du noir et s'y
           replonge sur ses quatre cotes, au lieu de s'arreter net sur un bord franc. */
        .attente-ordre-cadre img {
          display: block; width: min(72vw, 300px); aspect-ratio: 3 / 4; object-fit: cover;
          -webkit-mask-image: radial-gradient(118% 92% at 50% 40%, #000 50%, rgba(0,0,0,0.5) 76%, transparent 100%);
          mask-image: radial-gradient(118% 92% at 50% 40%, #000 50%, rgba(0,0,0,0.5) 76%, transparent 100%);
          animation: attente-image-fondu 1.4s ease-out both;
        }
        @keyframes attente-image-fondu {
          from { opacity: 0; transform: scale(1.04); }
          to { opacity: 1; transform: scale(1); }
        }
        /* Le voile du texte suit le meme effacement : sans cela il flottait en rectangle
           net sur une image aux bords fondus. */
        .attente-ordre-cadre .recit-attente.sur-image {
          -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%);
          mask-image: linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%);
        }
        /* Textes poses SUR l'illustration : un voile monte du bas, opaque sous le texte
           pour le rendre lisible quel que soit le portrait, transparent en haut pour ne
           pas masquer le personnage. */
        .recit-attente.sur-image {
          position: absolute; left: 0; right: 0; bottom: 0;
          width: auto; max-width: none; margin: 0;
          padding: 26px 14px 12px;
          background: linear-gradient(180deg, rgba(8,6,12,0) 0%, rgba(8,6,12,0.72) 32%, rgba(8,6,12,0.93) 100%);
          border: none; border-radius: 0; min-height: 0; gap: 5px;
        }
        .recit-attente.sur-image .recit-genre { font-size: 9px; letter-spacing: 0.24em; }
        .recit-attente.sur-image .recit-texte {
          font-size: 11.5px; line-height: 1.45;
          text-shadow: 0 1px 3px rgba(0,0,0,0.95);
        }
        .recit-attente {
          width: 100%; max-width: 340px; box-sizing: border-box;
          margin-top: 12px;
          padding: 13px 16px 14px;
          background: rgba(8,6,12,0.5); border: 1px solid rgba(203,164,86,0.18);
          border-radius: 12px; text-align: center; min-height: 96px;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
        }
        .recit-genre {
          font-family: 'Cinzel', serif; font-size: 9.5px; font-weight: 700;
          letter-spacing: 0.26em; text-transform: uppercase; color: var(--gold);
        }
        .recit-texte {
          margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--bone);
          animation: recit-parait 0.7s ease-out both;
        }
        @keyframes recit-parait {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        /* Rappel du code pendant le choix des Ordres : plus discret que l'écran d'attente,
           mais toujours lisible sans plisser les yeux (l'ancienne version était en 11px). */
        /* Minuteur du choix des Ordres : ancre en haut a droite de l'ecran, en vis-a-vis
           du bouton Retour place en haut a gauche. */
        .ordres-minuteur {
          position: absolute; top: 16px; right: 14px; z-index: 40;
          display: flex; align-items: center; gap: 7px;
          padding: 7px 13px 7px 10px; border-radius: 999px;
          background: rgba(8,6,12,0.92); border: 1px solid rgba(203,164,86,0.6);
          box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        /* Le sablier est une illustration : plus haut que large, on ne le rogne pas. */
        .ordres-sablier {
          width: 18px; height: 26px; object-fit: contain; display: block;
          filter: drop-shadow(0 0 5px rgba(232,200,119,0.5));
          animation: sablier-tourne 2.4s linear infinite;
        }
        /* Seul transform est anime : le sablier tourne sans rien recalculer. */
        @keyframes sablier-tourne {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .ordres-temps {
          font-family: 'Cinzel', serif; font-size: 15px; font-weight: 700;
          letter-spacing: 0.06em; color: var(--gold-bright);
          font-variant-numeric: tabular-nums;
        }
        .ordres-minuteur.urgent { border-color: var(--red-bright); }
        .ordres-minuteur.urgent .ordres-temps { color: var(--red-bright); }
        /* Sur une illustration, l'alerte passe par la teinte : on la fait virer au rouge. */
        .ordres-minuteur.urgent .ordres-sablier {
          filter: drop-shadow(0 0 5px rgba(224,101,90,0.6)) hue-rotate(-35deg) saturate(1.5);
        }
        .ordres-adversaire {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11.5px; color: var(--muted); margin-top: -2px;
        }
        .ordres-adversaire svg { width: 13px; height: 13px; fill: var(--bonus); }
        .ordres-adversaire.pret { color: var(--bonus); }
        .code-rappel { font-size: 15px; color: var(--muted); margin-top: -4px; }
        .code-rappel b {
          font-family: 'Cinzel', serif; font-size: 24px; letter-spacing: 0.14em;
          color: var(--gold-bright); margin-left: 6px; vertical-align: -2px;
        }
        .online-error { color: var(--red-bright); font-size: 11.5px; margin-top: 10px; text-align: center; }
        /* Trophées et titre d'un joueur en Classé : des puces posées à côté de son nom. */
        .zone-main { position: relative; width: 100%; display: flex; flex-direction: column; align-items: center; }
        /* L'etiquette est une rangee : le nom, puis ce qui le decrit. */
        .turn-label {
          display: flex; align-items: center; justify-content: center;
          gap: 8px; flex-wrap: wrap;
        }
        .turn-label-nom { flex: none; }
        .trophees-flottant {
          display: inline-flex; align-items: center; gap: 5px; flex: none;
          padding: 3px 11px 3px 8px; border-radius: 999px;
          font-family: 'Cinzel', serif; font-size: 15px; font-weight: 700; line-height: 1;
          color: var(--gold-bright); background: rgba(8,6,12,0.8);
          border: 1px solid rgba(203,164,86,0.45);
        }
        .trophees-flottant svg { width: 17px; height: 17px; fill: var(--gold-bright); }
        /* Titre de style en Classe : face aux trophees, a droite de la rangee d'Ordres. */
        .titre-flottant {
          flex: none; max-width: 44vw; padding: 3px 9px; border-radius: 999px;
          font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700;
          letter-spacing: 0.03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: var(--bone); background: rgba(8,6,12,0.8);
          border: 1px solid rgba(203,164,86,0.28);
        }
        /* Le titre sous le pseudo du hub : discret, il n'eclipse pas le nom. */
        .hub-pseudo-titre {
          display: block; margin-top: 1px;
          font-family: 'Cinzel', serif; font-size: 8.5px; font-weight: 600;
          letter-spacing: 0.08em; color: var(--gold); text-transform: none;
        }
        /* Panneau de profil. Un joueur chevronne peut cumuler trois titres ET la liste
           des dix combos : le panneau defile plutot que de deborder de l'ecran, ce qui
           rendait le bouton Fermer inatteignable sur les petits telephones. */
        .info-panel.settings-panel.profil-panel {
          max-height: 88dvh; overflow-y: auto; -webkit-overflow-scrolling: touch;
        }
        .profil-chiffres { display: flex; gap: 8px; width: 100%; margin-top: 4px; }
        .profil-chiffres > div {
          flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px;
          padding: 8px 4px; border-radius: 10px;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(203,164,86,0.18);
        }
        .profil-chiffres b { font-family: 'Cinzel', serif; font-size: 17px; color: var(--gold-bright); }
        .profil-chiffres span { font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
        .profil-titre {
          width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 3px;
          padding: 9px 11px; margin-bottom: 7px; border-radius: 11px;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(203,164,86,0.2);
        }
        .profil-titre.principal {
          background: linear-gradient(180deg, rgba(203,164,86,0.16), rgba(203,164,86,0.05));
          border-color: rgba(203,164,86,0.55);
        }
        .profil-titre-haut { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .profil-titre-nom { font-family: 'Cinzel', serif; font-size: 14px; font-weight: 700; color: var(--gold-bright); }
        .profil-titre-taux { font-size: 11px; font-weight: 700; color: var(--gold); }
        .profil-titre-recit { font-size: 11.5px; line-height: 1.45; color: var(--bone); }
        .profil-titre-ordres {
          font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted);
        }
        .profil-vide {
          width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 11px;
          font-size: 11.5px; line-height: 1.5; color: var(--muted);
          background: rgba(255,255,255,0.03); border: 1px dashed rgba(203,164,86,0.25);
        }
        .profil-liste { display: flex; flex-direction: column; gap: 5px; width: 100%; }
        .profil-ligne { display: flex; align-items: center; gap: 8px; }
        .profil-ligne-nom { flex: 0 0 43%; font-size: 11px; color: var(--bone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .profil-ligne-jauge {
          flex: 1; height: 6px; border-radius: 999px; overflow: hidden;
          background: rgba(255,255,255,0.07);
        }
        .profil-ligne-jauge i {
          display: block; height: 100%; border-radius: 999px;
          background: linear-gradient(90deg, #b89742, #e8c877);
        }
        .profil-ligne-nombre { flex: none; min-width: 18px; text-align: right; font-size: 11px; font-weight: 700; color: var(--gold); }
        .revanche-attente { font-size: 11px; color: var(--muted); text-align: center; font-style: italic; }
        /* Code du tournoi : lisible sans crier — l'arbre au-dessous est la vraie vedette,
           contrairement au mode "Jouer avec un ami" où le code occupe l'écran. */
        .code-tournoi {
          font-family: 'Cinzel', serif; font-size: clamp(24px, 7vw, 38px); font-weight: 700;
          letter-spacing: 0.18em; text-indent: 0.18em; color: var(--gold-bright);
          background: var(--panel); border: 1px solid rgba(203,164,86,0.45); border-radius: 10px;
          padding: 8px 18px; margin: 4px 0; text-align: center;
        }
        /* Siège encore vide dans l'arbre du tournoi en ligne. */
        .tb-plaque.tb-attente { opacity: 0.55; border-style: dashed; }
        .tb-plaque.tb-attente .tb-nom { color: var(--muted); letter-spacing: 0.3em; }
        .tb-champion-annonce { color: var(--gold-bright); font-weight: 700; font-size: 13px; }
        /* Messages en direct. Bouton flottant au-dessus de la rangée d'actions ; le
           panneau reste compact pour ne jamais recouvrir le plateau entier. */
        /* z-index 75/76 et non 60/61 : l'eventail se deploie vers le HAUT depuis la main
           du bas, c'est-a-dire exactement sur la bande du chat, et son fond invisible
           couvre tout l'ecran (65). En restant dessous, le panneau ouvert se faisait
           recouvrir par les cartes (70) au niveau meme du champ de saisie, et le premier
           tap sur "Envoyer" ne servait qu'a refermer l'eventail. Meme raison que
           .order-tile (66) et .info-overlay (90) : ce qu'on a ouvert soi-meme doit rester
           touchable. */
        .chat-bouton {
          position: fixed; right: 10px; bottom: 86px; z-index: 75;
          width: 40px; height: 40px; border-radius: 50%; font-size: 17px; line-height: 1;
          background: var(--panel); color: var(--bone);
          border: 1px solid rgba(203,164,86,0.45); box-shadow: 0 4px 12px rgba(0,0,0,0.45);
          cursor: pointer; display: flex; align-items: center; justify-content: center;
        }
        .chat-bouton svg { width: 20px; height: 20px; fill: var(--bone); }
        /* Affichage direct coupe : le bouton reste la, en retrait, pour qu'on sache
           que les messages arrivent toujours. */
        .chat-bouton.directs-coupes { opacity: 0.8; }
        .chat-bouton.directs-coupes svg { fill: var(--muted); }
        /* Barre rouge en diagonale : l'affichage direct est coupe, et ca se voit. */
        .chat-bouton.directs-coupes::after {
          content: ""; position: absolute; left: 6px; right: 6px; top: 50%;
          height: 3px; margin-top: -1.5px; border-radius: 2px;
          background: var(--red-bright); transform: rotate(-45deg);
          box-shadow: 0 0 5px rgba(224,101,90,0.7);
        }
        .chat-bulle-directe {
          position: fixed; right: 10px; bottom: 132px; z-index: 76;
          width: min(250px, calc(100vw - 20px)); box-sizing: border-box;
          padding: 9px 12px; border-radius: 12px; cursor: pointer;
          background: var(--panel); border: 1px solid rgba(203,164,86,0.4);
          box-shadow: 0 6px 18px rgba(0,0,0,0.5);
          font-size: 12.5px; line-height: 1.45; color: var(--bone);
          animation: chat-bulle-parait 0.32s ease-out both;
        }
        .chat-bulle-directe.de-moi { border-color: rgba(111,164,230,0.5); }
        .chat-bulle-directe.de-lui { border-color: rgba(224,101,90,0.5); }
        .chat-bulle-auteur {
          display: block; font-family: 'Cinzel', serif; font-size: 9.5px;
          letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-bottom: 3px;
        }
        @keyframes chat-bulle-parait {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .chat-bulle-avis {
          position: fixed; right: 10px; bottom: 132px; z-index: 76;
          padding: 7px 12px; border-radius: 999px;
          background: rgba(8,6,12,0.92); border: 1px solid rgba(203,164,86,0.35);
          font-size: 11px; letter-spacing: 0.06em; color: var(--gold-bright);
          animation: chat-bulle-parait 0.28s ease-out both;
        }
        .chat-badge {
          position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px;
          border-radius: 999px; padding: 0 4px; font-size: 10px; font-weight: 700; line-height: 17px;
          color: #14111c; background: var(--gold-bright); text-align: center;
        }
        .chat-panneau {
          position: fixed; right: 10px; bottom: 132px; z-index: 75;
          width: min(290px, calc(100vw - 20px)); max-height: 42vh;
          display: flex; flex-direction: column;
          background: rgba(20,17,28,0.96); border: 1px solid rgba(203,164,86,0.35);
          border-radius: 12px; box-shadow: 0 12px 30px rgba(0,0,0,0.55); overflow: hidden;
        }
        .chat-liste { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; min-height: 70px; }
        .chat-vide { font-size: 11px; color: var(--muted); text-align: center; margin: auto; font-style: italic; }
        .chat-msg {
          max-width: 82%; padding: 6px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.35;
          word-break: break-word; white-space: pre-wrap;
        }
        .chat-moi { align-self: flex-end; background: rgba(203,164,86,0.18); border: 1px solid rgba(203,164,86,0.35); color: var(--bone); border-bottom-right-radius: 3px; }
        .chat-lui { align-self: flex-start; background: rgba(63,111,176,0.2); border: 1px solid rgba(111,164,230,0.3); color: var(--bone); border-bottom-left-radius: 3px; }
        .chat-saisie-ligne { display: flex; gap: 6px; padding: 8px; border-top: 1px solid rgba(203,164,86,0.2); }
        .chat-saisie {
          flex: 1; min-width: 0; background: rgba(8,6,12,0.6); color: var(--bone);
          border: 1px solid rgba(203,164,86,0.3); border-radius: 8px; padding: 7px 10px; font-size: 13px;
          font-family: inherit;
        }
        .chat-saisie:focus { outline: none; border-color: var(--gold); }
        .chat-envoyer {
          width: 36px; border-radius: 8px; border: 1px solid rgba(203,164,86,0.45);
          background: rgba(203,164,86,0.15); color: var(--gold-bright); font-size: 14px; cursor: pointer;
        }
        .chat-envoyer:disabled { opacity: 0.4; cursor: default; }
        .revanche-btn.revanche-invite {
          border-color: var(--gold-bright); color: var(--gold-bright);
          animation: hint-pulse 1.4s ease-in-out infinite;
        }
        .order-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 11px; width: 100%; }
        .order-option { display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
          background: var(--panel); border: 1px solid rgba(203,164,86,0.15); cursor: pointer;
          transition: border-color .2s, transform .2s, box-shadow .2s; }
        .order-option:hover { border-color: var(--gold); transform: translateY(-2px); box-shadow: 0 8px 18px rgba(0,0,0,0.35); }
        .order-option.picked { border-color: var(--gold-bright); box-shadow: 0 0 0 1px var(--gold-bright), 0 0 16px rgba(203,164,86,0.3); }
        .order-option.picked-blue { border-color: var(--blue-bright); box-shadow: 0 0 0 1px var(--blue-bright), 0 0 16px rgba(111,164,230,0.3); }
        .order-option.picked-red { border-color: var(--red-bright); box-shadow: 0 0 0 1px var(--red-bright), 0 0 16px rgba(224,101,90,0.3); }
        /* Tournoi : Ordre sélectionné pour le ban, rouge + effet de cassure (verre brisé),
           bien distinct du halo doré "picked" utilisé ailleurs pour "je choisis d'utiliser ça". */
        .order-option.ban-picked {
          position: relative; border-color: var(--red-bright);
          box-shadow: 0 0 0 1px var(--red-bright), 0 0 16px rgba(224,101,90,0.4);
        }
        .order-option.ban-picked::before {
          content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
          background: rgba(224,101,90,0.4); border-radius: inherit;
          animation: ban-wash-in 0.25s ease-out;
        }
        @keyframes ban-wash-in { from { opacity: 0; } to { opacity: 1; } }
        .ban-crack-overlay {
          position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3;
          filter: drop-shadow(0 0 3px rgba(255,255,255,0.8)) drop-shadow(0 0 6px rgba(224,101,90,0.8));
        }
        .ban-crack-overlay path {
          stroke: #fff; stroke-width: 2.5; fill: none;
          stroke-dasharray: 300; stroke-dashoffset: 300;
          animation: ban-crack-appear 0.35s ease-out forwards;
        }
        @keyframes ban-crack-appear {
          0%   { stroke-dashoffset: 300; opacity: 0; }
          100% { stroke-dashoffset: 0; opacity: 1; }
        }
        .order-option.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
        .order-thumb-wrap { position: relative; width: 100%; height: 200px; overflow: hidden; }
        .order-option .thumb {
          width: 100%; height: 200px; object-fit: cover; object-position: center 2%; display: block;
        }
        .order-thumb-wrap::after {
          content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 50px; pointer-events: none;
          background: linear-gradient(180deg, transparent, var(--panel));
        }
        .order-option .icon-frame {
          width: 100%; height: 200px; display: flex; align-items: center; justify-content: center;
          font-size: 46px; background: radial-gradient(circle, rgba(203,164,86,0.12), transparent 70%);
        }
        .order-option .info {
          min-width: 0; padding: 9px 11px 11px; margin-top: -1px;
          background: var(--panel); text-align: left;
        }
        .order-option .info .name { font-family: 'Cinzel', serif; font-size: 12.5px; letter-spacing: 0.03em; color: var(--bone); }
        .order-option .info .desc { display: block; font-size: 10px; color: var(--muted); margin-top: 3px; line-height: 1.35; text-align: left; }

        /* Ordre "prochainement" : le vrai portrait est poussé au contraste jusqu'à la
           gravure, une aura de la couleur de l'Ordre respire derrière lui, et un
           balayage lumineux le traverse au survol pour donner un aperçu furtif.
           PIÈGE : le filtre est posé sur l'image elle-même, jamais sur le conteneur, un filter CSS déteint sur TOUS les descendants, cadenas et badge compris. */
        .order-option.order-option-locked {
          cursor: not-allowed; position: relative;
        }
        .order-option.order-option-locked:hover { border-color: rgba(203,164,86,0.15); transform: none; box-shadow: none; }
        .teaser-wrap { --teaser-glow: #5fe0d4; --teaser-glow-soft: rgba(95,224,212,0.5); }
        .teaser-aura {
          position: absolute; inset: -25%; z-index: 0; pointer-events: none;
          background: radial-gradient(circle at 50% 45%, var(--teaser-glow) 0%, transparent 58%);
          opacity: 0.3; filter: blur(10px);
          animation: teaser-breathe 4s ease-in-out infinite;
        }
        @keyframes teaser-breathe { 0%, 100% { opacity: 0.22; } 50% { opacity: 0.5; } }
        .order-option.order-option-locked .thumb-teaser {
          position: relative; z-index: 1;
          filter: grayscale(0.9) contrast(185%) brightness(0.38);
          transition: filter 0.6s ease;
        }
        .order-thumb-wrap::after { z-index: 2; }
        .teaser-scan {
          position: absolute; left: 0; right: 0; top: -100%; height: 55%; z-index: 3;
          pointer-events: none; mix-blend-mode: screen; opacity: 0;
          background: linear-gradient(180deg, transparent, var(--teaser-glow-soft) 45%, transparent);
        }
        .teaser-wrap:hover .teaser-aura,
        .teaser-wrap.teaser-peek .teaser-aura { animation: none; opacity: 0.85; transition: opacity 0.5s ease; }
        .teaser-wrap:hover .thumb-teaser,
        .teaser-wrap.teaser-peek .thumb-teaser { filter: grayscale(0.55) contrast(155%) brightness(0.77); }
        .teaser-wrap:hover .teaser-scan,
        .teaser-wrap.teaser-peek .teaser-scan { opacity: 0.6; animation: teaser-sweep 1s ease-out; }
        @keyframes teaser-sweep { from { top: -100%; } to { top: 110%; } }
        .order-option.order-option-locked .icon-frame { filter: grayscale(0.85) brightness(0.55); }
        .order-option.order-option-locked .info .name,
        .order-option.order-option-locked .info .desc { color: var(--muted); font-style: italic; }
        /* Les enfants positionnés d'une vignette (encoche, badge, fissure de ban) ont
           besoin que la vignette elle-même serve de repère. Sans cette ligne, ils se
           calaient sur un ancêtre plus haut : la fissure du ban s'affichait à côté de
           la carte au lieu de dessus. */
        .order-option { position: relative; }
        /* Encoche de capacité supérieure, en haut à droite de la vignette d'un Ordre.
           Vide = capacité au repos, pleine et dorée = capacité active pour la partie.
           N'apparaît que sur les Ordres dont le Héraut a été gagné en mode Histoire. */
        .heraut-encoche {
          position: absolute; top: 8px; right: 8px; z-index: 4;
          width: 24px; height: 24px; border-radius: 7px;
          background: rgba(12,10,18,0.78); border: 1px solid rgba(203,164,86,0.45);
          backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
          display: flex; align-items: center; justify-content: center;
          color: transparent; cursor: pointer;
          transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
        }
        .heraut-encoche svg { width: 14px; height: 14px; display: block; }
        .heraut-encoche:hover { border-color: var(--gold); color: rgba(203,164,86,0.5); }
        .heraut-encoche.actif {
          background: var(--gold); border-color: var(--gold-bright); color: #14111c;
          box-shadow: 0 0 10px rgba(203,164,86,0.5);
        }
        .heraut-encoche.actif:hover { color: #14111c; }
        .coming-soon-badge {
          position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
          background: rgba(12,10,18,0.85); border: 1px solid var(--gold); color: var(--gold-bright);
          font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
          padding: 4px 10px; border-radius: 999px; white-space: nowrap; z-index: 5;
        }
        .lock-chip svg { width: 17px; height: 17px; }
        .lock-chip {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 4;
          width: 32px; height: 32px; border-radius: 50%;
          background: rgba(20,17,28,0.32);
          backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
          display: flex; align-items: center; justify-content: center;
          opacity: 0.8; transition: opacity 0.5s ease, transform 0.5s ease;
        }
        .teaser-wrap:hover .lock-chip,
        .teaser-wrap.teaser-peek .lock-chip { opacity: 0.3; transform: translate(-50%, -50%) scale(0.9); }
        .lock-icon { width: 26px; height: 26px; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.7)); }
        @media (prefers-reduced-motion: reduce) {
          .teaser-aura { animation: none; opacity: 0.35; }
          .teaser-scan { display: none; }
        }

        /* Mode Histoire : écran des chapitres */

        /* ---------- Carte de chapitre (remplace l'ancienne liste) ----------
           Un écran par chapitre, thème visuel propre a chaque Ordre (feu pour Cendres,
           verdure pour Archers...). Les couleurs arrivent par variables CSS posées en
           ligne sur .story-map (--th-a, --th-b, --th-cadre, --th-lueur) ; la FORME des
           particules et leur sens viennent des classes th-flamme / th-feuille / ... et
           th-monte / th-tombe. Toutes les positions et durees des particules sont figees
           dans des tables JS : rien d'aleatoire a l'affichage. */
        /* La carte est placee SOUS le bandeau EMPRISE, pas en plein ecran : lui imposer
           94dvh la faisait deborder, et les fleches de navigation sortaient de l'ecran
           (65 px sur iPhone SE), plus moyen de changer de chapitre. On ne fixe donc plus
           de hauteur minimale ; c'est le panneau du chemin qui prend l'espace restant, et
           dvh plafonne l'ensemble pour que la barre de navigation reste toujours visible.
           Repere en mesurant la position du bas de la nav dans le navigateur. */
        /* height: 100dvh est indispensable : sans hauteur imposee, ce conteneur flex se
           contente de la taille de son contenu (mesure a 106 px) et le flex: 1 de la
           fenetre de carte n'a rien a distribuer, elle restait a 0 px de haut, sans
           aucun rocher affiche. Diagnostique en mesurant les hauteurs dans le navigateur. */
        /* La carte remplit l'ecran. height ET max-height sont necessaires : sans hauteur
           imposee, ce conteneur flex se contente de la taille de son contenu (mesure a
           106 px) et le flex: 1 de la fenetre n'a rien a distribuer, elle restait a 0 px,
           sans aucun rocher. 96dvh plutot que 100 : les fleches de navigation debordaient
           du bas de l'ecran. Diagnostique en mesurant les hauteurs dans le navigateur. */
        .story-map {
          position: relative; width: 100%; overflow: hidden;
          height: 96dvh; max-height: 96dvh;
          display: flex; flex-direction: column; padding: 8px 10px 4px;
        }
        /* Le cadre thematique : quatre lueurs interieures qui respirent doucement, une par
           bord. Une seule boite avec 4 box-shadow inset, leger et sans image. */
        .story-map-cadre {
          position: absolute; inset: 0; pointer-events: none; z-index: 1;
          box-shadow:
            inset 0 26px 34px -18px var(--th-cadre),
            inset 0 -30px 40px -18px var(--th-cadre),
            inset 22px 0 30px -16px var(--th-cadre),
            inset -22px 0 30px -16px var(--th-cadre);
          animation: sm-cadre-respire 5.5s ease-in-out infinite;
          border-radius: 14px;
        }
        @keyframes sm-cadre-respire {
          0%, 100% { opacity: 0.75; }
          50% { opacity: 1; }
        }

        /* ---------- Ambiance "brasier" : les bords s'embrasent ----------
           L'INTENSITE SUIT LA PROGRESSION via --sm-feu (0 au depart du chapitre, 1 sur
           la derniere etape), calcule dans le JSX. Le chapitre s'echauffe a mesure qu'on
           le remonte : braises discretes au debut, embrasement complet devant le
           Seigneur de Guerre.
           Tout est en translate/opacity uniquement, aucun blur anime, aucun box-shadow
           anime : ce sont les deux seules proprietes qui ne forcent pas le navigateur a
           repeindre, condition pour rester fluide sur un iPhone SE. */
        .sm-brasier { position: absolute; inset: 0; pointer-events: none; z-index: 1; overflow: hidden; border-radius: 14px; }

        /* Lueur de fond : plus forte en bas, presente dans les deux coins bas. */
        .sm-brasier-lueur {
          position: absolute; inset: 0;
          background:
            radial-gradient(ellipse 62% 26% at 50% 100%, var(--th-cadre), rgba(0,0,0,0) 72%),
            radial-gradient(circle 130px at 0% 100%, var(--th-lueur), rgba(0,0,0,0) 70%),
            radial-gradient(circle 130px at 100% 100%, var(--th-lueur), rgba(0,0,0,0) 70%),
            radial-gradient(ellipse 40% 18% at 50% 0%, var(--th-cadre), rgba(0,0,0,0) 76%);
          opacity: calc(0.3 + 0.7 * var(--sm-feu));
          animation: sm-lueur-respire 4.2s ease-in-out infinite;
        }
        @keyframes sm-lueur-respire {
          0%, 100% { transform: scaleY(0.97); }
          50% { transform: scaleY(1.05); }
        }

        /* Langues de feu qui lechent le bord bas. Elles ondulent en permanence, et leur
           hauteur croit avec --sm-feu. */
        .sm-flamme-bas {
          position: absolute; bottom: -6px;
          width: var(--fw); height: calc(var(--fh) * (0.42 + 0.58 * var(--sm-feu)));
          background: linear-gradient(0deg, var(--th-braise) 0%, var(--th-a) 42%, rgba(255,190,70,0.25) 74%, rgba(0,0,0,0) 100%);
          border-radius: 50% 50% 42% 42% / 72% 72% 28% 28%;
          filter: blur(6px);
          opacity: calc(0.25 + 0.75 * var(--sm-feu));
          transform-origin: 50% 100%;
          animation-name: sm-flamme-ondule;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }
        @keyframes sm-flamme-ondule {
          0%, 100% { transform: scaleY(0.86) skewX(-4deg); }
          35% { transform: scaleY(1.14) skewX(3deg); }
          70% { transform: scaleY(0.95) skewX(-2deg); }
        }

        /* Braises qui remontent le long des deux cotes. Pas de blur ici : le degrade
           radial les adoucit deja, et chaque element floute + anime coute une texture
           supplementaire au compositeur. */
        .sm-braise-cote {
          position: absolute; width: var(--bt); height: var(--bt); border-radius: 50%;
          background: radial-gradient(circle, var(--th-noyau) 0%, var(--th-braise) 55%, rgba(0,0,0,0) 78%);
          opacity: calc(0.3 + 0.7 * var(--sm-feu));
          animation-name: sm-braise-monte;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .sm-braise-cote.bc-g { left: 6px; }
        .sm-braise-cote.bc-d { right: 6px; }
        @keyframes sm-braise-monte {
          0% { transform: translateY(0) scale(0.7); opacity: 0; }
          15% { opacity: 1; }
          80% { opacity: 0.55; }
          100% { transform: translateY(-46dvh) scale(1.15); opacity: 0; }
        }

        /* La carte du mode Histoire s'affiche en plein ecran : son bouton doit rester
           DANS l'image, pas se coller a la fenetre. On annule donc le placement fixe
           ci-dessus pour ce cas precis. */
        .story-map-retour { position: relative !important; top: auto; left: auto; z-index: 6; align-self: flex-start; }

        /* L'en-tete flotte PAR-DESSUS l'image (la carte remonte dessous). Un voile sombre
           degrade le separe du decor sans le couper net, sinon le titre se perdrait dans
           les rochers et la lave. */
        .story-map-entete {
          position: relative; z-index: 5;
          display: flex; align-items: center; justify-content: center; gap: 12px;
          margin: 2px 0 4px; padding: 4px 4px 14px;
        }
        .amb-brasier .story-map-entete::before {
          content: ""; position: absolute; inset: -60px -20px -10px; pointer-events: none;
          background: linear-gradient(180deg, rgba(10,7,14,0.92) 0%, rgba(10,7,14,0.8) 55%, rgba(10,7,14,0) 100%);
          z-index: -1;
        }
        .story-map-titres { text-align: center; }
        /* Titre "forge a chaud" : un degrade metal chaud dans le texte lui-meme, avec un
           reflet qui balaie lentement, le meme principe que le titre EMPRISE de
           l'accueil, decline dans la couleur du chapitre. */
        .story-map-nom {
          margin: 0; font-family: 'Cinzel', serif; letter-spacing: 3px; font-size: 26px;
          background: linear-gradient(100deg, var(--th-braise) 12%, var(--gold-bright) 34%, #fff6de 50%, var(--gold-bright) 66%, var(--th-braise) 88%);
          background-size: 240% 100%;
          -webkit-background-clip: text; background-clip: text; color: transparent;
          text-shadow: 0 2px 6px rgba(0,0,0,0.55);
          filter: drop-shadow(0 0 12px var(--th-lueur));
          animation: sm-titre-forge 7s ease-in-out infinite;
        }
        @keyframes sm-titre-forge {
          0% { background-position: 190% 0; }
          55%, 100% { background-position: -70% 0; }
        }
        .story-map-sous { color: var(--muted); font-size: 13px; letter-spacing: 1.5px; margin-top: 2px; }
        /* Medaillon du Seigneur de Guerre, dans son aura. Le halo est porte par le CADRE
           et non par l'image : un filter pose sur l'image deborderait sur le portrait. */
        .story-map-medaillon-cadre {
          position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
          width: 52px; height: 52px; border-radius: 50%;
        }
        .amb-brasier .story-map-medaillon-cadre::before {
          content: ""; position: absolute; inset: -7px; border-radius: 50%; pointer-events: none;
          background: radial-gradient(circle, var(--th-lueur) 0%, rgba(0,0,0,0) 68%);
          animation: sm-aura-respire 3.2s ease-in-out infinite;
        }
        @keyframes sm-aura-respire {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50% { transform: scale(1.14); opacity: 1; }
        }
        .story-map-medaillon {
          position: relative; width: 100%; height: 100%; border-radius: 50%; object-fit: cover;
          border: 2px solid var(--gold); box-shadow: 0 0 14px var(--th-lueur), 0 3px 8px rgba(0,0,0,0.5);
        }

        /* Le panneau : la zone du chemin. Les cases et segments s'y positionnent en
           pourcentage (left / bottom), calcules par storyMapLayout. */
        /* La FENETRE sur la carte : elle masque ce qui deborde et capte le glissement.
           touch-action: none est indispensable, sans lui, le navigateur mobile interprete
           le geste comme un defilement de page et la carte ne suit pas le doigt. */
        /* La carte prend toute la hauteur restante entre l'en-tete et la barre de
           navigation : plafonnee a 420 px, elle laissait de larges bandes vides en haut et
           en bas. flex: 1 avec min-height: 0 (indispensable en conteneur flex, sinon
           l'element refuse de descendre sous la taille de son contenu). Les marges
           negatives la font remonter SOUS l'en-tete, qui flotte par-dessus l'image. */
        .story-map-panneau {
          position: relative; z-index: 3; overflow: hidden;
          flex: 1; min-height: 0;
          margin: -58px 0 2px;
          touch-action: none; cursor: grab;
          border-radius: 10px;
          /* Fondu sur les quatre bords : sans lui, la fenetre coupait l'image au couteau
             et on voyait le rectangle de la photo. Le degrade est LONG (30% en haut) et
             passe par un point intermediaire a 50% d'opacite : une transition courte ou
             purement lineaire laisse encore deviner une arete. Il est plus etendu en haut
             qu'en bas parce que c'est la, sous le titre, que la cassure sautait aux yeux.
             Les deux axes sont combines (mask-composite) pour adoucir aussi les coins. */
          /* Fondu allonge. L'ancien passait de transparent a opaque en 13 % sur les cotes :
             trop court, l'oeil lisait encore une arete verticale la ou l'image s'arrete.
             Il est desormais etale sur 22 %, avec quatre paliers au lieu de deux, et une
             ellipse vient adoucir les coins que deux degrades droits laissent carres.
             ATTENTION : trois couches demandent DEUX operations de composition. Avec une
             seule valeur, la troisieme est ignoree en silence (piege deja rencontre sur
             les arenes de ligue). */
          -webkit-mask-image:
            linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.3) 9%, rgba(0,0,0,0.72) 20%, #000 34%, #000 74%, rgba(0,0,0,0.6) 88%, rgba(0,0,0,0.2) 96%, transparent 100%),
            linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.28) 5%, rgba(0,0,0,0.7) 13%, #000 22%, #000 78%, rgba(0,0,0,0.7) 87%, rgba(0,0,0,0.28) 95%, transparent 100%),
            radial-gradient(ellipse 118% 112% at 50% 50%, #000 52%, rgba(0,0,0,0.72) 76%, rgba(0,0,0,0.25) 91%, transparent 100%);
          mask-image:
            linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.3) 9%, rgba(0,0,0,0.72) 20%, #000 34%, #000 74%, rgba(0,0,0,0.6) 88%, rgba(0,0,0,0.2) 96%, transparent 100%),
            linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.28) 5%, rgba(0,0,0,0.7) 13%, #000 22%, #000 78%, rgba(0,0,0,0.7) 87%, rgba(0,0,0,0.28) 95%, transparent 100%),
            radial-gradient(ellipse 118% 112% at 50% 50%, #000 52%, rgba(0,0,0,0.72) 76%, rgba(0,0,0,0.25) 91%, transparent 100%);
          -webkit-mask-composite: source-in, source-in;
          mask-composite: intersect, intersect;
        }
        .story-map-panneau:active { cursor: grabbing; }
        /* La SURFACE MONDE : plus grande que la fenetre, deplacee en transform. Les ilots
           et la coulee s'y positionnent en pourcentage, donc tout suit automatiquement. */
        .sm-monde { position: absolute; top: 0; left: 0; will-change: transform; }

        /* ---------- Chapitre illustre (carte peinte) ----------
           L'image porte deja les ilots et la coulee : les formes CSS s'effacent et il ne
           reste que des zones tapables invisibles, posees pile sur les rochers peints
           (positions mesurees dans l'image, voir STORY_CARTES_PEINTES). Seul l'ETAT reste
           dessine par-dessus : un halo pour l'etape en cours, un voile sombre pour les
           etapes pas encore atteintes. */
        .sm-fond-peint {
          display: block; width: 100%; height: auto;
          pointer-events: none; user-select: none; -webkit-user-drag: none;
        }
        /* Sur une carte peinte, le noeud epouse la SILHOUETTE de son rocher (masque CSS
           pose en ligne, genere depuis l'image). L'etat se peint donc a travers la forme
           reelle de la roche : plus de rond pose sur une pierre irreguliere. */
        .sm-monde-peint .sm-case {
          background: none; filter: none; animation: none;
          clip-path: none; border-radius: 0;
          transform: translate(-50%, 50%);
          overflow: visible;
        }
        /* La decoupe eteinte, calee exactement sur le rocher qu'elle recouvre. */
        .sm-roche-eteinte {
          position: absolute; inset: 0; width: 100%; height: 100%;
          pointer-events: none; user-select: none; -webkit-user-drag: none;
        }
        .sm-monde-peint .sm-coeur,
        .sm-monde-peint .sm-meche,
        .sm-monde-peint .sm-foyer-marque { display: none; }
        /* Etape a venir : le rocher est eteint dans sa forme exacte. */
        /* Rien ici : l'extinction est portee par l'image .sm-roche-eteinte, qui epouse la
           silhouette. Un fond colore ou un backdrop-filter redonnerait un rectangle. */
        /* Etape conquise : braise chaude sur toute la surface du rocher. */
        /* Etape conquise : le rocher reste tel quel dans l'image, deja incandescent. */
        /* Etape en cours : la roche est ravivee. Le halo qui deborde autour est porte par
           un pseudo-element SANS masque (::after est masque avec son parent, ::before non
           puisqu'on le sort du cadre), sinon le halo serait lui aussi decoupe a la forme
           du rocher et ne rayonnerait pas. */
        /* Le halo autour du rocher courant : un calque separe, place juste derriere le
           noeud et non masque, pour rayonner au-dela de la pierre. */
        /* Etape en cours : un ANNEAU pose autour du rocher. Il est rond, volontairement :
           contrairement a l'assombrissement (qui doit epouser la roche pour ne pas laisser
           de coin eclaire), un repere de selection se lit mieux comme une forme simple et
           reguliere, nettement distincte de la silhouette irreguliere des ilots. */
        /* L'anneau est cale sur le noeud par inset (des marges negatives egales sur les
           quatre cotes), et non par left/top: 50% + translate : le parent porte deja un
           translate de centrage, les deux se cumulaient et decalaient l'anneau en bas a
           droite du rocher. Avec inset, il grandit symetriquement autour de la zone. */
        .sm-monde-peint .sm-encours::before {
          content: ""; position: absolute; inset: -22% -16%;
          border-radius: 50%; pointer-events: none;
          border: 2px solid rgba(255,226,150,0.85);
          box-shadow: 0 0 16px rgba(255,190,80,0.65), inset 0 0 20px rgba(255,180,60,0.28);
          animation: sm-anneau-bat 1.9s ease-in-out infinite;
        }
        @keyframes sm-anneau-bat {
          0%, 100% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.06); opacity: 1; }
        }

        /* Le blason du Seigneur de Guerre reste visible par-dessus l'image. */
        .sm-monde-peint .sm-blason { top: -20px; }

        /* Bandeaux d'etat du chapitre (verrouille / termine), au CENTRE exact de la carte.
           Ils etaient au tiers superieur : ils flottaient dans le vide au-dessus du chemin
           et se lisaient comme une etiquette de plus, pas comme le verdict de l'ecran.
           ATTENTION au transform : avec top a 50 % il faut translater sur les DEUX axes,
           sinon le bandeau descend de la moitie de sa propre hauteur.
           Le halo sombre autour (box-shadow tres etale) le detache des rochers et des
           traits de lumiere qu'il recouvre desormais, sans masquer le decor. */
        .story-map-verrou, .story-map-fini {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 6;
          padding: 12px 22px; border-radius: 999px; font-size: 15px; white-space: nowrap;
          background: rgba(8,6,12,0.94); border: 1.5px solid rgba(255,255,255,0.22);
          box-shadow: 0 6px 20px rgba(0,0,0,0.7), 0 0 44px 30px rgba(8,6,12,0.6);
        }
        .story-map-verrou { color: var(--bone); }
        .story-map-fini { color: var(--gold-bright); border-color: rgba(203,164,86,0.65); }
        /* Chapitre verrouille : tout le chemin s'eteint, le decor aussi. */
        .story-map-locked .story-map-panneau > .sm-case,
        .story-map-locked .sm-coulee-bord { opacity: 0.35; filter: grayscale(0.7); }
        .story-map-locked .sm-particule { display: none; }
        /* Chapitre verrouille : le brasier s'eteint entierement, pierre froide, aucune
           braise. C'est ce qui distingue "pas encore accessible" de "pas encore joue". */
        .story-map-locked .sm-brasier { display: none; }
        .story-map-locked .story-map-nom { animation: none; filter: none; }
        .story-map-locked .story-map-medaillon-cadre::before { display: none; }

        /* La COULEE DE LAVE : trois traces superposes sur la meme courbe. Le bord est la
           croute refroidie (large et sombre), le corps est la lave (orange), la veine est
           le filet incandescent qui circule au centre. Devant le joueur, seul le bord
           subsiste : une simple cassure de roche, sans feu. */
        .sm-chemin { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; overflow: visible; }
        .sm-coulee-bord {
          fill: none; stroke: rgba(120,100,110,0.16); stroke-width: 9; stroke-linecap: round;
        }
        .sm-coulee-bord.sm-coulee-active { stroke: rgba(70,26,14,0.9); stroke-width: 13; }
        .sm-coulee-corps {
          fill: none; stroke: var(--th-a); stroke-width: 8; stroke-linecap: round;
          filter: drop-shadow(0 0 9px var(--th-lueur));
          animation: sm-lave-palpite 3.4s ease-in-out infinite;
        }
        @keyframes sm-lave-palpite {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
        /* Le filet incandescent qui descend la coulee. stroke-dasharray + dashoffset
           animes : un seul trace, rien a repeindre. */
        .sm-coulee-veine {
          fill: none; stroke: var(--th-noyau); stroke-width: 3.4; stroke-linecap: round;
          stroke-dasharray: 8 70; stroke-dashoffset: 78;
          filter: drop-shadow(0 0 6px var(--th-noyau));
          animation: sm-flux 3s linear infinite;
        }
        @keyframes sm-flux {
          to { stroke-dashoffset: -78; }
        }

        /* ====== Noeuds : des ILOTS DE ROCHE VOLCANIQUE, vus a plat ======
           Inspires de la reference : plaques de basalte aux contours irreguliers, parcourues
           de fissures qui s'embrasent. Aucun chiffre, le foyer et le sanctuaire du
           Seigneur de Guerre ancrent les deux extremites du parcours.
           Trois decoupes alternees (sm-ilot-1/2/3) evitent la repetition mecanique : les
           ilots se ressemblent sans etre identiques, comme des roches brisees. */
        .sm-case {
          position: absolute; transform: translate(-50%, 50%);
          width: clamp(54px, 15vw, 68px); height: clamp(48px, 13.5vw, 60px);
          z-index: 4;
          display: flex; align-items: center; justify-content: center;
          /* Basalte : sombre, legerement graine, plus clair sur le dessus. */
          background:
            radial-gradient(ellipse 70% 50% at 42% 34%, rgba(255,255,255,0.055), rgba(0,0,0,0) 62%),
            linear-gradient(158deg, #2b2731 0%, #1d1a24 46%, #121016 100%);
          filter: drop-shadow(0 5px 9px rgba(0,0,0,0.6));
          transition: filter .3s;
        }
        .sm-ilot-1 { clip-path: polygon(11% 4%, 62% 0%, 92% 14%, 100% 52%, 84% 92%, 38% 100%, 8% 84%, 0% 38%); }
        .sm-ilot-2 { clip-path: polygon(6% 16%, 44% 2%, 88% 6%, 100% 44%, 93% 84%, 52% 100%, 14% 92%, 0% 54%); }
        .sm-ilot-3 { clip-path: polygon(16% 0%, 70% 6%, 100% 34%, 94% 74%, 62% 100%, 22% 94%, 2% 62%, 4% 22%); }

        /* Les fissures : un reseau grave dans la roche, eteint par defaut, incandescent
           des que l'ilot s'allume. Un SVG en masque plutot qu'une image : il suit la
           couleur du theme et ne coute qu'une texture. */
        .sm-coeur {
          position: absolute; inset: 0;
          background: currentColor;
          color: rgba(255,255,255,0.09);
          -webkit-mask: var(--fissures) center / 100% 100% no-repeat;
          mask: var(--fissures) center / 100% 100% no-repeat;
          --fissures: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'%3E%3Cg stroke='black' fill='none' stroke-width='3.4' stroke-linecap='round'%3E%3Cpath d='M6 62 L28 54 L44 66 L68 48 L96 58'/%3E%3Cpath d='M30 8 L38 34 L44 66'/%3E%3Cpath d='M68 48 L74 22'/%3E%3Cpath d='M28 54 L18 88'/%3E%3Cpath d='M74 22 L92 14'/%3E%3Cpath d='M44 66 L52 94'/%3E%3C/g%3E%3C/svg%3E");
          transition: color .35s;
        }

        /* Ilot conquis : les fissures coulent, la roche est chauffee par en dessous. */
        .sm-gagnee {
          background:
            radial-gradient(ellipse 70% 50% at 42% 34%, rgba(255,190,120,0.1), rgba(0,0,0,0) 62%),
            linear-gradient(158deg, #3a2a2a 0%, #241a1e 46%, #150f13 100%);
          filter: drop-shadow(0 0 10px var(--th-lueur)) drop-shadow(0 5px 9px rgba(0,0,0,0.6));
        }
        .sm-gagnee .sm-coeur {
          color: var(--th-a);
          animation: sm-fissure-respire 3.2s ease-in-out infinite;
        }
        @keyframes sm-fissure-respire {
          0%, 100% { opacity: 0.8; }
          50% { opacity: 1; }
        }

        /* Ilot courant : le magma affleure, les fissures sont chauffees a blanc, c'est
           lui qu'on tape. Un halo double le signale sans avoir besoin de bordure. */
        .sm-encours {
          cursor: pointer;
          background:
            radial-gradient(ellipse 62% 44% at 46% 42%, rgba(255,214,140,0.22), rgba(0,0,0,0) 66%),
            linear-gradient(158deg, #4a3226 0%, #2c1e1c 46%, #17100f 100%);
          filter: drop-shadow(0 0 16px var(--th-lueur)) drop-shadow(0 5px 9px rgba(0,0,0,0.6));
          animation: sm-ilot-chauffe 1.9s ease-in-out infinite;
        }
        .sm-encours .sm-coeur {
          color: #ffd98a;
          animation: sm-fissure-bat 1.9s ease-in-out infinite;
        }
        @keyframes sm-fissure-bat {
          0%, 100% { opacity: 0.78; }
          50% { opacity: 1; }
        }
        @keyframes sm-ilot-chauffe {
          0%, 100% { filter: drop-shadow(0 0 12px var(--th-lueur)) drop-shadow(0 5px 9px rgba(0,0,0,0.6)); }
          50% { filter: drop-shadow(0 0 24px var(--th-braise)) drop-shadow(0 5px 9px rgba(0,0,0,0.6)); }
        }

        .sm-tapable { cursor: pointer; }
        .sm-tapable:hover { transform: translate(-50%, 50%) scale(1.07); }
        .sm-tapable:active { transform: translate(-50%, 50%) scale(0.96); }

        /* Le FOYER : la coulee nait sous ce premier ilot. Une flaque incandescente sous sa
           base le signale, seul repere de depart, suffisant puisque le chemin est une
           ligne continue sans embranchement. */
        .sm-foyer-marque {
          position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%);
          width: 76%; height: 12px; border-radius: 50%; pointer-events: none; z-index: -1;
          background: radial-gradient(ellipse, var(--th-noyau) 0%, var(--th-braise) 38%, rgba(0,0,0,0) 74%);
          filter: blur(2px);
          opacity: 0.65;
          animation: sm-flaque-respire 3.4s ease-in-out infinite;
        }
        @keyframes sm-flaque-respire {
          0%, 100% { transform: translateX(-50%) scale(0.88); opacity: 0.55; }
          50% { transform: translateX(-50%) scale(1.14); opacity: 1; }
        }
        .sm-foyer.sm-gagnee .sm-foyer-marque, .sm-foyer.sm-encours .sm-foyer-marque { opacity: 1; }

        /* L'ilot du SEIGNEUR DE GUERRE : plus vaste, et une brisure de lave verticale le
           signale de loin. Avec le foyer, il ancre les deux bouts du parcours. */
        .sm-seigneur {
          width: clamp(66px, 18.5vw, 84px); height: clamp(58px, 16vw, 74px);
        }
        .sm-blason {
          position: absolute; top: -13px; left: 50%; transform: translateX(-50%);
          width: 30px; height: 20px; pointer-events: none; z-index: 2;
          background: linear-gradient(180deg, var(--th-noyau), var(--th-braise));
          /* Heaume a deux cornes : menacant sans tomber dans le crane, qui jurerait avec
             le ton du reste du jeu. */
          clip-path: polygon(0% 6%, 15% 0%, 26% 36%, 50% 22%, 74% 36%, 85% 0%, 100% 6%, 88% 64%, 62% 100%, 38% 100%, 12% 64%);
          opacity: 0.62;
          transition: opacity .3s;
        }
        .sm-seigneur.sm-gagnee .sm-blason, .sm-seigneur.sm-encours .sm-blason {
          opacity: 1; filter: drop-shadow(0 0 8px var(--th-lueur));
        }

        /* Les meches : la matiere du theme qui s'echappe sous chaque case allumee, les
           hachures du croquis. Elles heritent de la forme du theme (voir plus bas). */
        .sm-meche {
          position: absolute; bottom: -12px; transform: translateX(-50%);
          width: calc(var(--mt) * 1.5); height: calc(var(--mt) * 2.2);
          pointer-events: none; z-index: -1;
        }

        /* Particules du decor : parsemees sur toute la carte, elles montent ou tombent
           selon le theme. Position horizontale figee (table JS), verticale par animation. */
        .sm-particule {
          position: absolute; width: var(--pt); height: calc(var(--pt) * 1.5);
          pointer-events: none; z-index: 2;
        }
        .th-monte .sm-particule { bottom: -30px; animation-name: sm-va-haut; animation-timing-function: linear; animation-iteration-count: infinite; }
        .th-tombe .sm-particule { top: -30px; animation-name: sm-va-bas; animation-timing-function: linear; animation-iteration-count: infinite; }
        @keyframes sm-va-haut {
          0% { transform: translateY(0) rotate(0deg); opacity: 0; }
          12% { opacity: 0.9; }
          85% { opacity: 0.5; }
          100% { transform: translateY(calc(-94dvh - 60px)) rotate(14deg); opacity: 0; }
        }
        @keyframes sm-va-bas {
          0% { transform: translateY(0) rotate(0deg); opacity: 0; }
          12% { opacity: 0.9; }
          85% { opacity: 0.5; }
          100% { transform: translateY(calc(94dvh + 60px)) rotate(-16deg); opacity: 0; }
        }
        .th-monte .sm-meche { animation-name: sm-meche-haut; animation-timing-function: ease-out; animation-iteration-count: infinite; }
        .th-tombe .sm-meche { animation-name: sm-meche-bas; animation-timing-function: ease-in; animation-iteration-count: infinite; }
        @keyframes sm-meche-haut {
          0% { transform: translateX(-50%) translateY(0) scale(0.7); opacity: 0; }
          25% { opacity: 0.95; }
          100% { transform: translateX(-50%) translateY(calc(var(--mt) * -2.2)) scale(1.1); opacity: 0; }
        }
        @keyframes sm-meche-bas {
          0% { transform: translateX(-50%) translateY(0) scale(0.9); opacity: 0; }
          25% { opacity: 0.95; }
          100% { transform: translateX(-50%) translateY(calc(var(--mt) * 2.2)) scale(0.7); opacity: 0; }
        }

        /* ---------- Formes de particules, une par theme ---------- */
        /* Flamme (Cendres) : goutte pointee vers le haut, coeur clair. */
        .th-flamme .sm-particule, .th-flamme .sm-meche {
          background: radial-gradient(ellipse 55% 65% at 50% 78%, var(--th-b) 0%, var(--th-a) 55%, rgba(0,0,0,0) 78%);
          border-radius: 50% 50% 46% 46% / 68% 68% 32% 32%;
          filter: blur(0.6px);
        }
        /* Feuille (Archers) : ellipse a deux pointes. */
        .th-feuille .sm-particule, .th-feuille .sm-meche {
          background: linear-gradient(135deg, var(--th-a), var(--th-b));
          border-radius: 4% 72% 4% 72%;
        }
        /* Bulle (Abysses) : cercle translucide a fin lisere. */
        .th-bulle .sm-particule, .th-bulle .sm-meche {
          height: var(--pt, var(--mt)); border-radius: 50%;
          background: radial-gradient(circle at 34% 30%, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.06) 26%, rgba(0,0,0,0) 60%);
          border: 1.5px solid var(--th-a);
        }
        /* Volute (Maudits, Pestiferes) : brume ronde tres floue. */
        .th-volute .sm-particule, .th-volute .sm-meche {
          height: var(--pt, var(--mt)); border-radius: 50%;
          background: radial-gradient(circle, var(--th-a) 0%, var(--th-b) 45%, rgba(0,0,0,0) 72%);
          filter: blur(4px);
          transform: scale(1.8);
        }
        /* Etincelle (Piques) : petit losange lumineux. */
        .th-etincelle .sm-particule, .th-etincelle .sm-meche {
          width: calc(var(--pt, var(--mt)) * 0.6); height: calc(var(--pt, var(--mt)) * 0.6);
          background: var(--th-a); border-radius: 2px;
          transform: rotate(45deg);
          box-shadow: 0 0 8px var(--th-b);
        }
        /* Eclat (Gardiens) : petit fragment de pierre anguleux. */
        .th-eclat .sm-particule, .th-eclat .sm-meche {
          width: calc(var(--pt, var(--mt)) * 0.7); height: calc(var(--pt, var(--mt)) * 0.7);
          background: linear-gradient(150deg, var(--th-a), var(--th-b));
          border-radius: 3px 8px 3px 8px;
          transform: rotate(20deg);
        }
        /* Parchemin (Scribes) : petit rectangle de papier. */
        .th-parchemin .sm-particule, .th-parchemin .sm-meche {
          height: calc(var(--pt, var(--mt)) * 0.75);
          background: linear-gradient(160deg, var(--th-a), var(--th-b));
          border-radius: 2px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.4);
        }

        /* Navigation entre chapitres : fleches + position, en bas de la carte. */
        /* La barre de navigation passe PAR-DESSUS le brasier : sans voile sombre derriere
           elle, les fleches et le compteur de chapitre se noyaient dans les flammes du
           bord bas des que le chapitre s'embrasait (verifie en capture sur iPhone SE). */
        .story-map-nav {
          position: relative; z-index: 5;
          display: flex; align-items: center; justify-content: center; gap: 16px;
          padding: 8px 0 10px;
        }
        .story-map-nav::before {
          content: ""; position: absolute; inset: -6px -14px -10px;
          background: linear-gradient(180deg, rgba(10,8,14,0) 0%, rgba(10,8,14,0.72) 45%, rgba(10,8,14,0.88) 100%);
          pointer-events: none; z-index: -1;
        }
        .sm-fleche {
          width: 44px; height: 44px; border-radius: 50%; cursor: pointer;
          font-size: 26px; line-height: 1; padding: 0 0 4px;
          color: var(--gold-bright); background: var(--panel);
          border: 1.5px solid rgba(203,164,86,0.45);
          transition: transform .15s, border-color .2s, opacity .2s;
        }
        .sm-fleche:hover:not(:disabled) { border-color: var(--gold-bright); transform: scale(1.08); }
        .sm-fleche:active:not(:disabled) { transform: scale(0.94); }
        .sm-fleche:disabled { opacity: 0.3; cursor: default; }
        .sm-nav-texte { color: var(--bone); font-size: 13px; letter-spacing: 1.5px; min-width: 110px; text-align: center; text-shadow: 0 1px 4px rgba(0,0,0,0.9); }

        @media (prefers-reduced-motion: reduce) {
          .sm-particule, .sm-meche { display: none; }
          .story-map-cadre, .sm-encours { animation: none; }
          /* Le brasier se fige : on garde une lueur chaude statique sur les bords, mais
             plus une seule flamme ni braise en mouvement. */
          .sm-flamme-bas, .sm-braise-cote { display: none; }
          .sm-brasier-lueur { animation: none; opacity: 0.55; }
          .sm-coulee-corps, .sm-coulee-veine { animation: none; }
          .sm-coulee-veine { display: none; }
          .sm-coeur, .sm-gagnee .sm-coeur, .sm-encours .sm-coeur, .sm-encours { animation: none; }
          .sm-foyer-marque { animation: none; }
          .story-map-nom { animation: none; background-position: 50% 0; }
          .story-map-medaillon-cadre::before { animation: none; opacity: 0.8; }
        }

        /* Mode Histoire : encadré "carte imposée", séparé de la grille de choix en dessous */
        .imposed-order-box {
          display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px 16px;
          border-radius: 14px; background: linear-gradient(160deg, rgba(203,164,86,0.14), var(--panel));
          border: 1.5px solid var(--gold-bright); box-shadow: 0 0 16px rgba(203,164,86,0.25);
        }
        .imposed-order-thumb {
          width: 56px; height: 56px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
          border: 2px solid var(--gold-bright); box-shadow: 0 0 12px rgba(203,164,86,0.4);
        }
        .imposed-order-info { flex: 1; min-width: 0; text-align: left; }
        .imposed-order-label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gold-bright); }
        .imposed-order-name { font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 0.04em; color: var(--bone); margin-top: 2px; }
        .imposed-order-desc { font-size: 10px; color: var(--muted); margin-top: 3px; line-height: 1.35; }
        /* Déblocage de Héraut (écran de récompense) : entrée en fanfare + halo qui pulse
           deux fois autour du portrait, pour marquer le coup sans être trop long. */
        /* Option B : révélation en deux temps, flash doré sur portrait+nom d'abord
           (le "quoi"), puis la description se dévoile juste après (le "pourquoi"). */
        .imposed-order-box.hero-reveal-b .imposed-order-thumb,
        .imposed-order-box.hero-reveal-b .imposed-order-label,
        .imposed-order-box.hero-reveal-b .imposed-order-name {
          animation: hero-flash-in 0.7s ease-out;
        }
        @keyframes hero-flash-in {
          0%   { opacity: 0; filter: brightness(3) drop-shadow(0 0 20px rgba(255,255,255,0.9)); }
          40%  { opacity: 1; filter: brightness(1.8) drop-shadow(0 0 14px rgba(203,164,86,0.8)); }
          100% { opacity: 1; filter: brightness(1) drop-shadow(0 0 0 transparent); }
        }
        .imposed-order-box.hero-reveal-b .imposed-order-desc {
          opacity: 0;
          animation: hero-desc-fade-in 0.8s ease-out 0.6s forwards;
        }
        @keyframes hero-desc-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }



        .diff-grid { display: flex; flex-direction: column; gap: 10px; width: 100%; }
        .diff-option { padding: 13px 16px; border-radius: 12px; background: var(--panel); border: 1px solid rgba(203,164,86,0.15);
          cursor: pointer; transition: border-color .2s, transform .2s, box-shadow .2s;
          display: flex; align-items: center; gap: 12px; }
        .diff-option:hover { border-color: var(--gold); transform: translateY(-2px); box-shadow: 0 8px 18px rgba(0,0,0,0.35); }
        .diff-option .diff-thumb { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
          border: 1px solid rgba(203,164,86,0.3); box-shadow: 0 0 10px rgba(0,0,0,0.4); }
        .diff-option .diff-text { flex: 1; min-width: 0; }
        .diff-option .name { font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 0.05em; color: var(--gold-bright); }
        .diff-option .desc { font-size: 10.5px; color: var(--muted); margin-top: 3px; }
        .confirm-panel { max-width: 300px; gap: 16px; }
        .confirm-text { font-size: 12px; color: var(--muted); text-align: center; line-height: 1.5; }
        .confirm-actions { display: flex; flex-direction: column; gap: 9px; }
        .confirm-actions .reset-btn { width: 100%; }
        .reset-btn.quit-confirm { background: linear-gradient(180deg, #7c332c, #4e1f1a); color: #ffd9d2; box-shadow: 0 6px 16px rgba(0,0,0,0.3); }
        .reset-btn.quit-confirm:hover { filter: brightness(1.14); }

        .assist-grid { display: flex; flex-direction: column; gap: 10px; width: 100%; }
        .assist-option { display: flex; align-items: flex-start; gap: 12px; padding: 13px 16px; border-radius: 12px;
          background: var(--panel); border: 1px solid rgba(203,164,86,0.15); cursor: pointer; transition: border-color .2s, box-shadow .2s; }
        .assist-option:hover { border-color: var(--gold); }
        .assist-option.checked { border-color: var(--gold-bright); box-shadow: 0 0 14px rgba(203,164,86,0.15); }
        .assist-option input[type="checkbox"] { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--gold-bright); flex-shrink: 0; }
        .assist-text .name { font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 0.05em; color: var(--gold-bright); }
        .assist-text .desc { font-size: 10.5px; color: var(--muted); margin-top: 3px; line-height: 1.4; }

        .legend-btn {
          position: fixed; top: 16px; right: 16px; width: 34px; height: 34px; border-radius: 50%;
          background: var(--panel); border: 1.5px solid var(--gold); color: var(--gold-bright);
          font-family: 'Cinzel', serif; font-size: 15px; font-weight: 700; cursor: pointer;
          display: flex; align-items: center; justify-content: center; z-index: 40;
          box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        }
        .legend-btn:hover { background: var(--gold); color: var(--bg); }

        /* touch-action: none, sans lui, un doigt qui glisse SUR le voile fait defiler
           ou bouger le plateau reste dessous. Le panneau est un cul-de-sac tactile. */
        .info-overlay {
          position: fixed; inset: 0; background: rgba(8,6,12,0.72); display: flex; align-items: center;
          /* z-index 90 et non 50 : les vignettes d'Ordre sont a 66 (elles doivent passer
             au-dessus du voile de l'eventail, lui-meme a 65). A 50, elles traversaient
             donc le panneau : en Confluence, ou chaque camp aligne huit vignettes, elles
             recouvraient le titre et le bouton Fermer. Le panneau doit dominer TOUT. */
          justify-content: center; z-index: 90; padding: 24px; animation: pop-in .2s ease;
          touch-action: none; overscroll-behavior: contain;
        }
        @keyframes pop-in { from{opacity:0} to{opacity:1} }
        .info-panel {
          background: var(--panel); border: 1px solid var(--gold); border-radius: 16px; padding: 20px;
          max-width: 340px; width: 100%; max-height: 88dvh; overflow-y: auto;
          display: flex; flex-direction: column; align-items: stretch; gap: 12px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.6);
        }
        /* Parametres : tout doit tenir a l'ecran, aucun defilement. On serre les marges
           et les lignes plutot que de laisser un ascenseur apparaitre. dvh et non vh :
           sur mobile, vh compte la barre d'adresse et deborde. */
        .info-panel.settings-panel {
          overflow: hidden; max-height: none; padding: 22px 18px 20px; gap: 15px;
        }
        /* Le panneau avait grandi mais son texte restait ecrit petit : c'etait la vraie
           raison de l'impression d'etroitesse. */
        .info-panel.settings-panel .settings-nom { font-size: 17px; }
        .info-panel.settings-panel .info-panel-title { font-size: 16px; letter-spacing: 0.13em; }
        .info-panel.settings-panel .reset-btn { padding: 14px 20px; font-size: 13px; }
        /* PIEGE : les lignes sont en content-box avec width: 100 %. Leur padding
           horizontal s'ajoutait donc aux 100 % et elles depassaient de 25 px a droite,
           le chevron etant coupe par le bord du panneau. border-box remet tout dedans. */
        .info-panel.settings-panel .settings-row {
          box-sizing: border-box; width: 100%;
          padding: 19px 18px; margin-bottom: 0; gap: 15px; border-radius: 14px;
        }
        .info-panel.settings-panel .settings-desc { font-size: 12.5px; line-height: 1.45; margin-top: 5px; }
        /* Le titre et le bouton touchaient leurs voisins : on leur donne leur propre air. */
        .info-panel.settings-panel .info-panel-title { margin-bottom: 7px; }
        .info-panel.settings-panel .reset-btn { margin-top: 9px; }
        /* Ecrans courts : pas de place a donner, on garde les valeurs serrees. Le
           correctif de debordement, lui, vaut partout (il est sur la regle de base). */
        @media (max-height: 720px) {
          .info-overlay { padding: 12px; }
          .info-panel.settings-panel { padding: 14px 12px 12px; gap: 7px; }
          .info-panel.settings-panel .settings-row { padding: 10px 12px; }
          .info-panel.settings-panel .settings-nom { font-size: 12.5px; }
          .info-panel.settings-panel .settings-desc { font-size: 9.5px; margin-top: 2px; }
          .info-panel.settings-panel .info-panel-title { margin-bottom: 2px; }
          .info-panel.settings-panel .reset-btn { margin-top: 4px; }
        }
        .info-panel-title {
          font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--gold-bright); text-align: center; margin-bottom: 2px;
        }
        .info-row { display: flex; flex-direction: row; align-items: flex-start; text-align: left; gap: 10px; padding: 10px; border-radius: 10px; background: rgba(255,255,255,0.03); }
        .info-row.blue { border-left: 3px solid var(--blue-bright); }
        .info-row.red { border-left: 3px solid var(--red-bright); }
        .info-thumb-sm { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; border: 1.5px solid var(--gold); flex-shrink: 0; }
        .info-icon-sm { font-size: 28px; flex-shrink: 0; }
        .info-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; }
        .info-row-name { font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: 0.04em; color: var(--bone); }
        .info-row-side { font-size: 10px; color: var(--muted); font-weight: 400; }
        .info-row-desc { font-size: 11px; color: var(--muted); margin-top: 3px; line-height: 1.4; text-align: left; }

        /* ---------- Cérémonie de déblocage d'un Héraut (fin de chapitre) ----------
           Quatre temps : apparition sombre et floue (0-400ms), charge d'énergie avec
           tremblement croissant (400-900ms), impact, flash blanc et bris du cadenas,
           le même que celui des Ordres verrouillés (900-1320ms), puis révélation du nom
           et de l'effet. Sautée entièrement quand les animations réduites sont actives :
           l'écran de récompense s'affiche alors directement. */
        .order-picker.hc-cache { opacity: 0; pointer-events: none; }
        .order-picker.hc-entre { animation: hc-recompense 0.7s ease-out; }
        @keyframes hc-recompense { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        .heraut-ceremonie {
          position: fixed; inset: 0; z-index: 1200; cursor: pointer; padding: 24px; text-align: center;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          animation: hc-voile 0.4s ease-out forwards;
        }
        @keyframes hc-voile { from { background: rgba(8,6,12,0); } to { background: rgba(8,6,12,0.72); } }
        .hc-scene { position: relative; width: 190px; height: 190px; display: grid; place-items: center; }
        .hc-secousse { position: relative; display: grid; place-items: center; animation: hc-tremble 0.5s 0.4s linear both; }
        .hc-orbe {
          position: relative; width: 118px; height: 118px; border-radius: 50%; display: grid; place-items: center;
          animation: hc-apparait 0.4s ease-out both, hc-charge 0.5s 0.4s linear both,
                     hc-impact 0.42s 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        @keyframes hc-apparait {
          from { opacity: 0; transform: scale(0.82); filter: blur(10px) brightness(0.2); }
          to   { opacity: 1; transform: scale(0.9);  filter: blur(6px)  brightness(0.34); }
        }
        @keyframes hc-charge {
          from { transform: scale(0.9);  filter: blur(6px)   brightness(0.34); }
          to   { transform: scale(0.98); filter: blur(1.5px) brightness(0.72); }
        }
        @keyframes hc-impact {
          0%   { transform: scale(0.98); filter: blur(1.5px) brightness(0.72); }
          14%  { transform: scale(1.06); filter: blur(0) brightness(2.6); }
          48%  { transform: scale(1.24); filter: blur(0) brightness(1.25); }
          100% { transform: scale(1);    filter: blur(0) brightness(1); }
        }
        .hc-portrait {
          width: 100%; height: 100%; border-radius: 50%; object-fit: cover;
          border: 2px solid var(--gold-bright);
          animation: hc-halo 0.5s 0.4s ease-in both, hc-halo-pulse 0.9s 1.3s ease-in-out 2;
        }
        @keyframes hc-halo {
          from { box-shadow: 0 0 4px rgba(0,0,0,0.4); }
          to   { box-shadow: 0 0 16px var(--gold), 0 0 34px rgba(232,200,119,0.55); }
        }
        @keyframes hc-halo-pulse {
          0%, 100% { box-shadow: 0 0 14px var(--gold); }
          50% { box-shadow: 0 0 14px var(--gold), 0 0 32px var(--gold-bright), 0 0 54px rgba(232,200,119,0.45); }
        }
        @keyframes hc-tremble {
          0%   { transform: translate(0, 0); }        4%   { transform: translate(0.5px, -0.4px); }
          8%   { transform: translate(-0.6px, 0.4px); }  12%  { transform: translate(0.7px, 0.5px); }
          16%  { transform: translate(-0.8px, -0.6px); } 20%  { transform: translate(0.9px, -0.5px); }
          24%  { transform: translate(-1px, 0.7px); }    28%  { transform: translate(1.1px, 0.6px); }
          32%  { transform: translate(-1.2px, -0.8px); } 36%  { transform: translate(1.3px, -0.7px); }
          40%  { transform: translate(-1.5px, 0.9px); }  44%  { transform: translate(1.6px, 0.8px); }
          48%  { transform: translate(-1.8px, -1px); }   52%  { transform: translate(1.9px, -0.9px); }
          56%  { transform: translate(-2.1px, 1.1px); }  60%  { transform: translate(2.2px, 1px); }
          64%  { transform: translate(-2.4px, -1.2px); } 68%  { transform: translate(2.5px, -1.1px); }
          72%  { transform: translate(-2.7px, 1.3px); }  76%  { transform: translate(2.8px, 1.2px); }
          80%  { transform: translate(-3px, -1.4px); }   84%  { transform: translate(3px, -1.3px); }
          88%  { transform: translate(-3.2px, 1.4px); }  92%  { transform: translate(3.2px, 1.3px); }
          96%  { transform: translate(-2px, -0.8px); }   100% { transform: translate(0, 0); }
        }
        .hc-flash {
          position: absolute; width: 150px; height: 150px; border-radius: 50%; pointer-events: none; opacity: 0;
          background: radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.5) 38%, transparent 68%);
          animation: hc-flash 0.34s 0.9s ease-out both;
        }
        @keyframes hc-flash {
          0%   { opacity: 0; transform: scale(0.5); }
          18%  { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1.5); }
        }
        .hc-cadenas { position: absolute; width: 52px; height: 52px; pointer-events: none; animation: hc-cad-apparait 0.4s ease-out both; }
        @keyframes hc-cad-apparait { from { opacity: 0; transform: scale(0.6); } to { opacity: 0.95; transform: scale(1); } }
        .hc-anse  { animation: hc-anse-brise 0.5s 0.9s cubic-bezier(0.3, 1.4, 0.6, 1) both; }
        .hc-corps { animation: hc-corps-brise 0.55s 0.9s cubic-bezier(0.4, 0.1, 0.7, 1) both; }
        @keyframes hc-anse-brise {
          0%   { transform: translateY(0) rotate(0); opacity: 1; }
          22%  { transform: translateY(-3px) rotate(-4deg); opacity: 1; }
          100% { transform: translateY(-30px) rotate(-38deg); opacity: 0; }
        }
        @keyframes hc-corps-brise {
          0%   { transform: scale(1) translateY(0) rotate(0); opacity: 1; }
          18%  { transform: scale(1.18) translateY(0) rotate(2deg); opacity: 1; }
          100% { transform: scale(0.7) translateY(26px) rotate(16deg); opacity: 0; }
        }
        .hc-etincelle {
          position: absolute; width: 4px; height: 4px; border-radius: 50%; pointer-events: none; opacity: 0;
          background: var(--gold-bright); box-shadow: 0 0 6px var(--gold-bright);
          animation-name: hc-flotte; animation-timing-function: ease-out; animation-fill-mode: both;
        }
        @keyframes hc-flotte {
          0%   { opacity: 0; transform: translate(0, 0) scale(0.4); }
          18%  { opacity: 1; }
          100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.15); }
        }
        .hc-eyebrow { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--muted); margin-top: 30px; animation: hc-monte 0.5s 1.2s ease-out both; }
        .hc-titre {
          font-family: 'Cinzel', serif; font-size: 17px; letter-spacing: 0.09em; margin-top: 5px;
          color: var(--gold-bright); text-shadow: 0 0 12px rgba(232,200,119,0.6);
          animation: hc-monte 0.6s 1.32s ease-out both;
        }
        .hc-effet { font-size: 11px; color: var(--bone); margin-top: 11px; max-width: 250px; line-height: 1.5; animation: hc-monte 0.6s 1.62s ease-out both; }
        .hc-passer { position: absolute; bottom: 26px; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); animation: hc-monte 0.6s 2.1s ease-out both; }
        @keyframes hc-monte { from { opacity: 0; transform: translateY(11px); } to { opacity: 1; transform: translateY(0); } }

        /* ============================ ECRAN DE TOURNOI ============================
           Refonte complete : l'arbre etait en styles poses a la main dans le JSX, sans
           identite. Tout passe ici, en classes.
           Regle de performance respectee partout : les animations en boucle n'animent
           que opacity ou transform. Une lueur qui pulse est un calque a ombre FIXE dont
           seule l'opacite bouge, jamais un box-shadow anime. */
        .tb-scene { width: 100%; overflow: hidden; margin: 12px 0 4px; display: flex; justify-content: center; }
        .tb-arbre { position: relative; flex: 0 0 auto; transform: scale(var(--brk-echelle, 1)); transform-origin: top center; }
        .tb-liens { position: absolute; left: 0; top: 0; z-index: 1; }

        /* --- connecteurs : gris tant que le chemin n'est pas franchi --- */
        .tb-lien { stroke: #2a221b; fill: none; stroke-linejoin: round; stroke-linecap: round; }
        .tb-lien-allume {
          stroke: url(#tb-degrade); fill: none; stroke-linejoin: round; stroke-linecap: round;
          filter: drop-shadow(0 0 4px rgba(255,170,0,0.55));
        }

        /* --- la plaque de combattant : metal sombre, contour biseaute ---
           Le biseau tient au couple des deux ombres internes : une lumiere fine en HAUT
           (le chant capte la lumiere) et une ombre en BAS. Sans ce couple, la plaque
           serait un rectangle plat. */
        .tb-plaque {
          position: absolute; box-sizing: border-box; z-index: 2;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
          background: linear-gradient(180deg, #1b1622 0%, #120e16 55%, #0d0a12 100%);
          border: 1px solid #3d352b; border-radius: 9px;
          box-shadow: inset 0 1px 0 rgba(255,240,205,0.09), inset 0 -2px 4px rgba(0,0,0,0.75), 0 3px 8px rgba(0,0,0,0.55);
          transition: filter .35s ease, border-color .35s ease;
        }
        /* --- l'avatar, serti dans un sceau octogonal --- */
        .tb-sceau {
          position: relative; width: 30px; height: 30px; flex: none;
          display: flex; align-items: center; justify-content: center;
          clip-path: polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%);
          background: linear-gradient(160deg, #4a3f2e, #241d18);
          padding: 1.5px;
        }
        .tb-portrait {
          width: 100%; height: 100%; object-fit: cover; display: block;
          clip-path: polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%);
        }
        /* Le joueur n'a pas de symbole : son sceau est simplement plein d'or, la ou les
           autres portent un portrait. C'est la marque la plus simple possible, et la plus
           lisible a 30 px. Un ecu, une croix ou tout autre dessin ne faisait qu'ajouter du
           bruit dans un espace ou rien n'est lisible. */
        .tb-blason {
          display: block; width: 100%; height: 100%;
          background: linear-gradient(160deg, #f2dda2 0%, #e8c877 45%, #b8944a 100%);
          clip-path: polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%);
        }
        /* Le sceau du joueur est serti dans l'or, celui des adversaires dans un bronze
           eteint : la difference se lit avant meme d'avoir cherche le mot "Vous". */
        .tb-vous .tb-sceau { background: linear-gradient(160deg, #e8c877, #8a6f34); padding: 2px; }
        .tb-nom {
          font-family: 'Cinzel', serif; font-size: 9.5px; line-height: 1.05; text-align: center;
          color: var(--bone); padding: 0 3px; letter-spacing: 0.02em;
        }
        .tb-grand { border-color: rgba(203,164,86,0.5); }

        /* --- la plaque du joueur : reperable au premier coup d'oeil --- */
        .tb-vous { border-color: #e8c877; }
        .tb-vous .tb-nom { color: var(--gold-bright); font-weight: 700; }
        .tb-vous::after {
          content: ""; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
          box-shadow: 0 0 15px rgba(232,200,119,0.4), 0 0 30px rgba(232,200,119,0.22);
          opacity: 0; will-change: opacity;
          animation: tb-lueur 2.6s ease-in-out infinite;
        }
        @keyframes tb-lueur { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

        /* --- adversaire elimine : la plaque s'eteint, une balafre la barre --- */
        .tb-elimine { filter: grayscale(1) brightness(0.4); border-color: #2a2420; }
        .tb-balafre {
          position: absolute; inset: 0; pointer-events: none; overflow: hidden; border-radius: inherit;
        }
        .tb-balafre::before {
          content: ""; position: absolute; left: -12%; right: -12%; top: 50%;
          height: 2px; transform: rotate(-24deg); transform-origin: center;
          background: linear-gradient(90deg, transparent, #a8302a 18%, #e0554a 50%, #a8302a 82%, transparent);
          box-shadow: 0 0 6px rgba(200,50,40,0.7);
        }

        /* --- le duel final : cadre d'arene, point d'orgue de l'ecran --- */
        .tb-arene {
          position: absolute; z-index: 0; border-radius: 16px; pointer-events: none;
          background: radial-gradient(ellipse at 50% 50%, rgba(203,164,86,0.10), transparent 72%);
          border: 1px solid rgba(203,164,86,0.45);
          box-shadow: 0 0 26px rgba(203,164,86,0.18), inset 0 0 22px rgba(203,164,86,0.07);
        }
        .tb-vs {
          position: absolute; z-index: 3; width: 30px; text-align: center;
          font-family: 'Cinzel', serif; font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
          color: var(--gold-bright); padding: 4px 0; border-radius: 999px;
          background: linear-gradient(180deg, #3a2c50, #241a34);
          border: 1px solid var(--gold); box-shadow: 0 0 10px rgba(203,164,86,0.35);
        }

        /* --- le trophee --- */
        .tb-trophee {
          position: absolute; top: 0; text-align: center; color: var(--gold-bright); z-index: 2;
        }
        .tb-coupe {
          display: block; width: 20px; height: 20px; margin: 2px auto 3px;
        }
        .tb-trophee-nom {
          font-family: 'Cinzel', serif; font-size: 8.5px; letter-spacing: 0.16em;
          text-transform: uppercase; color: var(--gold); margin-top: 1px;
        }
`;

export default function Emprise() {
  const [phase, setPhase] = useState("landing"); // landing (hub) -> (bot: select-difficulty -> select-assist -> select-blue -> preview | confluence-bot: select-difficulty -> select-assist -> confluence-draft -> preview | local: select-blue -> select-red | confluence-local: confluence-draft) -> play
  const [mode, setMode] = useState(null); // "bot" | "local"
  const [timeLeft, setTimeLeft] = useState(TURN_SECONDS);
  // Draft Confluence : un pool COMMUN aux deux joueurs. Chacun choisit un Ordre à son tour
  // (8 tours au total, 4 chacun) ; dès qu'un Ordre est choisi, il rejoint le pool et les
  // DEUX joueurs en auront une carte — que ce soit vous ou l'adversaire qui l'ayez choisi.
  const [draft, setDraft] = useState({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });
  const [pickerChoice, setPickerChoice] = useState([]);
  const [heroChoice, setHeroChoice] = useState(null); // clé d'Ordre du héros activé pour cette main (ou null)
  // Capacités supérieures cochées à l'écran de choix des Ordres : liste de clés d'Ordre.
  // L'encoche n'apparaît que si le Héraut a été GAGNÉ en mode Histoire (chapitre terminé),
  // et seulement hors classement — activer une capacité supérieure ne doit jamais
  // influencer les trophées. Aujourd'hui cela veut dire : contre le bot uniquement.
  // Quand le multijoueur non classé existera, il suffira d'ajouter son mode ici.
  const [herautsCoches, setHerautsCoches] = useState([]);
  const [blueOrders, setBlueOrders] = useState([]);
  const [redOrders, setRedOrders] = useState([]);
  const [botDifficulty, setBotDifficulty] = useState("intermediaire");
  const [confluenceActive, setConfluenceActive] = useState(false); // mode Confluence
  const [testMode, setTestMode] = useState(false);
  // Bloc temporaire : permet d'essayer les cinq arènes sans grimper les ligues.
  const [areneTest, setAreneTest] = useState(null);
  // Bac à sable : bascule la capacité supérieure d'UN Ordre à la fois, sur les cartes
  // en main des deux camps — pour comparer, par exemple, des Archers avec leur Héraut
  // contre des Pestiférés sans le leur, dans la même partie.
  // Aucun état séparé n'est tenu : l'état allumé/éteint est lu directement sur les
  // cartes (heroActive). Impossible que l'affichage et le moteur se contredisent, et
  // rien à réinitialiser au lancement d'une nouvelle partie.
  const herautTestActif = (order) =>
    [...blueHand, ...redHand].some((c) => c.ability === order.ability && c.heroActive);
  const basculerHeraut = (order) => {
    const suivant = !herautTestActif(order);
    const appliquer = (main) =>
      main.map((c) => (c.ability === order.ability ? { ...c, heroActive: suivant } : c));
    setBlueHand((m) => appliquer(m));
    setRedHand((m) => appliquer(m));
  }; // mode test : Confluence, 2 camps contrôlables, sans minuteur
  // Tournoi solo contre des bots : quart de finale → demi-finale → finale, difficulté
  // croissante à chaque tour. Un seul Ordre banni à la fois, choisi par le joueur après
  // chaque victoire, remplacé au tour suivant.
  const [tourney, setTourney] = useState({ active: false, round: 0, ban: null }); // round : 0=quart, 1=demi, 2=finale
  const [confirmQuit, setConfirmQuit] = useState(false); // confirmation avant de quitter une partie en cours
  const [confirmResetStats, setConfirmResetStats] = useState(false); // confirmation à deux clics avant de réinitialiser les statistiques
  const [allowUndo, setAllowUndo] = useState(false); // "Repentir" : autorise à annuler un mauvais coup (mode Bot uniquement, choisi avant la partie)
  const [allowHint, setAllowHint] = useState(false); // "Augure" : un bouton en jeu révèle le meilleur coup (mode Bot uniquement)
  const [hint, setHint] = useState(null); // { cardIdx, cellIdx } suggéré par l'augure, tant que non joué

  // ---------- Multijoueur en ligne (Firebase) ----------
  // myUid : identité anonyme stable (voir firebase.js), sert à savoir qui est qui dans
  // une partie sans compte ni mot de passe. onlineGameId : code à 5 lettres = id du
  // document Firestore "games/{code}". onlineRole : le camp qu'on joue nous-mêmes
  // dans CETTE partie en ligne (fixe pour toute la partie, contrairement à "turn").
  const [myUid, setMyUid] = useState(null);
  const [onlineGameId, setOnlineGameId] = useState(null);
  const [onlineRole, setOnlineRole] = useState(null); // "blue" | "red"
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [onlineError, setOnlineError] = useState("");
  const [onlineStatus, setOnlineStatus] = useState(""); // texte d'attente affiché au joueur
  const [fileAttente, setFileAttente] = useState(false); // recherche d'un adversaire par appariement en cours
  // Ordre mis en avant pendant la recherche : tire au hasard a chaque entree en file,
  // pour que l'attente montre tantot les Cendres, tantot les Chimeres...
  const [ordreAttente, setOrdreAttente] = useState(null);
  // Appariements déjà consommés par cet appareil : garde synchrone contre une seconde
  // lecture du même champ (l'écouteur se déclenche à chaque écriture du document).
  const matchsConsommesRef = useRef(new Set());
  const [codeCopie, setCodeCopie] = useState(false); // retour visuel après copie du code de partie
  // Vrai pour une partie née de l'appariement (mode Classé) : c'est ce qui décide de
  // jouer dans l'arène de sa ligue plutôt que sur le plateau nu.
  const [partieClassee, setPartieClassee] = useState(false);
  // Trophees des deux camps, lus depuis le document de la partie classee.
  const [trophesPartie, setTrophesPartie] = useState(null);
  const [titresPartie, setTitresPartie] = useState(null); // titres de style des deux camps
  // Identifiant du dernier coup ADVERSE déjà rejoué en animation : sans lui, chaque
  // nouvelle notification Firestore sur la partie relancerait les mêmes effets visuels.
  const dernierCoupDistantRef = useRef(null);
  // Reconnexion : partie en ligne retrouvée au démarrage et proposée sur l'accueil.
  // Vrai le temps d'une reprise : indique à l'écouteur qu'il doit router vers le bon
  // écran (jeu ou choix des Ordres) au lieu de laisser le joueur sur l'écran d'attente.
  const repriseRef = useRef(false);
  const repriseTesteeRef = useRef(false); // la purge des cles de reprise n'a lieu qu'une fois
  // Fin de partie décidée hors plateau : "blue"/"red" quand un camp gagne par abandon ou
  // forfait de l'adversaire, quel que soit le score. Dérivé du document Firestore à chaque
  // notification (champ abandonPar), donc toujours cohérent entre les deux appareils.
  const [vainqueurForce, setVainqueurForce] = useState(null);
  const [finMotif, setFinMotif] = useState(null); // "abandon" | "forfait" | null
  // Secondes d'attente du coup adverse en ligne — alimente l'avertissement de forfait.
  const [attenteAdv, setAttenteAdv] = useState(0);
  // Avant-match : présence de l'adversaire (les deux sièges pris) et état de son choix
  // d'Ordres, dérivés du document à chaque notification. Servent au forfait d'avant-match.
  const [advPresent, setAdvPresent] = useState(false);
  const [advPret, setAdvPret] = useState(false);
  const [attentePreMatch, setAttentePreMatch] = useState(0);
  const [tempsOrdres, setTempsOrdres] = useState(ORDRES_SECONDS);
  const ordresAutoRef = useRef(false); // l'echeance ne doit confirmer qu'une seule fois
  const autoForfaitRef = useRef(false); // le forfait pour inactivite ne s'ecrit qu'une fois
  const preForfaitEcritRef = useRef(false);
  const forfaitEcritRef = useRef(false); // un seul constat de forfait par tour d'attente
  // Messages en direct pendant une partie en ligne.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatOuvert, setChatOuvert] = useState(false);
  const [chatSaisie, setChatSaisie] = useState("");
  const [chatNonLus, setChatNonLus] = useState(0);
  const chatVusRef = useRef(0); // combien de messages étaient déjà affichés/comptés
  const chatOuvertRef = useRef(false); // miroir de chatOuvert lisible depuis l'écouteur Firestore
  const messagesDirectsRef = useRef(true); // miroir du reglage, meme raison
  const chatDernierEnvoiRef = useRef(0); // anti-rafale : 1 message par seconde
  const chatListeRef = useRef(null); // la liste déroulante du panneau, pour l'autoscroll
  // Partie dont le compteur de messages vus est le référentiel : au changement de partie
  // (reprise, revanche, match suivant), l'historique existant ne doit pas gonfler le badge.
  const chatGameIdRef = useRef(null);
  // Bulle qui montre le dernier message sans ouvrir le panneau, et reglage qui
  // l'active ou la coupe (double-clic). Persiste d'une partie a l'autre.
  const [messageBulle, setMessageBulle] = useState(null);
  const [messagesDirects, setMessagesDirects] = useState(() => {
    try { return localStorage.getItem("emprise-messages-directs") !== "0"; } catch (e) { return true; }
  });
  const [bulleAvis, setBulleAvis] = useState("");
  const bulleTimerRef = useRef(null);
  const avisTimerRef = useRef(null);
  function basculerMessagesDirects() {
    setMessagesDirects((actif) => {
      const suivant = !actif;
      try { localStorage.setItem("emprise-messages-directs", suivant ? "1" : "0"); } catch (e) { /* non persiste */ }
      if (!suivant) { clearTimeout(bulleTimerRef.current); setMessageBulle(null); }
      setBulleAvis(suivant ? "Messages affichés en direct" : "Affichage direct coupé");
      clearTimeout(avisTimerRef.current);
      avisTimerRef.current = setTimeout(() => setBulleAvis(""), 2200);
      return suivant;
    });
  }
  // Revanche (mode "Jouer avec un ami" uniquement) : votes lus depuis le document.
  const [revancheVotes, setRevancheVotes] = useState(null);
  const revancheCreationRef = useRef(false); // évite de créer deux fois la partie de revanche
  // Tournoi en ligne.
  const [tournoiOnlineId, setTournoiOnlineId] = useState(null);
  const [tournoiData, setTournoiData] = useState(null);
  const [tournoiErreur, setTournoiErreur] = useState("");
  const [codeTournoiInput, setCodeTournoiInput] = useState("");
  const tournoiLancementRef = useRef(false); // un seul client tente le lancement à la fois
  const tournoiResultatRef = useRef(null); // gameId dont le résultat a déjà été écrit


  const [board, setBoard] = useState(Array(CELLS).fill(null));
  const [poisonedCells, setPoisonedCells] = useState(Array(CELLS).fill(false));
  // Cases qui viennent d'être empoisonnées à ce coup : déclenche la bouffée de brume
  // verte (marquage animé), effacé peu après pour ne garder que le marquage persistant.
  const [justPoisoned, setJustPoisoned] = useState([]);

  const [blueHand, setBlueHand] = useState([]);
  const [redHand, setRedHand] = useState([]);
  const [turn, setTurn] = useState("blue");
  const [drag, setDrag] = useState(null); // { owner, idx, x, y, startX, startY } pendant un glisser-déposer de carte
  const [dragHoverCell, setDragHoverCell] = useState(null); // case survolée pendant le glisser
  const [selected, setSelected] = useState(null); // { owner, idx } — carte sélectionnée par simple clic (alternative au glisser)
  const dragMovedRef = useRef(false); // distingue un simple clic (pas de déplacement) d'un vrai glisser
  // Main en éventail : { owner, ability } de l'Ordre actuellement déployé, un seul à la
  // fois. fanClosing garde le dernier Ordre refermé monté le temps de son animation de
  // repli avant de le retirer pour de bon — même mécanique que justPoisoned/
  // poisonTimerRef plus bas pour la bouffée de brume empoisonnée.
  const [fanOpen, setFanOpen] = useState(null);
  const [fanClosing, setFanClosing] = useState(null);
  const fanCloseTimerRef = useRef(null);
  // Point et instant de la dernière saisie d'une carte DEPUIS un éventail ouvert.
  // Sert uniquement à neutraliser le "clic fantôme" décrit dans playCard.
  const fanGrabRef = useRef(null);
  const tuileSaisieRef = useRef(false); // vrai quand un glisser vient de partir d'une vignette : son clic fantôme ne doit pas rouvrir l'éventail
  // Recalculé seulement quand la main correspondante change (pas à chaque rendu).
  const blueGroups = useMemo(() => groupHandByOrder(blueHand), [blueHand]);
  const redGroups = useMemo(() => groupHandByOrder(redHand), [redHand]);
  const [history, setHistory] = useState([]); // pile des états précédant chaque coup, pour le bouton "Annuler"
  const [flashes, setFlashes] = useState({});
  const [dernierCoup, setDernierCoup] = useState(null); // case du dernier coup joué : sa carte porte l'or un tour
  const [ceremonieFin, setCeremonieFin] = useState(null); // "victoire" quand la cérémonie de fin joue
  const [cerPose, setCerPose] = useState(false); // un toucher pendant la cérémonie saute à l'état final
  const [boardShake, setBoardShake] = useState(false); // secousse du plateau à l'impact d'une capture
  const [boardShakeBig, setBoardShakeBig] = useState(false); // secousse amplifiée : chaîne de combo > 2 cartes
  const [banner, setBanner] = useState(null); // { text, key } — affiche "Résonance"/"Onde" sur le plateau
  const bannerTimerRef = useRef(null);
  const bannerTimer2Ref = useRef(null);
  // Références des timers d'animation "fire-and-forget" (hors useEffect) : on les annule
  // avant d'en reprogrammer un nouveau, et tous ensemble si le composant est démonté.
  const flashTimerRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const shakeBigTimerRef = useRef(null);
  const poisonTimerRef = useRef(null);
  useEffect(() => {
    return () => {
      clearTimeout(flashTimerRef.current);
      clearTimeout(shakeTimerRef.current);
      clearTimeout(shakeBigTimerRef.current);
      clearTimeout(poisonTimerRef.current);
      clearTimeout(bannerTimerRef.current);
      clearTimeout(bannerTimer2Ref.current);
    };
  }, []);
  const [gameOver, setGameOver] = useState(false);
  const [infoAbility, setInfoAbility] = useState(null);
  const [hasSavedGame, setHasSavedGame] = useState(false);
  // Duel local à deux sur le même appareil : on se passe le téléphone SANS le retourner.
  // L'écran ne pivote donc pas — il échange les deux mains, pour que celui qui doit jouer
  // trouve toujours la sienne en bas, à portée du pouce, et tout le texte à l'endroit.
  // (Une rotation à 180° a été essayée avant : elle suppose qu'on retourne l'appareil,
  // ce qui n'est pas le geste réel, et laissait la moitié de l'écran tête-bêche.)
  // La clé de stockage garde son ancien nom pour ne pas effacer le réglage des joueurs.
  const [passageTelephone, setPassageTelephone] = useState(() => {
    try { return localStorage.getItem("emprise-rotation-locale") === "1"; } catch (e) { return false; }
  });
  function togglePassageTelephone() {
    setPassageTelephone((r) => {
      const suivant = !r;
      try { localStorage.setItem("emprise-rotation-locale", suivant ? "1" : "0"); } catch (e) { /* non persisté */ }
      return suivant;
    });
  }

  const [reducedMotion, setReducedMotion] = useState(() => {
    try {
      const saved = localStorage.getItem("emprise-reduced-motion");
      if (saved !== null) return saved === "1";
    } catch (e) { /* stockage indisponible : on retombe sur la préférence système */ }
    try {
      return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { return false; }
  });
  function toggleReducedMotion() {
    setReducedMotion((prev) => {
      const next = !prev;
      try { localStorage.setItem("emprise-reduced-motion", next ? "1" : "0"); } catch (e) { /* tant pis, pas persisté cette session */ }
      return next;
    });
  }
  const [activeModal, setActiveModal] = useState(null);
  const [ordreDetail, setOrdreDetail] = useState(null); // Ordre agrandi dans l'onglet Ordres
  // L'avis du hub est rouge par defaut (c'est un message d'echec). Une victoire par
  // abandon adverse passe par le meme canal : elle doit s'annoncer en or, pas en rouge.
  const [avisBon, setAvisBon] = useState(false);
  useEffect(() => {
    if (!ordreDetail) return;
    const onKey = (e) => { if (e.key === "Escape") setOrdreDetail(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordreDetail]);
  // Hub d'accueil : page affichée ("boutique" | "jouer" | "ordres") et sens du dernier
  // changement d'onglet, pour orienter le glissement d'entrée de la page.
  const [hubPage, setHubPage] = useState("jouer");
  const [historique, setHistorique] = useState(() => lireHistorique());
  const [hubSens, setHubSens] = useState("droite");
  const HUB_ORDRE_PAGES = ["boutique", "jouer", "ordres"];
  function allerPageHub(page) {
    if (page === hubPage) return;
    setHubSens(HUB_ORDRE_PAGES.indexOf(page) > HUB_ORDRE_PAGES.indexOf(hubPage) ? "droite" : "gauche");
    setHubPage(page);
  } // null | "stats" | "rules" | "story" | "settings" — un seul panneau ouvert à la fois
  // ---------- Séquence d'entrée de l'écran d'accueil ----------
  // Trois temps : noir total, puis l'illustration des Abysses monte du noir en fondu,
  // puis le titre / sous-titre / bouton glissent vers le haut. Tout est porté par des
  // classes CSS (une par étape) plutôt que par des styles calculés, pour que l'animation
  // tourne sur le compositeur du navigateur et reste fluide sur mobile.
  // Lancée UNE SEULE FOIS au montage du composant, c'est-à-dire au lancement du jeu :
  // revenir au menu après une partie ne rejoue pas les 2,2 s d'intro, ce qui deviendrait
  // vite pénible. La dépendance vide est volontaire — une version liée à `phase` se
  // relançait à un re-render et sautait l'étape 2 (le glissement du titre), repéré en
  // mesurant l'opacité image par image dans le navigateur.
  const [introEtape, setIntroEtape] = useState(0);
  useEffect(() => {
    if (reducedMotion) { setIntroEtape(3); return; } // animations réduites : accueil complet tout de suite
    const t1 = setTimeout(() => setIntroEtape(1), 650);   // l'arene sort du noir, seule
    const t2 = setTimeout(() => setIntroEtape(2), 2600);  // le reste de l'accueil la rejoint
    const t3 = setTimeout(() => setIntroEtape(3), 4100);  // fin : tout est en place
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [stats, setStats] = useState(DEFAULT_STATS);
  const statsRecordedRef = useRef(false);
  // Suivi des combos de la partie en cours. Un ref et non un etat : il est lu et ecrit
  // au milieu d'un coup, un rendu de retard fausserait la detection.
  const combosRef = useRef(nouveauSuiviCombos());
  // Charge les stats au démarrage et à chaque ouverture du panneau (lecture asynchrone).
  useEffect(() => { loadStats().then(setStats); }, [activeModal === "stats"]);
  const [storyProgress, setStoryProgress] = useState(DEFAULT_STORY_PROGRESS);
  // Chapitre actuellement AFFICHÉ sur la carte du mode Histoire (0 à 7). Les flèches
  // le font varier ; à chaque entrée sur la carte il se recale sur le chapitre "utile" :
  // celui qu'on vient de jouer si on en sort, sinon le premier non terminé.
  const [storyMapIndex, setStoryMapIndex] = useState(0);

  // ---------- Carte du mode Histoire : exploration au doigt ----------
  // Le chemin d'un chapitre ne tient plus dans un ecran : il s'etale sur une surface
  // MONDE_FACTEUR fois plus grande, qu'on parcourt en glissant le doigt dans tous les
  // sens. On ne voit donc jamais tout le chapitre d'un coup, ce qui donne l'echelle.
  // Facteur d'agrandissement de la carte par rapport a la fenetre. La fenetre occupant
  // tout l'ecran, la carte n'a plus besoin d'etre beaucoup plus grande : a 1,9 un seul
  // rocher remplissait la moitie de la vue. A 1,25 on voit la majeure partie du chapitre
  // tout en gardant de quoi glisser pour decouvrir le reste.
  // Chaque carte peinte peut le corriger par son propre "zoom" (voir STORY_CARTES_PEINTES) :
  // les rochers n'ont pas la meme taille d'une illustration a l'autre, un reglage unique
  // rendait certains chapitres nettement plus serres que d'autres.
  const MONDE_FACTEUR = 1.25;
  const fenetreCarteRef = useRef(null);
  const [carteOffset, setCarteOffset] = useState({ x: 0, y: 0 });
  const carteDragRef = useRef(null);   // { px, py, ox, oy } au debut du glissement
  const carteBougeeRef = useRef(false); // vrai des que le doigt a vraiment deplace la carte
  // Taille en pixels de la surface monde pour un chapitre ILLUSTRE. Calculee depuis la
  // hauteur reelle de la fenetre (et non en %) : sur une image tres allongee, un
  // dimensionnement par la largeur produisait une surface geante ou l'on ne voyait plus
  // qu'un seul rocher. Remesuree si l'ecran change de taille (rotation, redimensionnement).
  const [fenetreTaille, setFenetreTaille] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = fenetreCarteRef.current;
    if (!el) return;
    function mesurer() {
      const e = fenetreCarteRef.current;
      if (e && e.clientWidth) setFenetreTaille({ w: e.clientWidth, h: e.clientHeight });
    }
    mesurer();
    // ResizeObserver plutot qu'un delai fixe : la fenetre est en flex: 1, sa hauteur n'est
    // connue qu'une fois la mise en page faite. Un setTimeout arrivait trop tot et laissait
    // la surface monde a 0x0 — plus aucun rocher affiche.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(mesurer) : null;
    if (ro) ro.observe(el);
    window.addEventListener("resize", mesurer);
    return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", mesurer); };
  }, [phase, storyMapIndex]);

  // Dimensions reelles de la surface monde du chapitre affiche. Sur une carte peinte,
  // elles suivent le ratio de l'image ; sinon la surface est simplement MONDE_FACTEUR
  // fois la fenetre dans les deux sens. Bornage et centrage s'appuient dessus, sinon on
  // pourrait tirer la carte dans le vide ou viser a cote.
  function tailleMonde() {
    const el = fenetreCarteRef.current;
    const W = el ? el.clientWidth : 0, H = el ? el.clientHeight : 0;
    const ch = STORY_CHAPTERS[storyMapIndex];
    const p = ch && STORY_CARTES_PEINTES[ch.orderKey];
    if (p && p.noeuds.length >= ch.numGames) {
      const mh = H * MONDE_FACTEUR * (p.zoom || 1);
      return { W, H, mw: mh / p.ratio, mh };
    }
    return { W, H, mw: W * MONDE_FACTEUR, mh: H * MONDE_FACTEUR };
  }

  // Borne le decalage pour qu'on ne puisse jamais tirer la carte au-dela de ses limites.
  function clampCarte(x, y) {
    const { W, H, mw, mh } = tailleMonde();
    if (!W) return { x, y };
    // Si la carte est plus etroite que la fenetre, on la centre au lieu de la coller a gauche.
    const cx = mw <= W ? (W - mw) / 2 : Math.min(0, Math.max(W - mw, x));
    const cy = mh <= H ? (H - mh) / 2 : Math.min(0, Math.max(H - mh, y));
    return { x: cx, y: cy };
  }

  // Centre la vue sur un noeud donne (positions en % de la surface monde, y compte
  // depuis le BAS comme dans storyMapLayout).
  function centrerSurNoeud(pos) {
    const { W, H, mw, mh } = tailleMonde();
    if (!W || !pos) return;
    const nx = (pos.x / 100) * mw;
    const ny = ((100 - pos.y) / 100) * mh;
    setCarteOffset(clampCarte(W / 2 - nx, H / 2 - ny));
  }

  // La vue se recale sur l'etape en cours a chaque ouverture de la carte et a chaque
  // changement de chapitre. Sur une carte plus grande que l'ecran, arriver au hasard
  // laisserait le joueur sans reperes ; il doit voir tout de suite ou il en est.
  useEffect(() => {
    if (phase !== "chapters") return;
    const ch = STORY_CHAPTERS[storyMapIndex];
    if (!ch) return;
    const wins = storyProgress.chapterWins[ch.orderKey] || 0;
    const enCours = Math.min(wins + 1, ch.numGames);
    const p = STORY_CARTES_PEINTES[ch.orderKey];
    const positions = p && p.noeuds.length >= ch.numGames ? p.noeuds.slice(0, ch.numGames) : storyMapLayout(ch.numGames);
    const pos = positions[enCours - 1];
    // Attend que la fenetre soit mesuree (fenetreTaille), sinon le centrage se ferait sur
    // une surface de taille nulle et la carte resterait bloquee en haut a gauche.
    if (!fenetreTaille.h) return;
    const t = setTimeout(() => centrerSurNoeud(pos), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, storyMapIndex, storyProgress, fenetreTaille]);

  function onCartePointerDown(e) {
    carteBougeeRef.current = false;
    carteDragRef.current = { px: e.clientX, py: e.clientY, ox: carteOffset.x, oy: carteOffset.y };
  }
  function onCartePointerMove(e) {
    const d = carteDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px, dy = e.clientY - d.py;
    // Seuil de 6 px : en dessous, c'est un tap sur un ilot, pas un glissement. Sans lui,
    // le moindre tremblement du doigt annulerait le tap (meme principe que le glisser
    // d'une carte depuis la main).
    if (!carteBougeeRef.current && Math.hypot(dx, dy) < 6) return;
    carteBougeeRef.current = true;
    setCarteOffset(clampCarte(d.ox + dx, d.oy + dy));
  }
  function onCartePointerUp() {
    carteDragRef.current = null;
  }
  // Un Ordre affiche son encoche s'il possède un Héraut ET que son chapitre d'Histoire
  // est terminé. Dorés et Chimères n'ont pas de Héraut : jamais d'encoche pour eux.
  const encocheVisible = (order) =>
    mode === "bot" &&
    HEROES.some((h) => h.orderKey === order.key) &&
    storyProgress.completedChapters.includes(order.key);
  const encocheCochee = (order) => herautsCoches.includes(order.key);
  // Cocher une capacité sélectionne aussi l'Ordre s'il ne l'était pas : cliquer l'encoche
  // veut dire « je prends cet Ordre, avec sa capacité ». Sans place libre, on ne fait rien
  // plutôt que de cocher une capacité qui ne s'appliquerait à aucune carte.
  const basculerEncoche = (order) => {
    const dejaPris = pickerChoice.some((l) => l.key === order.key);
    if (!dejaPris) {
      if (pickerChoice.length >= 2) return;
      setPickerChoice((prev) => [...prev, order]);
      setHerautsCoches((prev) => [...prev, order.key]);
      return;
    }
    setHerautsCoches((prev) =>
      prev.includes(order.key) ? prev.filter((k) => k !== order.key) : [...prev, order.key]
    );
  };
  // Charge la progression du mode Histoire à chaque entrée sur l'écran des chapitres.
  useEffect(() => { loadStoryProgress().then(setStoryProgress); }, [phase === "chapters"]);
  // À chaque entrée sur la carte : se recale sur le chapitre qu'on vient de jouer (si on
  // revient d'une partie), sinon sur le premier chapitre non terminé — comme un jeu qui
  // rouvre sa carte là où le joueur en est, pas au chapitre 1.
  useEffect(() => {
    if (phase !== "chapters") return;
    loadStoryProgress().then((p) => {
      let idx = storyChapterKey ? STORY_CHAPTERS.findIndex((c) => c.orderKey === storyChapterKey) : -1;
      if (idx < 0) idx = STORY_CHAPTERS.findIndex((c) => !p.completedChapters.includes(c.orderKey));
      if (idx < 0) idx = STORY_CHAPTERS.length - 1; // tout est terminé : on ouvre sur le dernier
      setStoryMapIndex(idx);
    });
  }, [phase]);
  const [storyChapterKey, setStoryChapterKey] = useState(null); // clé d'Ordre du chapitre en cours (null hors mode Histoire)
  const [storySecondPick, setStorySecondPick] = useState(null); // clé du 2e Ordre choisi pour la partie de chapitre en cours
  const [storyChapterJustCompleted, setStoryChapterJustCompleted] = useState(null); // clé d'Ordre si le Seigneur de Guerre vient d'être battu
  const [storyCeremonyDone, setStoryCeremonyDone] = useState(false); // la cérémonie de déblocage du Héraut a été vue (ou passée)
  const [tourneyBanPick, setTourneyBanPick] = useState(null); // clé d'Ordre sélectionné à bannir, avant confirmation
  // Premier clic : demande confirmation. Second clic (sur "Confirmer") : efface pour de bon.
  function handleResetStatsClick() {
    if (!confirmResetStats) { setConfirmResetStats(true); return; }
    resetStats().then(setStats);
    setConfirmResetStats(false);
  }
  // Qui a commencé CETTE partie. Sert au bonus de score : le premier joueur est
  // désavantagé (il ne pose pas la dernière carte), il reçoit donc le +1. Tant qu'Azur
  // commençait toujours, ce +1 pouvait être écrit en dur ; depuis le tirage au sort, il
  // doit suivre le tirage, sinon Azur cumule l'avantage de position ET le bonus.
  const [firstPlayer, setFirstPlayer] = useState("blue");
  const [tut, setTut] = useState({ stepIdx: 0, board: null, resolved: false, flashes: {} });

  const { blueCount, redCount, blueScore, redScore } = useMemo(() => {
    const bc = board.filter((b) => b && b.owner === "blue").length;
    const rc = board.filter((b) => b && b.owner === "red").length;
    return {
      blueCount: bc, redCount: rc,
      blueScore: bc + (firstPlayer === "blue" ? 1 : 0),
      redScore: rc + (firstPlayer === "red" ? 1 : 0),
    };
  }, [board, firstPlayer]);
  // blueScore + redScore = blueCount + redCount + 1 = 16 + 1 = 17 (toujours impair) :
  // une égalité est donc mathématiquement impossible, on ne teste plus ce cas.
  // Le +1 va toujours à celui qui a commencé, quel que soit son camp.
  // Un abandon ou un forfait désigne le vainqueur quel que soit l'état du plateau.
  // vainqueurForce n'a de sens qu'en ligne : ce verrou garantit qu'un état résiduel ne
  // peut jamais décider du vainqueur d'une partie solo ou locale.
  const winner = gameOver ? ((mode === "online" ? vainqueurForce : null) || (blueScore > redScore ? "blue" : "red")) : null;

  // ---------- Perspective : chacun joue EN BAS de son écran ----------
  // En ligne, un joueur Écarlate voyait sa main en haut, comme s'il jouait "chez
  // l'adversaire". Les deux sections (étiquette + main) sont donc pilotées par le camp
  // affiché en haut et en bas, et non plus figées rouge en haut / bleu en bas.
  // Voir juste en dessous : en duel local, ce placement suit désormais le tour de jeu.
  // Qui occupe le bas de l'écran. En ligne, c'est toujours MOI. En duel local avec
  // l'option de passage, c'est celui dont c'est le tour : le téléphone change de mains
  // sans changer de sens, la main du joueur vient donc à lui. Partout ailleurs, Azur.
  // Aucune condition sur les panneaux ouverts ("i", confirmation de départ) : ils ne
  // peuvent pas changer le tour, et les exclure ferait sauter les deux mains à l'écran
  // au moment précis où l'on ouvre un panneau.
  const campBas = mode === "online"
    ? (onlineRole || "blue")
    : (mode === "local" && !testMode && passageTelephone && phase === "play" ? turn : "blue");
  const campHaut = campBas === "red" ? "blue" : "red";

  // ---------- Profil de joueur : quel camp est le mien, avec quels Ordres ----------
  // Contre un Echo je suis toujours Azur ; en ligne, le camp que le serveur m'a donne.
  // En duel local les deux camps sont humains : aucun profil ne peut leur etre attribue,
  // d'ou l'exclusion plus bas.
  const monCampCombos = mode === "bot" ? "blue" : mode === "online" ? onlineRole : null;
  // Une partie ne nourrit le profil que si elle engage un vrai adversaire et un vrai
  // choix d'Ordres : ni bac a sable (tous les Ordres, annulation libre), ni Mode Histoire
  // (Ordres imposes par le chapitre), ni duel local (deux joueurs sur un meme profil), ni
  // Confluence (on y dispose des dix Ordres : les combos y sont a portee de main, et les
  // melanger aux parties a deux Ordres rendrait le profil illisible).
  const partieCompteAuProfil = !!monCampCombos && !testMode && !storyChapterKey && !confluenceActive;

  function mesOrdresDuJeu() {
    const liste = monCampCombos === "red" ? redOrders : blueOrders;
    return new Set((liste || []).map((o) => o && o.key).filter(Boolean));
  }

  // Étiquette d'un camp : son nom, puis ce qui le décrit — trophées et titre de style en
  // Classé. Ces deux-là vivaient en pastilles flottantes calées sur les bords de l'écran,
  // loin du joueur qu'elles décrivent ; elles appartiennent à son nom, elles s'y rangent
  // donc, et les trophées sont assez gros pour se lire d'un coup d'œil en pleine partie.
  function labelCamp(camp) {
    const rouge = camp === "red";
    return (
      <div className={`turn-label ${rouge ? "red-t" : "blue-t"} ${turn !== camp || gameOver ? "en-attente" : ""}`}>
        <span className="turn-label-nom">
          {rouge ? "Écarlate" : "Azur"}
          {mode === "bot" ? (rouge ? ` (Écho) · ${DIFFICULTIES.find((d) => d.key === botDifficulty)?.label}` : " (Vous)") : ""}
          {mode === "online" ? (onlineRole === camp ? " (Vous)" : " (Adversaire)") : ""}
          {!rouge && tourney.active ? `, ${TOURNEY_ROUNDS[tourney.round].label}` : ""}
        </span>
        {pucesTrophees(camp)}
        {pucesTitre(camp)}
      </div>
    );
  }

  // Puce de trophees d'un camp en partie Classee, posee a cote de son nom. Les valeurs
  // viennent du document de la partie : les deux ecrans affichent les memes chiffres,
  // quel que soit le camp qu'ils jouent.
  function pucesTrophees(camp) {
    if (mode !== "online" || !partieClassee) return null;
    const valeur = trophesPartie && typeof trophesPartie[camp] === "number"
      ? trophesPartie[camp]
      : (onlineRole === camp ? (stats.trophies || 0) : 0);
    return (
      <span className="trophees-flottant" title="Trophées">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V6h3V4zm-1 4v1a2 2 0 0 0 2 2V8H6zm12 0h-2v3a2 2 0 0 0 2-2V8z" />
        </svg>
        {valeur}
      </span>
    );
  }

  // Titre de style d'un camp en partie Classee, a la suite de ses trophees. Comme eux, la
  // valeur vient du document de la partie : les deux ecrans lisent la meme chose. Un
  // joueur sans titre n'affiche rien du tout.
  function pucesTitre(camp) {
    if (mode !== "online" || !partieClassee) return null;
    const titre = titresPartie && typeof titresPartie[camp] === "string"
      ? titresPartie[camp]
      : (onlineRole === camp ? titrePrincipal(stats) : "");
    if (!titre) return null;
    const combo = COMBOS.find((c) => c.nom === titre);
    return (
      <span className="titre-flottant" title={combo ? combo.recit : "Style de jeu"}>{titre}</span>
    );
  }

  function mainCamp(camp) {
    const main = camp === "red" ? redHand : blueHand;
    if (main.length === 0) return null;
    return (
      <div className={`hand-row camp-${camp} ${turn === camp && !gameOver ? "active" : ""} ${turn !== camp ? "disabled" : ""} ${main.length > 4 ? "compact" : ""}`}>
        {renderHandGroups(camp)}
      </div>
    );
  }

  // Cérémonie de fin : uniquement pour une victoire HUMAINE, jamais en mode Histoire
  // (il a sa propre récompense de chapitre) ni en mode test. La Défaite n'est pas
  // traitée ici — volontairement. Le léger délai laisse retomber la dernière capture.
  useEffect(() => {
    if (!gameOver) { setCeremonieFin(null); setCerPose(false); return; }
    if (storyChapterKey || testMode) return;
    const victoireHumaine = mode === "bot" ? winner === "blue" : mode === "online" ? winner === onlineRole : true;
    // En duel local quelqu'un d'humain gagne toujours : jamais de ceremonie de Defaite.
    const issue = victoireHumaine ? "victoire" : "defaite";
    // La Defaite attend 2,4 s : il faut laisser au joueur le temps de voir le coup qui
    // l'a fait perdre avant que l'ecran se voile. La Victoire n'a pas ce besoin, on
    // comprend immediatement qu'on a gagne : 650 ms suffisent, au-dela c'est une attente.
    const t = setTimeout(() => setCeremonieFin(issue), issue === "defaite" ? 2400 : 650);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameOver]);

  // Enregistre la statistique une seule fois quand la partie se termine (pas à
  // chaque re-rendu tant que gameOver reste vrai).
  useEffect(() => {
    if (gameOver && !statsRecordedRef.current) {
      statsRecordedRef.current = true;
      // Seuls les Ordres que J'AI joues nourrissent ma maitrise. Compter aussi ceux de
      // l'adversaire (c'etait le cas) faisait progresser des Ordres qu'on n'avait jamais
      // tenus en main. En duel local, les deux camps sont humains sur ce meme appareil :
      // on garde les deux. En Confluence, on dispose des dix Ordres pour quelques coups
      // chacun : ca ne vaut pas une partie de maitrise, on ne compte rien.
      const mesOrdresJoues = monCampCombos === "red" ? redOrders : monCampCombos === "blue" ? blueOrders : [...blueOrders, ...redOrders];
      const orderKeys = confluenceActive ? [] : mesOrdresJoues.map((l) => l.key);
      // Trophées : UNIQUEMENT en mode Classé. Les parties contre un Écho, les duels locaux,
      // mais aussi "Jouer avec un ami" et le tournoi en ligne ne rapportent ni ne coûtent
      // rien : deux amis pourraient sinon se faire monter mutuellement dans les ligues en
      // se laissant gagner à tour de rôle. Le classement ne compte que les duels appariés.
      // Victoire +30, défaite -15 ; le total ne peut jamais descendre sous 0 (plancher dans
      // recordGameStats). En ligne on peut jouer Azur OU Écarlate, d'où la comparaison avec
      // onlineRole et non avec "blue" : sinon un joueur Écarlate serait crédité à l'envers.
      const trophyGain = partieClassee && onlineRole
        ? (winner === onlineRole ? TROPHEES_VICTOIRE : TROPHEES_DEFAITE)
        : 0;
      // Combos de la partie : ceux reconnus coup par coup, plus le Rempart Vicie qui ne
      // se juge qu'au tableau final. Une partie disqualifiee (annulation) ne compte pas
      // du tout — ni ses combos ni son total.
      const suivi = combosRef.current;
      const compteAuProfil = partieCompteAuProfil && !suivi.disqualifie;
      if (compteAuProfil) {
        comboDeFin({
          mesOrdres: mesOrdresDuJeu(),
          gagne: winner === monCampCombos,
          poison: poisonedCells,
          suivi,
        });
      }
      const comboKeys = compteAuProfil ? [...suivi.reussis] : [];
      recordGameStats(winner, orderKeys, trophyGain, comboKeys, compteAuProfil, monCampCombos).then(setStats);
      // Historique : reserve aux parties CLASSEES pour l'instant. Ce sont les seules
      // dont le resultat engage quelque chose (des trophees) et vaut d'etre relu ; les
      // parties d'entrainement rempliraient la liste sans rien apprendre au joueur.
      if (partieClassee && onlineRole && !testMode) {
        setHistorique(ecrireHistorique({
          t: Date.now(),
          classee: true,
          sb: blueScore, sr: redScore,
          vainqueur: winner,
          camp: onlineRole,
          trophees: trophyGain,
          motif: finMotif || null,
        }));
      }
      // Mode Histoire : une victoire fait avancer la progression du chapitre en cours.
      // Si c'était la dernière partie (Seigneur de Guerre), le chapitre est marqué
      // terminé et le Héraut débloqué, plutôt qu'une simple victoire de plus.
      if (storyChapterKey && winner === "blue") {
        const chapterMeta = STORY_CHAPTERS.find((c) => c.orderKey === storyChapterKey);
        const gameIndex = (storyProgress.chapterWins[storyChapterKey] || 0) + 1;
        if (chapterMeta && gameIndex >= chapterMeta.numGames) {
          setStoryChapterJustCompleted(storyChapterKey);
          completeChapter(storyChapterKey).then(setStoryProgress);
        } else {
          recordChapterWin(storyChapterKey).then(setStoryProgress);
        }
      }
    }
    if (!gameOver) statsRecordedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameOver]);

  // Au chargement de l'appli : est-ce qu'il existe une partie sauvegardée à proposer ?
  useEffect(() => {
    try {
      // Une sauvegarde de partie FINIE (laissee par une version anterieure) ne vaut pas un
      // bouton "Reprendre" : on la jette au lieu de la proposer.
      const brute = sessionStorage.getItem("emprise-save");
      if (brute) {
        let finie = false;
        try { finie = !!JSON.parse(brute).gameOver; } catch (e) { finie = true; }
        if (finie) sessionStorage.removeItem("emprise-save");
        else setHasSavedGame(true);
      }
    } catch (e) { /* stockage indisponible (mode privé, etc.) : tant pis, pas de sauvegarde */ }
  }, []);

  function resumeSavedGame() {
    try {
      const raw = sessionStorage.getItem("emprise-save");
      if (!raw) return;
      const data = JSON.parse(raw);
      // Sauvegarde d'une partie deja finie, laissee par une version anterieure : rien a
      // reprendre, et la reprendre recompterait ses statistiques. On la jette.
      if (data.gameOver) { clearSavedGame(); return; }
      const isConfluence = !!data.confluenceActive;
      setBoard(data.board.map(hydrateFromSave));
      setBlueHand(data.blueHand.map(hydrateFromSave));
      setRedHand(data.redHand.map(hydrateFromSave));
      setPoisonedCells(decoderPoisonPlateau(data.poisonedCells));
      setTurn(data.turn || "blue"); setFirstPlayer(data.firstPlayer || "blue");
      setMode(data.mode || "bot");
      setGameOver(!!data.gameOver);
      setConfluenceActive(isConfluence);
      setBotDifficulty(data.botDifficulty || "intermediaire");
      setBlueOrders(isConfluence ? AVAILABLE_ORDERS : (data.blueOrderKeys || []).map((k) => ORDERS.find((l) => l.key === k)).filter(Boolean));
      setRedOrders(isConfluence ? AVAILABLE_ORDERS : (data.redOrderKeys || []).map((k) => ORDERS.find((l) => l.key === k)).filter(Boolean));
      setHistory([]);
      setHint(null);
      setPhase("play");
    } catch (e) {
      clearSavedGame();
    }
  }

  function clearSavedGame() {
    try { sessionStorage.removeItem("emprise-save"); } catch (e) {}
    setHasSavedGame(false);
  }

  function reset() {
    clearSavedGame();
    oublierPartieEnLigne();
    setHubPage("jouer"); // quitter une partie ramene toujours a la page Jouer du hub
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setBoard(Array(CELLS).fill(null));
    setPoisonedCells(Array(CELLS).fill(false));

    setBlueHand([]); setRedHand([]);
    setBlueOrders([]); setRedOrders([]);
    setPickerChoice([]);
    setHeroChoice(null);
    setMode(null);
    setConfluenceActive(false);
    setDraft({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });
    setTurn("blue"); setFirstPlayer("blue"); setFlashes({}); setBoardShake(false); setBoardShakeBig(false); setGameOver(false);
    setDernierCoup(null); setCeremonieFin(null); setCerPose(false);
    setDrag(null); setDragHoverCell(null);
    setSelected(null);
    resetFanState();
    setHistory([]);
    setAllowUndo(false); setAllowHint(false); setHint(null);
    setTestMode(false); setConfirmQuit(false);
    setStoryChapterKey(null); setStorySecondPick(null); setStoryChapterJustCompleted(null); setTourneyBanPick(null);
    setTourney({ active: false, round: 0, ban: null });
    setOnlineGameId(null); setOnlineRole(null); setJoinCodeInput(""); setOnlineError(""); setAvisBon(false); setOnlineStatus("");
    setFileAttente(false); setCodeCopie(false); dernierCoupDistantRef.current = null;
    setPartieClassee(false); setAreneTest(null); setTrophesPartie(null); setTitresPartie(null);
    // Ce verrou empeche d'enregistrer deux fois la meme partie. Il est baisse par l'effet
    // de fin de partie quand gameOver retombe a faux — mais quitter une partie EN COURS
    // le leve alors que gameOver etait deja faux : l'effet ne se rejouait pas, le verrou
    // restait leve, et la partie SUIVANTE n'etait comptee nulle part (ni trophees, ni
    // historique, ni profil). Deserter deux parties classees de suite ne coutait alors
    // plus rien. On le baisse donc ici, sur le chemin que toute sortie emprunte.
    statsRecordedRef.current = false;
    setVainqueurForce(null); setFinMotif(null); setAttenteAdv(0); forfaitEcritRef.current = false;
    setAdvPresent(false); setAdvPret(false); setAttentePreMatch(0); preForfaitEcritRef.current = false;
    setChatMessages([]); setChatOuvert(false); setChatSaisie(""); setChatNonLus(0);
    chatVusRef.current = 0; chatOuvertRef.current = false;
    setMessageBulle(null); setBulleAvis("");
    clearTimeout(bulleTimerRef.current); clearTimeout(avisTimerRef.current);
    setRevancheVotes(null); revancheCreationRef.current = false;
    setTournoiOnlineId(null); setTournoiData(null); setTournoiErreur(""); setCodeTournoiInput("");
    tournoiLancementRef.current = false; tournoiResultatRef.current = null;
    setPhase("landing");
  }

  // Connexion anonyme Firebase, une fois au chargement — sert d'identifiant stable
  // pour savoir "qui je suis" dans une partie en ligne, sans compte ni mot de passe.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) setMyUid(user.uid);
      else signInAnonymously(auth).catch(() => setOnlineError("Connexion impossible. Vérifiez votre réseau."));
    });
    return unsub;
  }, []);

  // ---------- Reconnexion à une partie en ligne ----------
  // Le problème réglé ici : sur téléphone, verrouiller l'écran ou changer d'application
  // suffit à faire recharger la page. onlineGameId et onlineRole vivaient uniquement en
  // mémoire React, donc la partie devenait injoignable — l'adversaire restait à attendre
  // un coup qui ne viendrait jamais. On garde donc de quoi la retrouver.
  // localStorage et pas sessionStorage (utilisé par la sauvegarde des parties solo) :
  // sessionStorage est vidé dès que l'onglet se ferme, ce qui ne couvre pas le cas le
  // plus fréquent, l'application chassée de la mémoire par le téléphone.
  const CLE_PARTIE_EN_LIGNE = "emprise-partie-en-ligne";

  function oublierPartieEnLigne() {
    try { localStorage.removeItem(CLE_PARTIE_EN_LIGNE); } catch (e) { /* stockage indisponible */ }
  }

  // Au demarrage, on purge ce qu'une version precedente aurait laisse : la reprise en
  // ligne n'existe plus, ces cles n'ont plus d'usage et ne doivent pas trainer.
  useEffect(() => {
    if (repriseTesteeRef.current) return;
    repriseTesteeRef.current = true;
    try {
      localStorage.removeItem(CLE_PARTIE_EN_LIGNE);
      localStorage.removeItem(CLE_TOURNOI);
    } catch (e) { /* stockage indisponible : rien a purger */ }
  }, []);

  // ---------- Tournoi en ligne ----------
  // Huit vrais joueurs, un code à partager, et le même arbre que le tournoi solo.
  // Un document "tournaments/{code}" porte la liste des inscrits (l'ordre d'arrivée fait
  // les sièges) puis les matchs de chaque tour. Les parties d'un tournoi sont des parties
  // en ligne ordinaires dont l'identifiant est DÉTERMINISTE ("{code}-QF0"...) : aucune
  // collision possible puisque le code du tournoi est déjà unique, et aucun tirage à
  // vérifier au moment de créer un tour complet dans une seule transaction.
  const CLE_TOURNOI = "emprise-tournoi-en-ligne";

  function nouvellePartieDeTournoi(aUid, bUid, matchKey) {
    const premier = tirerPremierJoueur();
    return {
      status: "waiting-orders", createdAt: serverTimestamp(),
      blueUid: aUid, redUid: bUid,
      blueOrderKeys: null, redOrderKeys: null, blueHand: null, redHand: null,
      board: Array(CELLS).fill(null), poisonedCells: Array(CELLS).fill(""),
      turn: premier, firstPlayer: premier, gameOver: false,
      tournoiId: tournoiOnlineId, matchKey,
    };
  }

  async function creerTournoiEnLigne() {
    if (!myUid) { setTournoiErreur("Connexion en cours, réessayez dans un instant."); return; }
    setTournoiErreur("");
    try {
      let code = null;
      for (let essai = 0; essai < 5 && !code; essai++) {
        const candidat = makeGameCode();
        try {
          await runTransaction(db, async (tx) => {
            const ref = doc(db, "tournaments", candidat);
            const snap = await tx.get(ref);
            if (snap.exists()) throw new Error("code-pris");
            tx.set(ref, {
              createdAt: serverTimestamp(), status: "waiting",
              joueurs: [myUid], matches: {}, champion: null,
            });
          });
          code = candidat;
        } catch (e) { if (e.message !== "code-pris") throw e; }
      }
      if (!code) { setTournoiErreur("Impossible de trouver un code libre. Réessayez."); return; }
      setTournoiOnlineId(code);
      setPhase("tourney-online");
    } catch (e) {
      setTournoiErreur("Impossible de créer le tournoi. Vérifiez votre connexion.");
    }
  }

  async function rejoindreTournoiEnLigne() {
    if (!myUid) { setTournoiErreur("Connexion en cours, réessayez dans un instant."); return; }
    const code = codeTournoiInput.trim().toUpperCase();
    if (!code) return;
    setTournoiErreur("");
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "tournaments", code);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("introuvable");
        const t = snap.data();
        const joueurs = t.joueurs || [];
        if (joueurs.includes(myUid)) return; // déjà inscrit : on entre simplement
        if (t.status !== "waiting") throw new Error("commence");
        if (joueurs.length >= 8) throw new Error("complet");
        tx.update(ref, { joueurs: [...joueurs, myUid] });
      });
      setTournoiOnlineId(code);
      setPhase("tourney-online");
    } catch (e) {
      if (e.message === "introuvable") setTournoiErreur("Code introuvable.");
      else if (e.message === "commence") setTournoiErreur("Ce tournoi a déjà commencé.");
      else if (e.message === "complet") setTournoiErreur("Ce tournoi est déjà complet (8 Commandants).");
      else setTournoiErreur("Impossible de rejoindre. Vérifiez le code et votre connexion.");
    }
  }

  // Quitter la salle d'attente (avant le lancement) : on libère son siège, sinon le
  // tournoi resterait bloqué à attendre un huitième joueur parti depuis longtemps.
  async function quitterSalleTournoi() {
    const id = tournoiOnlineId;
    setTournoiOnlineId(null); setTournoiData(null);
    try { localStorage.removeItem(CLE_TOURNOI); } catch (e) { /* rien */ }
    if (!id || !myUid) return;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "tournaments", id);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const t = snap.data();
        if (t.status !== "waiting") return; // trop tard pour se retirer proprement
        tx.update(ref, { joueurs: (t.joueurs || []).filter((u) => u !== myUid) });
      });
    } catch (e) { /* le siège restera occupé : le tournoi ne pourra pas se lancer, dommage */ }
  }

  // Lancement des quarts de finale, par N'IMPORTE QUEL client qui constate 8 inscrits :
  // aucune dépendance à un "hôte" qui pourrait être parti. La transaction est idempotente
  // (elle re-vérifie le statut), donc deux clients simultanés ne créent rien en double.
  async function lancerQuartsDeFinale() {
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "tournaments", tournoiOnlineId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const t = snap.data();
        if (t.status !== "waiting" || (t.joueurs || []).length !== 8) return;
        const matches = {};
        for (let k = 0; k < 4; k++) {
          const a = t.joueurs[k * 2], b = t.joueurs[k * 2 + 1];
          // Suffixe aléatoire : un identifiant entièrement prévisible pouvait être
          // pré-créé par un tiers dans games/, ce qui faisait échouer la transaction à
          // jamais (mise à jour refusée par les règles, suppression interdite) et gelait
          // le tournoi. L'identifiant qui fait foi est celui stocké dans matches.
          const gameId = `${tournoiOnlineId}-QF${k}-${Math.random().toString(36).slice(2, 8)}`;
          tx.set(doc(db, "games", gameId), nouvellePartieDeTournoi(a, b, `qf${k}`));
          matches[`qf${k}`] = { a, b, gameId, vainqueur: null };
        }
        tx.update(ref, { status: "running", matches });
      });
    } catch (e) { /* un autre client y arrivera */ }
  }

  // Écrit le résultat d'un match, et si le tour est alors complet, crée le tour suivant
  // dans la MÊME transaction — le client qui dépose le dernier résultat ouvre le tour
  // d'après, quel qu'il soit. Les deux joueurs d'un match tentent l'écriture : le second
  // trouve le vainqueur déjà posé et repart sans rien faire.
  async function ecrireResultatTournoi(gameId, campVainqueur) {
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "tournaments", tournoiOnlineId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const t = snap.data();
        const cles = Object.keys(t.matches || {});
        const cle = cles.find((k) => t.matches[k].gameId === gameId);
        if (!cle) return;
        const m = t.matches[cle];
        if (m.vainqueur) return;
        const vainqueurUid = campVainqueur === "blue" ? m.a : m.b;
        const matches = { ...t.matches, [cle]: { ...m, vainqueur: vainqueurUid } };
        const majs = { matches };
        const v = (k) => matches[k] && matches[k].vainqueur;
        if (cle.startsWith("qf") && v("qf0") && v("qf1") && v("qf2") && v("qf3") && !matches.sf0) {
          const sf0 = { a: v("qf0"), b: v("qf1"), gameId: `${tournoiOnlineId}-SF0-${Math.random().toString(36).slice(2, 8)}`, vainqueur: null };
          const sf1 = { a: v("qf2"), b: v("qf3"), gameId: `${tournoiOnlineId}-SF1-${Math.random().toString(36).slice(2, 8)}`, vainqueur: null };
          tx.set(doc(db, "games", sf0.gameId), nouvellePartieDeTournoi(sf0.a, sf0.b, "sf0"));
          tx.set(doc(db, "games", sf1.gameId), nouvellePartieDeTournoi(sf1.a, sf1.b, "sf1"));
          matches.sf0 = sf0; matches.sf1 = sf1;
        } else if (cle.startsWith("sf") && v("sf0") && v("sf1") && !matches.f0) {
          const f0 = { a: v("sf0"), b: v("sf1"), gameId: `${tournoiOnlineId}-F0-${Math.random().toString(36).slice(2, 8)}`, vainqueur: null };
          tx.set(doc(db, "games", f0.gameId), nouvellePartieDeTournoi(f0.a, f0.b, "f0"));
          matches.f0 = f0;
        } else if (cle === "f0") {
          majs.champion = vainqueurUid;
          majs.status = "done";
        }
        tx.update(ref, majs);
      });
    } catch (e) {
      tournoiResultatRef.current = null; // l'autre client (ou une reprise) réessaiera
    }
  }

  // Mon prochain match encore à jouer, s'il existe.
  function monMatchEnAttente() {
    if (!tournoiData || !tournoiData.matches || !myUid) return null;
    for (const k of ["qf0", "qf1", "qf2", "qf3", "sf0", "sf1", "f0"]) {
      const m = tournoiData.matches[k];
      if (m && !m.vainqueur && (m.a === myUid || m.b === myUid)) return { cle: k, ...m };
    }
    return null;
  }

  function jouerMatchTournoi() {
    const m = monMatchEnAttente();
    if (!m) return;
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setConfluenceActive(false); setTestMode(false); setPickerChoice([]);
    dernierCoupDistantRef.current = null;
    chatVusRef.current = 0;
    setChatMessages([]); setChatNonLus(0); setChatOuvert(false); chatOuvertRef.current = false;
    setVainqueurForce(null); setFinMotif(null);
    setBoard(Array(CELLS).fill(null)); setPoisonedCells(Array(CELLS).fill(false));
    setBlueHand([]); setRedHand([]);
    setGameOver(false);
    tournoiResultatRef.current = null;
    setPartieClassee(false);
    setOnlineGameId(m.gameId);
    setOnlineRole(m.a === myUid ? "blue" : "red");
    setMode("online");
    setOnlineError("");
    setPhase("select-blue");
  }

  // Écoute du tournoi : liste des inscrits, matchs, résultats. C'est aussi ici que le
  // lancement se déclenche dès que la salle est pleine.
  useEffect(() => {
    if (!tournoiOnlineId) return;
    const unsub = onSnapshot(doc(db, "tournaments", tournoiOnlineId), (snap) => {
      if (!snap.exists()) { setTournoiErreur("Ce tournoi n'existe plus."); return; }
      const t = snap.data();
      setTournoiData(t);
      setTournoiErreur("");
      if (t.status === "waiting" && (t.joueurs || []).length === 8 && !tournoiLancementRef.current) {
        tournoiLancementRef.current = true;
        lancerQuartsDeFinale().finally(() => { tournoiLancementRef.current = false; });
      }
    }, () => setTournoiErreur("Connexion au tournoi interrompue."));
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournoiOnlineId]);

  // Dépôt du résultat de MON match dès qu'il se termine (victoire comme défaite : les
  // deux clients tentent, le premier gagne, l'autre ne fait rien).
  useEffect(() => {
    if (!gameOver || mode !== "online" || !tournoiOnlineId || !onlineGameId || !winner) return;
    if (tournoiResultatRef.current === onlineGameId) return;
    tournoiResultatRef.current = onlineGameId;
    ecrireResultatTournoi(onlineGameId, winner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameOver, winner, tournoiOnlineId, onlineGameId, mode]);

  async function createOnlineGame() {
    statsRecordedRef.current = false;
    if (!myUid) { setOnlineError("Connexion en cours, réessayez dans un instant."); return; }
    setOnlineError("");
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    const premierEnLigne = tirerPremierJoueur();
    const nouvellePartie = {
      status: "waiting-orders",
      createdAt: serverTimestamp(),
      blueUid: myUid,
      redUid: null,
      blueOrderKeys: null,
      redOrderKeys: null,
      blueHand: null,
      redHand: null,
      board: Array(CELLS).fill(null),
      poisonedCells: Array(CELLS).fill(""),
      turn: premierEnLigne, firstPlayer: premierEnLigne, // tiré une seule fois par l'hôte : l'autre client lira cette valeur
      gameOver: false,
    };
    // Un code tiré au hasard peut retomber sur une partie déjà existante : on crée dans
    // une transaction qui échoue si le document existe, et on retire un autre code —
    // sinon un setDoc écraserait purement et simplement la partie en cours de deux
    // autres joueurs, qui se retrouveraient plateau vide en pleine partie.
    let code = null;
    try {
      for (let essai = 0; essai < 5 && !code; essai++) {
        const candidat = makeGameCode();
        try {
          await runTransaction(db, async (tx) => {
            const ref = doc(db, "games", candidat);
            const snap = await tx.get(ref);
            if (snap.exists()) throw new Error("code-pris");
            tx.set(ref, nouvellePartie);
          });
          code = candidat;
        } catch (e) {
          if (e.message !== "code-pris") throw e;
        }
      }
      if (!code) { setOnlineError("Impossible de trouver un code libre. Réessayez."); return; }
      setOnlineGameId(code);
      setOnlineRole("blue");
      setMode("online");
      setConfluenceActive(false);
      setTestMode(false);
      setPickerChoice([]);
      setPhase("select-blue");
    } catch (e) {
      setOnlineError("Impossible de créer la partie. Vérifiez la configuration Firebase.");
    }
  }

  async function joinOnlineGame() {
    statsRecordedRef.current = false;
    if (!myUid) { setOnlineError("Connexion en cours, réessayez dans un instant."); return; }
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) return;
    setOnlineError("");
    try {
      // Lecture + prise de la place Rouge dans une seule transaction : avec un getDoc
      // suivi d'un updateDoc, deux joueurs qui rejoignent en même temps lisent tous les
      // deux "place libre" et s'écrasent l'un l'autre — le perdant croit jouer alors que
      // la partie ne lui appartient plus.
      const ref = doc(db, "games", code);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("introuvable");
        const data = snap.data();
        if (data.redUid && data.redUid !== myUid) throw new Error("complet");
        if (!data.redUid) tx.update(ref, { redUid: myUid });
      });
      setBoardSize(STANDARD_ROWS, STANDARD_COLS);
      setOnlineGameId(code);
      setOnlineRole("red");
      setMode("online");
      setConfluenceActive(false);
      setTestMode(false);
      setPickerChoice([]);
      setPhase("select-blue"); // écran de sélection des Ordres, réutilisé par les deux rôles en ligne
    } catch (e) {
      if (e.message === "introuvable") setOnlineError("Code introuvable.");
      else if (e.message === "complet") setOnlineError("Cette partie a déjà 2 Commandants.");
      else setOnlineError("Impossible de rejoindre. Vérifiez le code et votre connexion.");
    }
  }

  // Écoute en temps réel la partie en ligne : dès que Firestore change (mon propre
  // coup ou celui de l'adversaire), l'état local est remis à jour en conséquence.
  // NB : les mains ET le plateau transitent en clair par Firestore (portrait retiré via
  // stripForSave/hydrateFromSave, comme la sauvegarde locale) — un joueur techniquement
  // curieux pourrait inspecter le réseau et voir les cartes de l'adversaire à l'avance.
  // Acceptable pour jouer entre amis de confiance ; une vraie dissimulation nécessiterait
  // de déplacer la résolution des coups vers une Cloud Function côté serveur.
  useEffect(() => {
    if (mode !== "online" || !onlineGameId) return;
    const ref = doc(db, "games", onlineGameId);
    const unsub = onSnapshot(ref, (snap) => {
      if (!snap.exists()) { setOnlineError("La partie a été fermée."); return; }
      const data = snap.data();

      // Fin par abandon ou forfait : le champ abandonPar désigne le camp fautif, l'autre
      // gagne. Dérivé À CHAQUE notification (et pas posé une fois) pour rester idempotent :
      // un message de chat ou une revanche re-déclenchent l'écouteur sans rien casser.
      // Un abandon n'est valable que si la partie n'était PAS déjà finie sur le plateau :
      // sans ce garde, un forfait écrit dans la même seconde que le dernier coup gagnant
      // (ou après coup, par un client trafiqué) inverserait le vainqueur au score des
      // deux côtés. Les écritures d'abandon ne posent jamais gameOver : un document
      // portant les deux à la fois est forcément une fin réelle suivie d'un abandon tardif.
      const finForcee = (data.abandonPar === "blue" || data.abandonPar === "red") && !data.gameOver;
      setVainqueurForce(finForcee ? (data.abandonPar === "blue" ? "red" : "blue") : null);
      setFinMotif(finForcee ? (data.finMotif || "abandon") : null);

      // Messages en direct : la liste vit dans le document, chaque appareil l'affiche.
      // Le compteur de non-lus ne monte que pour les messages ADVERSES arrivés panneau fermé.
      const messages = data.chat || [];
      if (chatGameIdRef.current !== onlineGameId) {
        // Première notification pour CETTE partie : l'historique déjà présent (reprise
        // après rechargement) est affiché mais pas compté comme non-lu.
        chatGameIdRef.current = onlineGameId;
        chatVusRef.current = messages.length;
      }
      if (messages.length > chatVusRef.current) {
        const arrivants = messages.slice(chatVusRef.current);
        const nouveaux = arrivants.filter((m) => m.by !== onlineRole);
        setChatNonLus((n) => (chatOuvertRef.current ? 0 : n + nouveaux.length));
        // Affichage direct : le dernier message arrive s'affiche quelques secondes
        // par-dessus le plateau, sans qu'on ait a ouvrir le panneau. Inutile si le
        // panneau est deja ouvert, il y figure deja.
        const dernier = arrivants[arrivants.length - 1];
        if (dernier && !chatOuvertRef.current && messagesDirectsRef.current) {
          setMessageBulle(dernier);
          clearTimeout(bulleTimerRef.current);
          bulleTimerRef.current = setTimeout(() => setMessageBulle(null), 6000);
        }
      }
      chatVusRef.current = messages.length;
      setChatMessages(messages);

      // Revanche (ami uniquement) : votes partagés via le document. Quand les deux camps
      // ont voté, c'est le client AZUR qui crée la partie suivante (un seul créateur,
      // déterministe) ; les deux clients basculent dès que son code apparaît.
      setRevancheVotes(data.revanche || null);
      if (data.revanche && data.revanche.prochainCode) {
        basculerVersRevanche(data.revanche.prochainCode);
        return;
      }
      if (data.revanche && data.revanche.blue && data.revanche.red
          && !data.revanche.prochainCode && onlineRole === "blue" && !revancheCreationRef.current) {
        revancheCreationRef.current = true;
        creerPartieDeRevanche(data);
      }

      if (data.blueOrderKeys && data.redOrderKeys && data.blueHand && data.redHand) {
        setBlueOrders(data.blueOrderKeys.map((k) => ORDERS.find((l) => l.key === k)).filter(Boolean));
        setRedOrders(data.redOrderKeys.map((k) => ORDERS.find((l) => l.key === k)).filter(Boolean));
        setBlueHand(data.blueHand.map(hydrateFromSave));
        setRedHand(data.redHand.map(hydrateFromSave));
        setBoard(data.board.map(hydrateFromSave));
        setPoisonedCells(decoderPoisonPlateau(data.poisonedCells));
        setTurn(data.turn); setFirstPlayer(data.firstPlayer || "blue");
        setTrophesPartie({ blue: data.blueTrophees, red: data.redTrophees });
        setTitresPartie({ blue: data.blueTitre || "", red: data.redTitre || "" });
        setGameOver(!!data.gameOver || finForcee);
        setOnlineError("");
        setOnlineStatus("");
        setPhase((p) => (p === "play" ? p : "play"));
        repriseRef.current = false; // reprise aboutie : la partie est retrouvée

        // Coup de l'adversaire : on rejoue chez nous les animations qu'il a vues (chute
        // de la carte, captures, retournements, brume empoisonnée). Sans ça le plateau
        // changeait d'un seul coup, sans qu'on comprenne ce qui venait de se passer.
        // Un coup n'est animé qu'une fois (dernierCoupDistantRef) et jamais le nôtre,
        // déjà animé localement au moment où on l'a joué.
        const coupDistant = data.lastMove;
        if (coupDistant && coupDistant.by && coupDistant.by !== onlineRole
            && coupDistant.id !== dernierCoupDistantRef.current) {
          dernierCoupDistantRef.current = coupDistant.id;
          setDernierCoup(coupDistant.position);
          flashEvents([{ index: coupDistant.position, kind: "place" }, ...(coupDistant.events || [])]);
          if (coupDistant.freshPoison && coupDistant.freshPoison.length) {
            setJustPoisoned(coupDistant.freshPoison);
            clearTimeout(poisonTimerRef.current);
            poisonTimerRef.current = setTimeout(() => setJustPoisoned([]), 1500);
          }
        }
      } else {
        // L'adversaire est parti avant même que la partie ne démarre. En Classé cela vaut
        // victoire : il y avait bien un duel engagé, et le laisser partir sans rien coûter
        // ni rien rapporter invitait à quitter dès qu'un adversaire déplaisait.
        if (finForcee) {
          if (tournoiOnlineId) {
            // Match de tournoi : l'abandon adverse nous donne la victoire du match.
            if (tournoiResultatRef.current !== onlineGameId) {
              tournoiResultatRef.current = onlineGameId;
              ecrireResultatTournoi(onlineGameId, onlineRole);
            }
            retournerAuTournoi();
            return;
          }
          // On lit le Classé sur le DOCUMENT et non sur l'état React : cet écouteur ne se
          // réabonne qu'au changement de partie, sa fermeture garderait donc une valeur
          // périmée de partieClassee. Le document, lui, dit la vérité de cette partie-là.
          const venaitDuClasse = !!data.appariement;
          const parForfait = data.finMotif === "forfait";
          // La victoire du camp resté. Le verrou est indispensable : cet écouteur se
          // déclenche à CHAQUE écriture du document, il compterait sinon plusieurs fois.
          // Les Ordres viennent eux aussi du document, jamais de l'état React, pour la
          // même raison de fermeture périmée.
          if (venaitDuClasse && !statsRecordedRef.current) {
            statsRecordedRef.current = true;
            const mesOrdres = (onlineRole === "red" ? data.redOrderKeys : data.blueOrderKeys) || [];
            recordGameStats(onlineRole, mesOrdres, TROPHEES_VICTOIRE, [], false, onlineRole).then(setStats);
            setHistorique(ecrireHistorique({
              t: Date.now(), classee: true, sb: 0, sr: 0,
              vainqueur: onlineRole, camp: onlineRole,
              trophees: TROPHEES_VICTOIRE, motif: parForfait ? "forfait" : "abandon",
            }));
          }
          setOnlineGameId(null); setOnlineRole(null); setOnlineStatus("");
          // Sans cette purge, le vainqueur forcé qu'on vient de dériver survivait au
          // retour au menu et s'imposait à TOUTES les parties suivantes, solo comprises.
          setVainqueurForce(null); setFinMotif(null);
          setPartieClassee(false);
          oublierPartieEnLigne();
          setAvisBon(venaitDuClasse);
          setOnlineError(
            venaitDuClasse
              ? `${parForfait ? "L'adversaire ne s'est pas présenté" : "L'adversaire a quitté"} : victoire, +${TROPHEES_VICTOIRE} trophées.`
              : "L'adversaire a quitté avant le début de la partie."
          );
          setPickerChoice([]);
          if (venaitDuClasse) { setMode(null); setPhase("landing"); }
          else setPhase("online-menu");
          return;
        }
        const iAmReady = onlineRole === "blue" ? !!data.blueOrderKeys : !!data.redOrderKeys;
        setAdvPresent(!!(data.blueUid && data.redUid));
        setAdvPret(onlineRole === "blue" ? !!data.redOrderKeys : !!data.blueOrderKeys);
        // Reprise alors que la partie n'avait pas encore démarré : si mes Ordres
        // n'étaient pas choisis, il faut revenir à l'écran de choix. Sans ça le joueur
        // resterait indéfiniment sur un écran d'attente que rien ne peut débloquer,
        // puisque c'est lui qu'on attend.
        if (repriseRef.current && !iAmReady) {
          repriseRef.current = false;
          setOnlineStatus("");
          setPhase("select-blue");
          return;
        }
        repriseRef.current = false;
        setOnlineStatus(iAmReady ? "En attente que l'adversaire choisisse ses Ordres..." : "");
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, onlineGameId]);

  // Applique la sélection d'Ordres du joueur en ligne : écrit sa main dans Firestore
  // (le document commun), puis attend que l'adversaire ait fait de même — c'est
  // l'écouteur onSnapshot ci-dessus qui bascule les deux joueurs en jeu dès que les
  // deux mains sont prêtes.
  async function confirmOnlineOrders(picked) {
    const chosen = picked || pickerChoice;
    if (chosen.length !== 2 || !onlineGameId) return;
    const hand = makeHand(chosen[0], chosen[1]);
    const field = onlineRole === "blue"
      ? { blueOrderKeys: chosen.map((l) => l.key), blueHand: hand.map(stripForSave) }
      : { redOrderKeys: chosen.map((l) => l.key), redHand: hand.map(stripForSave) };
    try {
      await updateDoc(doc(db, "games", onlineGameId), field);
      setPickerChoice([]);
      setOnlineStatus("En attente que l'adversaire choisisse ses Ordres...");
      // Si l'adversaire avait déjà choisi ses Ordres, l'écouteur onSnapshot a basculé en
      // "play" PENDANT l'await ci-dessus : Firestore déclenche l'écouteur dès l'écriture
      // locale, avant que la promesse ne se résolve. Forcer "online-waiting" ici renvoyait
      // donc le deuxième joueur à choisir sur l'écran d'attente alors que la partie avait
      // démarré — et définitivement si c'était son tour de jouer, puisque plus personne ne
      // pouvait toucher au document pour le réveiller.
      setPhase((p) => (p === "play" ? p : "online-waiting"));
    } catch (e) {
      setOnlineError("Impossible d'enregistrer vos Ordres.");
    }
  }

  // ---------- Appariement automatique (matchmaking) ----------
  // Un unique document "matchmaking/lobby" sert de salle d'attente : le premier joueur
  // s'y inscrit, le suivant l'y trouve, crée la partie et l'y annonce. Une seule place
  // d'attente à la fois — donc aucun index Firestore à créer, aucune file à purger, et
  // un appariement impossible à dédoubler puisque tout passe par une transaction sur ce
  // document unique. Ce choix tient tant que deux joueurs cherchent rarement en même
  // temps ; avec une vraie base de joueurs, il faudra passer à une file (un document par
  // joueur en attente + requête). C'est aussi là que l'ELO se greffera le jour venu :
  // au lieu de prendre le premier venu, on filtrera sur une fourchette de score.
  const ATTENTE_PERIMEE_MS = 60000; // au-delà, l'inscription est considérée abandonnée

  async function chercherAdversaire() {
    if (!myUid) { setOnlineError("Connexion en cours, réessayez dans un instant."); return; }
    setOnlineError("");
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setConfluenceActive(false);
    setTestMode(false);
    setPickerChoice([]);
    setMode("online");
    setFileAttente(true);
    statsRecordedRef.current = false;
    setOrdreAttente(AVAILABLE_ORDERS[Math.floor(Math.random() * AVAILABLE_ORDERS.length)]);
    setOnlineStatus("Recherche d'un adversaire...");
    setPhase("online-waiting");
    try {
      const lobbyRef = doc(db, "matchmaking", "lobby");
      const apparie = await runTransaction(db, async (tx) => {
        const lobbySnap = await tx.get(lobbyRef);
        const lobby = lobbySnap.exists() ? lobbySnap.data() : {};
        const attenteValide = !!lobby.waitingUid && lobby.waitingUid !== myUid
          && !!lobby.waitingAt && (Date.now() - lobby.waitingAt) < ATTENTE_PERIMEE_MS;
        if (!attenteValide) {
          // Personne (ou une inscription abandonnée) : je prends la place et j'attends.
          // On efface AU PASSAGE un appariement qui m'était adressé : ces champs n'étaient
          // jamais nettoyés une fois consommés, si bien qu'en revenant en file je me
          // faisais aussitôt renvoyer dans la partie précédente, souvent déjà terminée —
          // impossible de lancer une nouvelle partie classée.
          const monAncienMatch = lobby.matchedUid === myUid;
          tx.set(lobbyRef, {
            waitingUid: myUid, waitingAt: Date.now(),
            // Mes trophees voyagent avec l'inscription : celui qui creera la partie les
            // recopiera dans le document, et les DEUX ecrans afficheront les memes chiffres.
            waitingTrophees: stats.trophies || 0,
            // Le titre suit le meme chemin que les trophees : recopie dans le document de
            // la partie, il s'affiche a l'identique sur les deux ecrans.
            waitingTitre: titrePrincipal(stats) || "",
            ...(monAncienMatch ? { matchedUid: null, matchedGameId: null, matchedAt: null } : {}),
          }, { merge: true });
          return null;
        }
        // Quelqu'un attend : je crée la partie et je la lui annonce. Firestore impose que
        // TOUS les tx.get() précèdent les tx.set(), d'où les codes candidats tirés ici.
        let code = null;
        for (let essai = 0; essai < 3 && !code; essai++) {
          const candidat = makeGameCode();
          const dejaPris = await tx.get(doc(db, "games", candidat));
          if (!dejaPris.exists()) code = candidat;
        }
        if (!code) throw new Error("code-indisponible");
        const premier = tirerPremierJoueur();
        tx.set(doc(db, "games", code), {
          status: "waiting-orders",
          createdAt: serverTimestamp(),
          blueUid: lobby.waitingUid, // celui qui attendait joue Azur
          redUid: myUid,
          blueOrderKeys: null, redOrderKeys: null, blueHand: null, redHand: null,
          board: Array(CELLS).fill(null),
          poisonedCells: Array(CELLS).fill(""),
          turn: premier, firstPlayer: premier,
          gameOver: false,
          appariement: true, // partie née d'un appariement, pas d'un code partagé
          // Trophees des deux camps au moment de l'appariement : la seule source que les
          // deux ecrans peuvent lire a l'identique. Avant, chaque client affichait ses
          // propres trophees pour lui et 0 pour l'autre, et les deux ecrans se
          // contredisaient sur le meme joueur.
          blueTrophees: lobby.waitingTrophees || 0,
          redTrophees: stats.trophies || 0,
          blueTitre: lobby.waitingTitre || "",
          redTitre: titrePrincipal(stats) || "",
        });
        tx.set(lobbyRef, {
          waitingUid: null, waitingAt: null,
          matchedUid: lobby.waitingUid, matchedGameId: code, matchedAt: Date.now(),
        }, { merge: true });
        return { code };
      });
      if (apparie) {
        // L'appariement a eu lieu : la partie existe et l'adversaire y est deja annonce.
        // On reaffirme le mode, car un Retour appuye PENDANT la transaction l'a peut-etre
        // remis a null — on serait alors entre dans la partie sans que l'ecouteur, qui
        // depend de mode, ne s'y abonne : plateau fige, adversaire seul en face.
        setMode("online");
        setFileAttente(false);
        setOnlineStatus("");
        setOnlineGameId(apparie.code);
        setOnlineRole("red");
        setPartieClassee(true);
        setPhase("select-blue");
      }
    } catch (e) {
      setFileAttente(false);
      setOnlineStatus("");
      setMode(null);
      setOnlineError("Recherche impossible. Vérifiez votre connexion.");
      // La recherche ne part que du bouton Classé : en cas d'échec on rend le joueur au
      // hub, jamais à l'écran des codes d'ami où il n'a rien à faire.
      setPhase("landing");
    }
  }

  // Quitter une partie en ligne EN COURS : c'est un abandon. Le document le signale à
  // l'adversaire, qui remporte la victoire (son écouteur affiche la cérémonie). En Classé,
  // la défaite est comptée AVANT de partir : abandonner ne doit pas permettre d'esquiver
  // les -15 trophées. Le quitteur, lui, revient simplement au menu — il a choisi de partir,
  // pas besoin de lui rejouer sa défaite.
  // Départ AVANT le début de la partie (écran d'attente ou choix des Ordres) : sans ce
  // signal, l'adversaire resterait indéfiniment à attendre qu'on choisisse nos Ordres.
  // En tournoi, partir c'est perdre le match : le résultat est déposé dans la foulée et
  // on revient à l'arbre en éliminé, le tournoi continue sans nous.
  // Écriture d'un abandon/forfait sous transaction : on relit le document et on ne
  // scelle l'issue QUE si elle ne l'est pas déjà (ni gameOver, ni abandon antérieur),
  // et que la précondition du moment tient toujours (le fautif n'a pas joué entre-temps,
  // ses Ordres sont toujours manquants...). Un updateDoc aveugle pouvait inverser le
  // résultat d'une partie gagnée sur le fil — et une transaction ne part jamais d'une
  // file d'écritures hors-ligne, ce qui évite un forfait fantôme au retour du réseau.
  // Renvoie false uniquement sur erreur (réseau) : issue déjà scellée = true, rien à refaire.
  async function deposerAbandon(gameId, fautif, motif, encoreValable) {
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "games", gameId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const d = snap.data();
        if (d.gameOver || d.abandonPar) return;
        if (encoreValable && !encoreValable(d)) return;
        tx.update(ref, { abandonPar: fautif, finMotif: motif });
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function abandonnerAvantDebut() {
    if (onlineGameId) {
      deposerAbandon(onlineGameId, onlineRole, "abandon", null);
      // Partir APRES avoir ete apparie est une defaite : un adversaire est en face et
      // attend. Seule la recherche se quitte sans rien devoir — goBack la traite avant
      // d'arriver ici, on ne peut donc pas etre penalise pour avoir renonce a chercher.
      // Le verrou evite de compter deux fois si l'ecouteur repasse par la.
      if (partieClassee && !statsRecordedRef.current) {
        statsRecordedRef.current = true;
        const mesOrdres = (onlineRole === "red" ? redOrders : blueOrders).map((l) => l.key);
        const vainqueur = onlineRole === "blue" ? "red" : "blue";
        recordGameStats(vainqueur, mesOrdres, TROPHEES_DEFAITE, [], false, onlineRole).then(setStats);
        setHistorique(ecrireHistorique({
          t: Date.now(), classee: true, sb: 0, sr: 0,
          vainqueur, camp: onlineRole, trophees: TROPHEES_DEFAITE, motif: "abandon",
        }));
      }
      if (tournoiOnlineId) {
        tournoiResultatRef.current = onlineGameId;
        ecrireResultatTournoi(onlineGameId, onlineRole === "blue" ? "red" : "blue");
      }
    }
    setOnlineGameId(null); setOnlineRole(null); setOnlineStatus(""); setOnlineError("");
    setPickerChoice([]);
    oublierPartieEnLigne();
    // On revient d'où l'on venait. Un joueur Classé n'est jamais passé par l'écran des
    // codes de partie : il a appuyé sur Classé depuis le hub, et l'y renvoyer lui
    // demandait un code d'ami qu'il n'a pas. Le drapeau du Classé est levé au passage,
    // sans quoi la partie entre amis lancée juste après aurait compté des trophées.
    const venaitDuClasse = partieClassee;
    setPartieClassee(false);
    if (tournoiOnlineId) setPhase("tourney-online");
    else if (venaitDuClasse) { setMode(null); setPhase("landing"); }
    else setPhase("online-menu");
  }

  function quitterPartieEnLigne() {
    if (onlineGameId && !gameOver) {
      deposerAbandon(onlineGameId, onlineRole, "abandon", null);
      if (partieClassee && !statsRecordedRef.current) {
        statsRecordedRef.current = true;
        // Un abandon compte comme une partie jouee avec SES Ordres, pas ceux d'en face.
        const orderKeys = (onlineRole === "red" ? redOrders : blueOrders).map((l) => l.key);
        recordGameStats(onlineRole === "blue" ? "red" : "blue", orderKeys, TROPHEES_DEFAITE, [], false, onlineRole).then(setStats);
      }
    }
    // Match de tournoi : abandonner la partie ne fait pas quitter le TOURNOI — on
    // revient à l'arbre en éliminé. Le résultat est déposé par NOUS aussi (pas seulement
    // par le client adverse) : si l'adversaire est hors ligne à cet instant, l'arbre
    // resterait sinon bloqué en attendant un dépôt qui ne viendrait jamais.
    if (tournoiOnlineId) {
      if (onlineGameId && tournoiResultatRef.current !== onlineGameId) {
        tournoiResultatRef.current = onlineGameId;
        ecrireResultatTournoi(onlineGameId, onlineRole === "blue" ? "red" : "blue");
      }
      setConfirmQuit(false); retournerAuTournoi(); return;
    }
    reset();
  }

  // Envoi d'un message en direct. Contraintes volontairement simples : 200 caractères,
  // au plus un message par seconde, et rien d'autre — une partie dure 16 coups, la liste
  // reste courte. Le texte est affiché tel quel côté React (échappé par construction).
  function envoyerMessage() {
    const texte = chatSaisie.trim().slice(0, 200);
    if (!texte || !onlineGameId || !onlineRole) return;
    const maintenant = Date.now();
    if (maintenant - chatDernierEnvoiRef.current < 1000) return;
    chatDernierEnvoiRef.current = maintenant;
    setChatSaisie("");
    const nouveau = { id: `${maintenant}-${Math.random().toString(36).slice(2, 6)}`, by: onlineRole, texte, t: maintenant };
    // Fenêtre glissante : au-delà de 60 messages on réécrit la liste tronquée au lieu
    // d'empiler par arrayUnion — le document Firestore est plafonné à 1 Mo, et le
    // dépasser rendrait la partie injouable (chaque coup serait refusé à l'écriture).
    const maj = chatMessages.length >= 60
      ? { chat: [...chatMessages.slice(-59), nouveau] }
      : { chat: arrayUnion(nouveau) };
    updateDoc(doc(db, "games", onlineGameId), maj)
      .catch(() => setOnlineError("Message non envoyé, vérifiez votre connexion."));
  }

  // Autoscroll UNIQUEMENT à l'arrivée d'un message ou à l'ouverture du panneau. Un ref
  // callback inline le faisait à CHAQUE rendu — or l'écran se re-rend chaque seconde
  // (tic du minuteur), ce qui ramenait la liste en bas et interdisait de relire l'historique.
  useEffect(() => {
    const el = chatListeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages.length, chatOuvert]);

  useEffect(() => { messagesDirectsRef.current = messagesDirects; }, [messagesDirects]);

  function basculerChat() {
    setChatOuvert((o) => {
      const suivant = !o;
      chatOuvertRef.current = suivant;
      if (suivant) setChatNonLus(0);
      return suivant;
    });
  }

  // ---------- Revanche (mode "Jouer avec un ami" uniquement) ----------
  // Pas en Classé : une revanche immédiate contre le même adversaire fausserait
  // l'appariement. Pas non plus en tournoi : l'arbre décide des matchs.
  const revancheDisponible = mode === "online" && gameOver && !partieClassee && !tournoiOnlineId && !finMotif;

  // Après un match de tournoi en ligne : on quitte la partie mais PAS le tournoi — retour
  // à l'arbre pour suivre la suite (et y jouer son prochain duel, si l'on a gagné).
  function retournerAuTournoi() {
    setCeremonieFin(null); setCerPose(false);
    dernierCoupDistantRef.current = null;
    chatVusRef.current = 0;
    setChatMessages([]); setChatNonLus(0); setChatOuvert(false); chatOuvertRef.current = false;
    setVainqueurForce(null); setFinMotif(null);
    setOnlineGameId(null); setOnlineRole(null);
    setBoard(Array(CELLS).fill(null)); setPoisonedCells(Array(CELLS).fill(false));
    setBlueHand([]); setRedHand([]);
    setGameOver(false);
    setOnlineStatus(""); setOnlineError("");
    setPhase("tourney-online");
  }

  // Bouton/état de revanche affiché en fin de partie (cérémonies et rangée d'actions).
  // Trois états : proposer, attendre l'adversaire, ou accepter sa proposition.
  function boutonRevanche() {
    if (!revancheDisponible || !onlineGameId) return null;
    const mien = !!(revancheVotes && revancheVotes[onlineRole]);
    const sien = !!(revancheVotes && revancheVotes[onlineRole === "blue" ? "red" : "blue"]);
    if (mien) return <div className="revanche-attente" key="rv">Revanche proposée, en attente de l'adversaire...</div>;
    return (
      <button key="rv" className={`reset-btn revanche-btn ${sien ? "revanche-invite" : ""}`} onClick={demanderRevanche}>
        {sien ? "⚔ Accepter la revanche" : "Revanche"}
      </button>
    );
  }

  function demanderRevanche() {
    if (!revancheDisponible || !onlineGameId || !onlineRole) return;
    updateDoc(doc(db, "games", onlineGameId), { [`revanche.${onlineRole}`]: true })
      .catch(() => setOnlineError("Impossible de proposer la revanche."));
  }

  // Création de la partie de revanche par le client Azur, une fois les deux votes posés.
  // Les couleurs sont ÉCHANGÉES : chacun jouera le camp adverse de la manche précédente.
  async function creerPartieDeRevanche(ancienne) {
    try {
      const premier = tirerPremierJoueur();
      let code = null;
      for (let essai = 0; essai < 5 && !code; essai++) {
        const candidat = makeGameCode();
        try {
          await runTransaction(db, async (tx) => {
            const ref = doc(db, "games", candidat);
            const snap = await tx.get(ref);
            if (snap.exists()) throw new Error("code-pris");
            tx.set(ref, {
              status: "waiting-orders", createdAt: serverTimestamp(),
              blueUid: ancienne.redUid, redUid: ancienne.blueUid,
              blueOrderKeys: null, redOrderKeys: null, blueHand: null, redHand: null,
              board: Array(CELLS).fill(null), poisonedCells: Array(CELLS).fill(""),
              turn: premier, firstPlayer: premier, gameOver: false,
            });
          });
          code = candidat;
        } catch (e) { if (e.message !== "code-pris") throw e; }
      }
      if (!code) throw new Error("code-indisponible");
      await updateDoc(doc(db, "games", onlineGameId), { "revanche.prochainCode": code });
    } catch (e) {
      revancheCreationRef.current = false;
      setOnlineError("Impossible de lancer la revanche.");
    }
  }

  // Bascule des deux clients vers la partie de revanche. Le rôle s'inverse (couleurs
  // échangées à la création) — on ne se fie PAS aux uid, identiques quand deux onglets
  // d'un même navigateur partagent le compte anonyme.
  function basculerVersRevanche(code) {
    if (code === onlineGameId) return;
    revancheCreationRef.current = false;
    dernierCoupDistantRef.current = null;
    chatVusRef.current = 0;
    setChatMessages([]); setChatNonLus(0); setChatOuvert(false); chatOuvertRef.current = false;
    setRevancheVotes(null);
    setVainqueurForce(null); setFinMotif(null);
    setCeremonieFin(null); setCerPose(false);
    setBoard(Array(CELLS).fill(null));
    setPoisonedCells(Array(CELLS).fill(false));
    setBlueHand([]); setRedHand([]);
    setGameOver(false);
    setPickerChoice([]);
    setOnlineRole((r) => (r === "blue" ? "red" : "blue"));
    setOnlineGameId(code);
    setOnlineStatus("");
    setPhase("select-blue");
  }

  // Copie du code dans le presse-papier — confort sur téléphone, où recopier cinq
  // lettres dans une conversation est plus pénible que sur un clavier. L'API n'existe
  // qu'en contexte sécurisé (https ou localhost) : en cas d'échec on ne dit rien, le
  // code reste affiché en grand juste au-dessus.
  async function copierCode() {
    if (!onlineGameId) return;
    try {
      await navigator.clipboard.writeText(onlineGameId);
      setCodeCopie(true);
      setTimeout(() => setCodeCopie(false), 2000);
    } catch (e) { /* le joueur lira le code à l'écran */ }
  }

  // Efface l'annonce d'appariement une fois qu'elle a été prise, pour qu'elle ne soit
  // jamais rejouée. Conditionnée au code exact : si un nouvel appariement a déjà été
  // annoncé entre-temps, on n'y touche pas.
  async function libererAppariement(code) {
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "matchmaking", "lobby");
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        if (snap.data().matchedGameId !== code) return;
        tx.set(ref, { matchedUid: null, matchedGameId: null, matchedAt: null }, { merge: true });
      });
    } catch (e) { /* la garde de fraicheur suffit a empecher un rejeu */ }
  }

  // Libère ma place dans la salle d'attente quand j'abandonne la recherche. En cas
  // d'échec on ne fait rien : l'inscription périmera d'elle-même au bout d'une minute.
  async function annulerRecherche() {
    setFileAttente(false);
    setOnlineStatus("");
    if (!myUid) return;
    try {
      const lobbyRef = doc(db, "matchmaking", "lobby");
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(lobbyRef);
        if (!snap.exists()) return;
        const d = snap.data();
        const maj = {};
        if (d.waitingUid === myUid) { maj.waitingUid = null; maj.waitingAt = null; }
        // Une annonce qui m'était adressée n'a plus lieu d'être si je quitte la file.
        if (d.matchedUid === myUid) { maj.matchedUid = null; maj.matchedGameId = null; maj.matchedAt = null; }
        if (Object.keys(maj).length) tx.set(lobbyRef, maj, { merge: true });
      });
    } catch (e) { /* l'inscription expirera toute seule */ }
  }

  // Tant que j'attends dans la salle, j'écoute : l'adversaire qui m'apparie y inscrit mon
  // uid et le code de la partie qu'il vient de créer. Je la rejoins alors en Azur.
  useEffect(() => {
    if (!fileAttente || !myUid) return;
    const unsub = onSnapshot(doc(db, "matchmaking", "lobby"), (snap) => {
      if (!snap.exists()) return;
      const lobby = snap.data();
      // Un appariement ne vaut que s'il vient d'être annoncé (quelques secondes) et
      // qu'on ne l'a pas déjà pris. Sans ces deux gardes, un champ resté en place
      // relançait indéfiniment la même vieille partie.
      const frais = !!lobby.matchedAt && (Date.now() - lobby.matchedAt) < ATTENTE_PERIMEE_MS;
      if (lobby.matchedUid === myUid && lobby.matchedGameId && frais
          && !matchsConsommesRef.current.has(lobby.matchedGameId)) {
        const code = lobby.matchedGameId;
        matchsConsommesRef.current.add(code);
        // Effacement du champ pour que personne ne le relise : en arrière-plan, l'entrée
        // en partie ne doit pas attendre le réseau.
        libererAppariement(code);
        setFileAttente(false);
        setOnlineStatus("");
        setOnlineGameId(code);
        setOnlineRole("blue");
        setMode("online");
        setPickerChoice([]);
        setPartieClassee(true);
        setPhase("select-blue");
      }
    }, () => setOnlineError("Recherche interrompue. Vérifiez votre connexion."));
    return unsub;
  }, [fileAttente, myUid]);


  // (L'ancien bouton "Nouvelle partie" ouvrait un ecran de choix de Voie ; le hub
  // presente ces choix directement sur la page Jouer.)

  function loadTutStep(i) {
    const step = TUTORIAL_STEPS[i];
    if (step.kind === "play") {
      setTut((t) => ({ ...t, board: step.board.map((cell) => (cell ? { ...cell } : null)), resolved: false, flashes: {} }));
    }
  }

  function startTutorial() {
    setTut({ stepIdx: 0, board: null, resolved: false, flashes: {} });
    loadTutStep(0);
    setPhase("tutorial");
  }

  function tutorialCellClick(cellIdx) {
    const step = TUTORIAL_STEPS[tut.stepIdx];
    if (step.kind !== "play" || tut.resolved) return;
    if (cellIdx !== step.requiredCell) return;
    let nb = tut.board.slice();
    nb[cellIdx] = { ...step.handCard, owner: "blue" };
    const { board: resolved, events } = resolvePlacement(nb, cellIdx, "blue");
    const map = {};
    events.forEach((e) => { map[e.index] = e.kind; });
    setTut((t) => ({ ...t, board: resolved, flashes: map, resolved: true }));
  }

  function nextTutorialStep() {
    const next = tut.stepIdx + 1;
    if (next >= TUTORIAL_STEPS.length) { setPhase("landing"); return; }
    setTut((t) => ({ ...t, stepIdx: next }));
    loadTutStep(next);
  }

  function skipTutorial() {
    setPhase("landing");
  }

  // 3 tours, difficulté croissante. On réutilise les mêmes clés que DIFFICULTIES.
  const TOURNEY_ROUNDS = [
    { label: "Quart de finale", diff: "intermediaire" },
    { label: "Demi-finale", diff: "avance" },
    { label: "Finale", diff: "expert" },
  ];
  // Bracket à 8 (écran d'avant-tournoi) : les "concurrents" sont purement décoratifs, sans
  // lien avec le vrai déroulement du tournoi (qui reste 3 matchs consécutifs contre le bot).

  function startTourney() {
    setTourney({ active: true, round: 0, ban: null });
    launchTourneyRound(0, null);
  }

  // Prépare le plateau et lance le tour donné contre le bot, avec la difficulté qui va
  // avec. banKey est passé explicitement (plutôt que de relire l'état tourney.ban) pour
  // éviter de lire une valeur pas encore à jour juste après un setTourney({ ban: ... }).
  function launchTourneyRound(roundIdx, banKey) {
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setBoard(Array(CELLS).fill(null));
    setPoisonedCells(Array(CELLS).fill(false));
    setBlueHand([]); setRedHand([]);
    setBlueOrders([]); setRedOrders([]);
    setPickerChoice([]);
    setMode("bot");
    setConfluenceActive(false);
    setTestMode(false);
    setBotDifficulty(TOURNEY_ROUNDS[roundIdx].diff);
    // Main du bot tirée au hasard tout de suite, comme en mode Bot normal — en excluant
    // l'Ordre actuellement banni (passé explicitement, voir commentaire ci-dessus).
    const pool = ORDERS.filter((o) => isOrderAvailable(o) && o.key !== banKey);
    const shuffled = [...pool];
    const a = shuffled.splice(Math.floor(Math.random() * shuffled.length), 1)[0];
    const b = shuffled.splice(Math.floor(Math.random() * shuffled.length), 1)[0];
    setRedOrders([a, b]);
    setRedHand(makeHand(a, b));
    const premier = tirerPremierJoueur();
    setTurn(premier); setFirstPlayer(premier); setSelected(null); setFlashes({}); setBoardShake(false); setBoardShakeBig(false); setGameOver(false);
    setDrag(null); setDragHoverCell(null); setHistory([]);
    resetFanState();
    setAllowUndo(false); setAllowHint(false); setHint(null);
    setPhase("select-blue");
  }

  // Mode Histoire : ouvre l'écran de choix du 2e Ordre pour le chapitre choisi.
  function openChapter(chapterKey) {
    setStoryChapterKey(chapterKey);
    setStorySecondPick(null);
    setStoryChapterJustCompleted(null);
    setPhase("chapter-pick-order");
  }

  // Mode Histoire : lance la partie en cours du chapitre, avec l'Ordre du chapitre
  // imposé + le 2e Ordre choisi par le joueur, et la difficulté qui correspond au
  // numéro de la partie dans le chapitre (voir storyDifficultyFor).
  function launchChapterGame() {
    if (!storySecondPick) return;
    const chapterMeta = STORY_CHAPTERS.find((c) => c.orderKey === storyChapterKey);
    const secondOrder = ORDERS.find((o) => o.key === storySecondPick);
    const gameIndex = (storyProgress.chapterWins[storyChapterKey] || 0) + 1;
    const diff = storyDifficultyFor(gameIndex, chapterMeta.numGames);

    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setBoard(Array(CELLS).fill(null));
    setPoisonedCells(Array(CELLS).fill(false));
    setMode("bot");
    setConfluenceActive(false);
    setTestMode(false);
    setBotDifficulty(diff);

    setBlueOrders([chapterMeta.order, secondOrder]);
    // Le joueur rejoue avec tous les Hérauts qu'il a déjà gagnés dans les chapitres
    // précédents. Le Héraut du chapitre EN COURS n'en fait pas partie tant qu'il ne
    // l'a pas conquis : c'est précisément l'enjeu de la dernière partie.
    setBlueHand(applyEarnedHeroesToHand(makeHand(chapterMeta.order, secondOrder), storyProgress.completedChapters));
    // Main du bot : aléatoire normalement, mais pour le combat de Seigneur de Guerre
    // (dernière partie du chapitre), le bot a toujours l'Ordre du chapitre en main,
    // avec son Héraut actif — c'est ce combat qui "montre" la capacité qu'on va gagner.
    const isFinalGame = gameIndex >= chapterMeta.numGames;
    let botOrderA, botOrderB;
    if (isFinalGame) {
      const otherPool = ORDERS.filter((o) => isOrderAvailable(o) && o.key !== storyChapterKey);
      botOrderA = chapterMeta.order;
      botOrderB = otherPool[Math.floor(Math.random() * otherPool.length)];
    } else {
      [botOrderA, botOrderB] = pickRandomTwoOrders();
    }
    setRedOrders([botOrderA, botOrderB]);
    setRedHand(isFinalGame ? applyHeroToHand(makeHand(botOrderA, botOrderB), storyChapterKey) : makeHand(botOrderA, botOrderB));

    const premier = tirerPremierJoueur();
    setTurn(premier); setFirstPlayer(premier); setSelected(null); setFlashes({}); setBoardShake(false); setBoardShakeBig(false); setGameOver(false);
    setDrag(null); setDragHoverCell(null); setHistory([]);
    resetFanState();
    // Repentir et Augure activés par défaut en mode Histoire (utile pour apprendre l'Ordre).
    setAllowUndo(true); setAllowHint(true); setHint(null);
    setPhase("play");
  }

  // Mode Histoire : bouton "Continuer" en fin de partie — ramène à l'écran de choix du
  // 2e Ordre pour la partie suivante du chapitre (le 2e Ordre précédemment choisi reste
  // pré-sélectionné, le joueur peut le garder ou en changer). En cas de défaite, la
  // progression n'a pas avancé : c'est donc la même partie qui se represente. Si le
  // chapitre vient d'être terminé (Seigneur de Guerre battu), va à l'écran de récompense.
  function continueChapter() {
    if (storyChapterJustCompleted) setStoryCeremonyDone(false); // la cérémonie doit rejouer pour ce chapitre
    setPhase(storyChapterJustCompleted ? "chapter-complete" : "chapter-pick-order");
  }

  // Appelé quand le match du tour en cours vient de se terminer : victoire → écran de ban,
  // défaite → élimination du tournoi.
  function finishTourneyMatch() {
    setTourneyBanPick(null);
    setPhase(winner === "blue" ? "tourney-ban" : "tourney-eliminated");
  }

  // Le joueur choisit un Ordre à bannir pour le tour suivant (remplace le ban précédent),
  // puis on enchaîne directement sur ce tour — ou sur le podium si c'était la finale.
  function confirmTourneyBan(orderKey) {
    if (tourney.round >= TOURNEY_ROUNDS.length - 1) {
      setTourney((t) => ({ ...t, ban: orderKey }));
      setPhase("tourney-champion");
    } else {
      const next = tourney.round + 1;
      setTourney((t) => ({ ...t, ban: orderKey, round: next }));
      launchTourneyRound(next, orderKey);
    }
  }

  function chooseMode(m) {
    setMode(m);
    setTestMode(false);
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    // Le duel local passe d'abord par ses options de partie (rotation de l'écran) ;
    // l'Écho garde son parcours difficulté puis assistance.
    setPhase(m === "bot" ? "select-difficulty" : "select-assist");
  }

  function chooseConfluenceBot() {
    setConfluenceActive(true);
    setMode("bot");
    setTestMode(false);
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setBlueOrders(AVAILABLE_ORDERS);
    setRedOrders(AVAILABLE_ORDERS);
    setPhase("select-difficulty");
  }

  function chooseConfluenceLocal() {
    setConfluenceActive(true);
    setMode("local");
    setTestMode(false);
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setBlueOrders(AVAILABLE_ORDERS);
    setRedOrders(AVAILABLE_ORDERS);
    setDraft({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });
    setPhase("confluence-draft");
  }

  // Mode test (bac à sable) : Confluence, on contrôle les deux camps et il n'y a
  // aucun minuteur — idéal pour essayer les capacités tranquillement. Plateau agrandi
  // à 6x6 et partie lancée directement avec les 10 Ordres en main, sans passer par le draft.
  function chooseTestMode() {
    setConfluenceActive(true);
    setMode("local");
    setTestMode(true);
    setBlueOrders([...AVAILABLE_ORDERS, ...ORDRES_A_L_ESSAI]);
    setRedOrders([...AVAILABLE_ORDERS, ...ORDRES_A_L_ESSAI]);
    setDraft({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });

    // ═══ TEMPORAIRE — le bac à sable passe en 4×5 pour juger les arènes dans leurs
    // vraies proportions. Le 6×6 étirait les cadres, qui sont carrés.
    // Conséquence : 11 cartes par camp pour 20 cases, on ne peut plus toutes les poser.
    // Pour revenir au grand plateau : setBoardSize(TEST_ROWS, TEST_COLS);
    setBoardSize(STANDARD_ROWS, STANDARD_COLS);
    setBoard(Array(CELLS).fill(null));
    setPoisonedCells(Array(CELLS).fill(false));
    const buildFullHand = () => [...AVAILABLE_ORDERS, ...ORDRES_A_L_ESSAI].map((o) => makeOrderQuad(o)[0]);
    // Aucun Héraut en bac à sable : on teste les capacités de base, telles que la plupart
    // des joueurs les rencontreront. Pour les réactiver, envelopper les deux appels dans
    // applyAllHeroesToHand(...) — la fonction est restée disponible juste au-dessus.
    setBlueHand(buildFullHand());
    setRedHand(buildFullHand());
    setTurn("blue"); setFirstPlayer("blue"); setSelected(null); setDrag(null); setDragHoverCell(null);
    resetFanState();
    setFlashes({}); setBoardShake(false); setBoardShakeBig(false); setGameOver(false); setHistory([]);
    setPhase("play");
  }

  // Un joueur choisit un Ordre pendant le draft. Il rejoint le pool COMMUN : les deux
  // joueurs en auront chacun une carte, que ce soit vous ou l'adversaire qui l'ait choisie.
  function pickDraftOrder(orderKey) {
    if (draft.pool.includes(orderKey) || draft.pool.length >= 8) return; // déjà dans le pool, ou pool déjà complet
    const orderToPick = ORDERS.find((l) => l.key === orderKey);
    if (!orderToPick || !isOrderAvailable(orderToPick)) return; // "prochainement" : jamais draftable
    const next = [...draft.pool, orderKey];
    const nextPickedBy = { ...draft.pickedBy, [orderKey]: draft.turn };

    if (next.length >= 8) {
      // Draft terminé : les deux mains sont construites à partir du pool commun — identiques,
      // à une exception près : l'orientation des Scribes est tirée au sort pour chaque camp
      // (voir carteConfluence).
      const buildHand = () => next.map((k) => carteConfluence(ORDERS.find((l) => l.key === k)));
      setBlueHand(buildHand());
      setRedHand(buildHand());
      setDraft((d) => ({ ...d, pool: next, pickedBy: nextPickedBy }));
      if (mode !== "bot") { const premier = tirerPremierJoueur(); setTurn(premier); setFirstPlayer(premier); } // en mode bot, startMatch s'en charge après l'aperçu
      setPhase(mode === "bot" ? "preview" : "play");
    } else {
      setDraft((d) => ({ ...d, pool: next, pickedBy: nextPickedBy, turn: d.turn === "blue" ? "red" : "blue", timeLeft: DRAFT_SECONDS }));
    }
  }

  // Mode test uniquement : complète le draft d'un coup avec des Ordres restants tirés au
  // hasard, pour ne pas avoir à faire les 8 choix à la main à chaque essai.
  function fillDraftRandomly() {
    let pool = [...draft.pool];
    const remaining = AVAILABLE_ORDERS.filter((o) => !pool.includes(o.key));
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    while (pool.length < 8 && remaining.length) pool.push(remaining.pop().key);
    const buildHand = () => pool.map((k) => carteConfluence(ORDERS.find((l) => l.key === k)));
    setDraft((d) => ({ ...d, pool }));
    setBlueHand(buildHand());
    setRedHand(buildHand());
    setPhase("play");
  }

  function toggleOrderPick(order) {
    if (!isOrderAvailable(order)) return; // "prochainement" : jamais sélectionnable
    setPickerChoice((prev) => {
      const exists = prev.find((l) => l.key === order.key);
      if (exists) {
        if (heroChoice === order.key) setHeroChoice(null);
        setHerautsCoches((h) => h.filter((k) => k !== order.key)); // l'Ordre part, sa capacité aussi
        return prev.filter((l) => l.key !== order.key);
      }
      if (prev.length >= 2) return prev;
      return [...prev, order];
    });
  }

  function applyOrderChoice(picked) {
    if (picked.length !== 2) return;
    // Les capacités supérieures cochées s'empilent sur la main : une par Ordre choisi.
    // applyHeroToHand est sans effet si l'Ordre n'est pas dans la main, donc une coche
    // orpheline ne casse rien.
    const avecHerauts = (hand) => herautsCoches.reduce((h, key) => applyHeroToHand(h, key), hand);
    if (phase === "select-blue") {
      setBlueOrders(picked);
      setBlueHand(avecHerauts(applyHeroToHand(makeHand(picked[0], picked[1]), heroChoice)));
      setPickerChoice([]);
      setHeroChoice(null);
      setHerautsCoches([]);
      setPhase(mode === "local" ? "select-red" : "preview");
    } else if (phase === "select-red") {
      setRedOrders(picked);
      setRedHand(avecHerauts(applyHeroToHand(makeHand(picked[0], picked[1]), heroChoice)));
      setPickerChoice([]);
      setHeroChoice(null);
      setHerautsCoches([]);
      const premier = tirerPremierJoueur();
      setTurn(premier); setFirstPlayer(premier);
      setPhase("play");
    }
  }

  function confirmOrders() {
    if (mode === "online") { confirmOnlineOrders(); return; }
    applyOrderChoice(pickerChoice);
  }

  function pickRandomTwoOrders() {
    const pool = ORDERS.filter((o) => isOrderAvailable(o) && !(tourney.active && tourney.ban === o.key));
    const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const b = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    return [a, b];
  }

  function chooseRandomOrders() {
    if (mode === "online") { confirmOnlineOrders(pickRandomTwoOrders()); return; }
    applyOrderChoice(pickRandomTwoOrders());
  }

  function chooseDifficulty(diffKey) {
    setBotDifficulty(diffKey);
    if (!confluenceActive) {
      // Mode Bot classique : la main du bot est déjà fixée ici, la sélection des
      // Ordres du joueur vient juste après l'écran d'options.
      const [a, b] = pickRandomTwoOrders();
      setRedOrders([a, b]);
      setRedHand(makeHand(a, b));
    }
    setPhase("select-assist");
  }

  // Valide les options d'assistance (Repentir / Augure) et poursuit le parcours
  // là où chooseDifficulty l'avait laissé en suspens.
  function confirmAssistOptions() {
    if (confluenceActive) {
      // Mode Confluence contre le bot : draft à 8, comme en local, mais le bot choisit
      // automatiquement pour vous quand c'est son tour.
      setDraft({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });
      setPhase("confluence-draft");
    } else {
      setPhase("select-blue");
    }
  }

  function startMatch() {
    const premier = tirerPremierJoueur();
    setTurn(premier); setFirstPlayer(premier);
    setPhase("play");
  }

  // Bouton "← Retour" : remonte d'un écran dans le parcours d'avant-partie, en
  // réinitialisant ce qui a été saisi à l'étape qu'on abandonne pour éviter les
  // états à moitié remplis (draft partiel, sélection en cours...).
  function goBack() {
    if (phase === "tourney-bracket") {
      setPhase("tourney-menu");
    } else if (phase === "tourney-online-menu") {
      setTournoiErreur(""); setCodeTournoiInput("");
      setPhase("tourney-menu");
    } else if (phase === "tourney-online") {
      // Salle d'attente : on libère son siège. Tournoi lancé : on sort juste de l'écran,
      // le tournoi continue sans nous et l'accueil proposera d'y revenir.
      if (tournoiData && tournoiData.status === "waiting") quitterSalleTournoi();
      else { setTournoiOnlineId(null); setTournoiData(null); }
      setPhase("tourney-online-menu");
    } else if (phase === "tourney-menu") {
      setPhase("landing");
    } else if (phase === "chapter-pick-order") {
      setPhase("chapters");
    } else if (phase === "chapters") {
      setPhase("landing");
    } else if (phase === "select-difficulty") {
      setMode(null);
      setConfluenceActive(false);
      setPhase("landing");
    } else if (phase === "select-assist") {
      if (mode === "local") { setMode(null); setPhase("landing"); }
      else setPhase("select-difficulty");
    } else if (phase === "online-menu") {
      setMode(null);
      setOnlineError("");
      setPhase("landing");
    } else if (phase === "online-waiting") {
      // Recherche en cours : on libère d'abord sa place dans la salle d'attente, sinon
      // le prochain joueur serait apparié à quelqu'un qui a quitté l'écran.
      if (fileAttente) { annulerRecherche(); setMode(null); setPartieClassee(false); setPhase("landing"); return; }
      // Match de tournoi : revenir en arrière avant le début NE vaut PAS abandon — le
      // match reste en attente dans l'arbre et se rejoue via "Jouer votre duel". Sans ça,
      // un simple tap sur Retour pendant le choix des Ordres éliminait du tournoi, sans
      // confirmation ni retour possible.
      if (tournoiOnlineId) { setOnlineGameId(null); setOnlineRole(null); setOnlineStatus(""); setPickerChoice([]); setPhase("tourney-online"); return; }
      abandonnerAvantDebut();
    } else if (phase === "select-blue") {
      setPickerChoice([]);
      if (mode === "online") {
        if (tournoiOnlineId) { setOnlineGameId(null); setOnlineRole(null); setOnlineStatus(""); setPhase("tourney-online"); return; }
        abandonnerAvantDebut();
      } else if (tourney.active) { setTourney((t) => ({ ...t, active: false })); setPhase("landing"); }
      else setPhase(mode === "bot" ? "select-assist" : "landing");
    } else if (phase === "select-red") {
      // Bleu rechoisit ses 2 Ordres : on repart de sa sélection.
      setPickerChoice([]);
      setPhase("select-blue");
    } else if (phase === "confluence-draft") {
      // Abandon du draft en cours : on le vide entièrement (un draft partiel n'a pas de sens).
      setDraft({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });
      setPhase(mode === "bot" ? "select-assist" : "landing");
    } else if (phase === "preview") {
      if (confluenceActive) {
        // Le draft précédent est terminé : revenir signifie le relancer à zéro.
        setDraft({ pool: [], pickedBy: {}, turn: "blue", timeLeft: DRAFT_SECONDS });
        setPhase("confluence-draft");
      } else {
        setPickerChoice([]);
        setPhase("select-blue");
      }
    }
  }

  // Arène affichée sur le plateau : le sélecteur temporaire prime (il sert justement à
  // comparer les cinq rendus), sinon une partie classée se joue dans l'arène de la ligue
  // du joueur. Partout ailleurs, plateau nu comme avant.
  const areneActive = areneTest || (partieClassee ? getLeague(stats.trophies || 0).name : null);

  function flashEvents(events) {
    const map = {};
    events.forEach((e) => {
      if (!map[e.index]) map[e.index] = [];
      map[e.index].push(e);
    });
    setFlashes(map);
    // Durée totale à couvrir avant d'effacer les effets : la plus longue animation en jeu
    // (1.8s pour Résonance) + le délai accumulé par la chaîne Onde la plus longue (300ms/niveau).
    const maxComboLevel = Math.max(0, ...events.filter((e) => typeof e.comboLevel === "number").map((e) => e.comboLevel));
    // Résonance (3s) + pause (1s) + cascade Onde étalée (300ms/niveau) + le temps du dernier flip (2,2s).
    // Le minimum (3600) couvre aussi la pose lente du bot (3.5s) pour ne pas couper son
    // animation juste avant la fin.
    const clearDelay = maxComboLevel > 0 ? 4000 + maxComboLevel * 300 + 2400 : 3600;
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashes({}), clearDelay);
    // Secousse du plateau uniquement quand au moins une capture a lieu — pas sur
    // une simple pose sans prise, pour garder l'impact réservé aux moments forts.
    const hasCapture = events.some((e) => ["basic", "same", "combo", "percee", "portee", "attraction"].includes(e.kind));
    if (hasCapture) {
      setBoardShake(true);
      clearTimeout(shakeTimerRef.current);
      shakeTimerRef.current = setTimeout(() => setBoardShake(false), 420);
    }
    // Onde : micro-secousse amplifiée si la chaîne de combo capture plus de 2 cartes —
    // déclenchée après le délai de la dernière carte touchée, pour coïncider avec la fin
    // de la cascade plutôt que de retomber en même temps que le premier impact.
    const comboVictims = events.filter((e) => e.kind === "combo");
    if (comboVictims.length > 2) {
      const maxLevel = Math.max(...comboVictims.map((e) => e.comboLevel || 0));
      clearTimeout(shakeBigTimerRef.current);
      shakeBigTimerRef.current = setTimeout(() => {
        setBoardShakeBig(true);
        shakeBigTimerRef.current = setTimeout(() => setBoardShakeBig(false), 550);
      }, 4000 + maxLevel * 300);
    }
    // Affiche "Résonance" au sol dès l'impact, puis "Onde" un peu après si la chaîne se
    // déclenche — pour que le joueur comprenne en un coup d'œil ce qui vient de se passer.
    const hasSame = events.some((e) => e.kind === "same");
    if (hasSame) {
      clearTimeout(bannerTimerRef.current);
      clearTimeout(bannerTimer2Ref.current);
      setBanner({ text: "Résonance", key: `res-${Date.now()}` });
      bannerTimerRef.current = setTimeout(() => setBanner(null), 3000);
      if (comboVictims.length > 0) {
        bannerTimer2Ref.current = setTimeout(() => {
          setBanner({ text: "Onde", key: `onde-${Date.now()}` });
          bannerTimerRef.current = setTimeout(() => setBanner(null), 2200);
        }, 4000);
      }
    }
  }

  // Retour haptique mobile : ne fait rien si l'appareil/navigateur ne le supporte pas
  // (c'est le cas de Safari sur iOS, qui n'a jamais implémenté cette API — fonctionne
  // uniquement sur Android/Chrome et navigateurs similaires).
  function vibrate(pattern) {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* tant pis, pas grave */ }
    }
  }

  function placeCardAt(owner, cardIdx, position, viaTouch = false) {
    if (gameOver || board[position]) return;
    const hand = owner === "blue" ? blueHand : redHand;
    const card = hand[cardIdx];
    if (!card) return;

    setHint(null);
    setSelected(null);
    // Filet de sécurité : le bot et le coup auto-joué du minuteur appellent placeCardAt
    // directement, sans passer par startCardDrag/playCard — sans ce filet, un éventail
    // resté ouvert côté joueur pourrait survivre à un coup qui vient pourtant d'être joué.
    setFanOpen(null);

    // Instantané pris AVANT ce coup, pour pouvoir revenir en arrière plus tard.
    setHistory((h) => [...h, { owner, turn, board, blueHand, redHand, poisonedCells }]);

    // Un tour complet vient de s'écouler : toute Scribes posée voit son compteur de
    // dissimulation diminuer, et redevient visible une fois à zéro (2 tours avec le
    // Héraut des Scribes actif, 1 tour normalement — comportement inchangé sinon).
    const revealedScribes = [];
    let newBoard = board.map((cell, i) => {
      if (cell && cell.scribeJustPlaced && cell.scribePlacedBy === owner) {
        const turnsLeft = (cell.scribeConcealTurnsLeft || 1) - 1;
        if (turnsLeft <= 0) {
          revealedScribes.push(i);
          return { ...cell, scribeJustPlaced: false, scribeConcealTurnsLeft: 0 };
        }
        return { ...cell, scribeConcealTurnsLeft: turnsLeft };
      }
      return cell;
    });
    // scribePlacedBy : camp qui a posé la Scribes — le masquage doit se baser sur lui
    // (et pas sur owner, qui peut changer en aperçu de capture) et suivre la carte
    // même si elle est déplacée (Attraction) pendant sa fenêtre de dissimulation.
    newBoard[position] = {
      ...card, owner,
      scribeJustPlaced: card.ability === "scribe",
      scribeConcealTurnsLeft: card.ability === "scribe" ? (card.heroActive ? 2 : 1) : undefined,
      scribePlacedBy: card.ability === "scribe" ? owner : undefined,
    };
    const { board: resolvedBoard, events, poisonedCells: nextPoison } = resolvePlacement(newBoard, position, owner, poisonedCells);

    // Combos : on lit le coup ICI, une fois qu'il est reellement joue. resolvePlacement
    // tourne aussi sur chaque survol et pour chaque coup imagine par l'Echo ; y brancher
    // la detection crediterait des combos que personne n'a joues.
    if (history.length === 0) combosRef.current = nouveauSuiviCombos();
    if (partieCompteAuProfil && !combosRef.current.disqualifie) {
      combosDuCoup({
        card, position, owner, monCamp: monCampCombos, mesOrdres: mesOrdresDuJeu(), events,
        plateauAvant: board, plateauApres: resolvedBoard,
        poisonAvant: poisonedCells, poisonApres: nextPoison,
        suivi: combosRef.current,
      });
    }
    if (viaTouch) {
      // Léger tapotement à la pose, plus franc si ça capture — jamais pour le bot ni
      // pour un coup auto-joué par le minuteur, seulement pour un vrai geste du joueur.
      const hasCapture = events.some((e) => ["basic", "same", "combo", "percee", "portee", "attraction"].includes(e.kind));
      vibrate(hasCapture ? 35 : 15);
    }
    // L'événement "place" n'existe pas côté moteur : il sert uniquement à déclencher
    // l'animation d'atterrissage (chute + écrasement + rebond) sur la carte posée.
    // Le bot (rouge en mode bot) utilise une variante plus lente, pour qu'on suive
    // mieux son coup à l'œil pendant qu'il joue.
    const placeKind = mode === "bot" && owner === "red" ? "place-slow" : "place";
    const revealEvents = revealedScribes.map((i) => ({ index: i, kind: "scribe-reveal" }));

    // La suite (captures, empoisonnement, main, tour) — regroupée pour pouvoir soit
    // s'exécuter tout de suite (joueur), soit être retardée le temps que la carte du
    // bot ait fini de tomber, pour ne pas voir une capture se jouer avant qu'elle
    // ait visuellement atterri sur le plateau.
    function resolveRest() {
      setBoard(resolvedBoard);
      setPoisonedCells(nextPoison);
      setDernierCoup(position); // ce coup devient LE dernier coup : il reprend l'or au précédent
      // On réinclut l'événement de pose ici : sinon ce second appel remplacerait la
      // liste d'effets et retirerait la classe d'animation de la carte posée en plein
      // vol, coupant net sa chute avant la fin (elle n'est qu'à 46% à ce stade).
      flashEvents([{ index: position, kind: placeKind }, ...revealEvents, ...events]);

      // Pestiférés : cases qui viennent tout juste d'être empoisonnées → bouffée de brume,
      // puis on ne garde que le marquage persistant (nettoyage après l'animation).
      const freshPoison = [];
      for (let i = 0; i < nextPoison.length; i++) if (nextPoison[i] && !poisonedCells[i]) freshPoison.push(i);
      if (freshPoison.length) {
        setJustPoisoned(freshPoison);
        clearTimeout(poisonTimerRef.current);
        poisonTimerRef.current = setTimeout(() => setJustPoisoned([]), 1500);
      }

      let nextBlueHand = blueHand, nextRedHand = redHand;
      if (owner === "blue") { nextBlueHand = blueHand.filter((_, i) => i !== cardIdx); setBlueHand(nextBlueHand); }
      else { nextRedHand = redHand.filter((_, i) => i !== cardIdx); setRedHand(nextRedHand); }

      const nowGameOver = nextBlueHand.length === 0 && nextRedHand.length === 0;
      const nextTurn = owner === "blue" ? "red" : "blue";
      if (nowGameOver) setGameOver(true);
      else setTurn(nextTurn);

      // Partie en ligne : on pousse notre coup vers Firestore juste après l'avoir joué
      // localement — l'adversaire le reçoit via l'écouteur onSnapshot ci-dessus. On joint
      // au plateau la DESCRIPTION du coup (case posée + effets + cases empoisonnées) :
      // c'est ce qui permet à l'adversaire de rejouer les mêmes animations chez lui au
      // lieu de voir le plateau changer d'un bloc. L'identifiant unique évite qu'une
      // notification Firestore sans rapport ne relance les effets une seconde fois.
      if (mode === "online" && onlineGameId) {
        // try/catch en plus du .catch : updateDoc valide ses arguments de façon SYNCHRONE
        // et lève avant de rendre une promesse. Une donnée invalide échappait donc au
        // .catch, remontait en erreur non capturée, et le coup se perdait sans le moindre
        // message — le joueur voyait sa carte posée chez lui et nulle part ailleurs.
        try {
        updateDoc(doc(db, "games", onlineGameId), {
          board: resolvedBoard.map(stripForSave),
          blueHand: nextBlueHand.map(stripForSave),
          redHand: nextRedHand.map(stripForSave),
          poisonedCells: nextPoison.map(encoderPoison),
          turn: nowGameOver ? turn : nextTurn,
          gameOver: nowGameOver,
          lastMove: {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            by: owner,
            position,
            events: [...revealEvents, ...events].map(sansUndefined),
            freshPoison,
          },
        }).catch(() => setOnlineError("Coup non synchronisé, vérifiez votre connexion."));
        } catch (e) {
          setOnlineError("Coup non synchronisé, vérifiez votre connexion.");
        }
      }
    }

    if (placeKind === "place-slow") {
      // La carte du bot tombe d'abord seule (rien d'autre ne change sur le plateau),
      // puis les captures se résolvent une fois qu'elle a fini d'atterrir (46% des
      // 3,5s de l'animation — voir card-land-bot dans le CSS).
      setBoard(newBoard);
      flashEvents([{ index: position, kind: placeKind }, ...revealEvents]);
      setTimeout(resolveRest, 1610);
    } else {
      // Coup du joueur : tout se résout dans la foulée. On n'appelle flashEvents qu'UNE
      // seule fois, depuis resolveRest — un premier appel suivi aussitôt d'un second
      // remplaçait la liste d'effets à peine posée, ce qui pouvait relancer depuis le
      // début les animations de pose et de capture. Le double appel n'est nécessaire
      // que pour la pose lente du bot, où les deux étapes sont réellement séparées
      // dans le temps.
      setBoard(newBoard);
      resolveRest();
    }
  }

  // Annule le dernier coup joué. En mode Bot, si le dernier coup est celui du bot
  // (Rouge), on annule aussi le coup du Bleu qui l'a précédé — sinon le bot
  // rejouerait aussitôt le même coup et l'annulation semblerait ne rien faire.
  function undo() {
    if (history.length === 0 || drag) return;
    if (mode === "online") return; // pas d'annulation en ligne : désynchroniserait l'adversaire
    if (!testMode && !allowUndo) return; // "Repentir" désactivé pour cette partie (bac à sable libre)
    // Un coup repris n'est plus un coup joue : la partie ne peut plus servir de mesure
    // du style du joueur, on la retire du profil plutot que de compter des combos essayes.
    combosRef.current.disqualifie = true;
    const stack = history.slice();
    let target = stack.pop();
    if (mode === "bot" && target.owner === "red" && stack.length) {
      target = stack.pop();
    }
    setBoard(target.board);
    setBlueHand(target.blueHand);
    setRedHand(target.redHand);
    setPoisonedCells(target.poisonedCells);
    setTurn(target.turn);
    setGameOver(false);
    setFlashes({});
    setDernierCoup(null);
    setHint(null);
    setSelected(null);
    resetFanState();
    setHistory(stack);
  }

  // "Augure" : suggère le meilleur coup pour le joueur — Azur contre un Écho, celui dont
  // c'est le tour en duel local — en réutilisant
  // l'IA "Seigneur de Guerre" (la plus forte déjà codée), appliquée à sa propre
  // main plutôt qu'à celle du bot. Un second clic masque l'augure sans le perdre.
  function toggleHint() {
    if (!allowHint || gameOver || mode === "online") return;
    if (mode === "bot" && turn !== "blue") return; // contre l'Écho, l'augure ne sert que le joueur
    if (hint) { setHint(null); setFanOpen(null); return; }
    // En duel local, l'augure éclaire le joueur dont c'est le tour, quel que soit son camp.
    const joueur = mode === "local" ? turn : "blue";
    const adverse = joueur === "blue" ? "red" : "blue";
    const mainJoueur = joueur === "blue" ? blueHand : redHand;
    const mainAdverse = joueur === "blue" ? redHand : blueHand;
    const move = botChooseMove(board, mainJoueur, mainAdverse, joueur, adverse, "expert", poisonedCells);
    if (move) {
      setHint({ cardIdx: move.cardIdx, cellIdx: move.cellIdx });
      // La carte suggérée peut être repliée dans un éventail fermé : on force son
      // ouverture pour que le halo de l'augure (hint-source) reste visible tout de
      // suite, sans quoi le joueur ne verrait jamais l'indice tant qu'il n'a pas
      // lui-même tapé la vignette de son Ordre. Sans effet si le groupe n'a qu'une
      // carte (déjà affichée directement, pas de vignette pour elle).
      const suggestedCard = mainJoueur[move.cardIdx];
      if (suggestedCard) setFanOpen({ owner: joueur, ability: suggestedCard.ability });
    }
  }

  // ---------- Main en éventail ----------
  // Ouvre/ferme l'éventail d'un Ordre en main. Un seul éventail ouvert à la fois : en
  // ouvrir un nouveau referme celui qui l'était déjà (avec une courte animation de
  // repli), pour ne jamais encombrer un écran de mobile avec deux éventails en même
  // temps. Toucher deux fois le même Ordre le referme sans en ouvrir d'autre.
  function toggleFan(owner, ability) {
    // En ligne, l'éventail ADVERSE reste fermé : l'ouvrir révélerait les rotations
    // restantes de l'adversaire — ses rangs exacts encore en main. Le médaillon et son
    // compteur suffisent à savoir combien de cartes il lui reste par Ordre. En local et
    // contre l'Écho, comportement inchangé (l'appareil est partagé, rien à cacher).
    if (mode === "online" && owner !== onlineRole) return;
    setFanOpen((cur) => {
      const isSame = cur && cur.owner === owner && cur.ability === ability;
      if (cur) {
        setFanClosing(cur);
        clearTimeout(fanCloseTimerRef.current);
        fanCloseTimerRef.current = setTimeout(() => setFanClosing(null), 260);
      }
      return isSame ? null : { owner, ability };
    });
  }
  // Reset "dur", sans repli animé : pour les grands changements d'écran (nouvelle
  // partie, annulation...) où tout le reste de l'affichage saute déjà d'un coup —
  // animer le repli tout seul dans ce contexte ferait un effet bâclé.
  function resetFanState() {
    clearTimeout(fanCloseTimerRef.current);
    setFanOpen(null);
    setFanClosing(null);
  }

  // ---------- Glisser-déposer des cartes (souris + tactile via Pointer Events) ----------
  function canDragCard(owner) {
    if (gameOver || owner !== turn) return false;
    if (mode === "bot" && owner !== "blue") return false; // le bot joue seul côté rouge
    if (mode === "online" && owner !== onlineRole) return false; // on ne joue que ses propres cartes
    return true;
  }

  function startCardDrag(owner, idx, e) {
    if (!canDragCard(owner)) return;
    e.preventDefault();
    dragMovedRef.current = false;
    setSelected(null);
    // Fermeture instantanée, sans repli animé : l'attention est déjà sur CETTE carte
    // (fantôme de glisser ou sélection à venir), un repli animé des 3 autres ferait
    // concurrence visuelle inutile au geste en cours.
    // On note au passage OÙ et QUAND la carte a été saisie depuis un éventail ouvert :
    // comme l'éventail disparaît dès maintenant, le clic que le navigateur enverra juste
    // après ce toucher n'aura plus de carte sous le doigt et retomberait sur la case du
    // plateau située dessous. playCard s'en sert pour ignorer ce clic-là. Voir le détail
    // du mécanisme dans playCard.
    if (fanOpen) fanGrabRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    setFanOpen(null);
    setDrag({ owner, idx, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    setDragHoverCell(null);
  }

  // Rendu de la main d'un camp : carte directe pour un groupe à 1 seule carte (Confluence,
  // bac à sable), vignette d'Ordre + éventail au tap pour un groupe à plusieurs cartes
  // (main standard/Histoire/tournoi, où chaque Ordre en apporte 4 au départ). Partagé
  // entre Écarlate et Azur : seuls le sens d'ouverture de l'éventail et la règle de
  // dissimulation des Scribes changent d'un côté à l'autre — cette dernière reproduite
  // ici À L'IDENTIQUE de ce qu'elle était avant l'éventail, camp par camp.
  function renderHandGroups(owner) {
    const groups = owner === "blue" ? blueGroups : redGroups;
    // L'éventail s'ouvre vers le PLATEAU, donc d'après la place de la main à l'écran et
    // non d'après sa couleur. Depuis que la main du joueur est toujours en bas de son
    // écran, Écarlate s'y retrouve en ligne : s'en tenir à la couleur faisait alors
    // s'ouvrir l'éventail vers le bas, hors de l'écran, sous les doigts.
    const sens = owner === campBas ? "haut" : "bas";
    // L'augure conseille le joueur dont c'est le tour en duel local (voir toggleHint) :
    // son indice de carte vaut pour la main de CE camp-la. Le comparer en dur a Azur
    // laissait la carte conseillee d'Ecarlate sans halo, et allumait a sa place la carte
    // d'Azur occupant le meme rang — chaque camp numerote sa main a partir de zero.
    const campAugure = mode === "local" ? turn : "blue";
    const canInteract = !(mode === "bot" && owner === "red"); // le bot ne se laisse jamais toucher
    const isConcealed = (card) =>
      card.ability === "scribe" &&
      (mode === "bot" ? owner === "red" : mode === "online" ? onlineRole !== owner : turn !== owner);

    return groups.map((group) => {
      const isOpen = !!(fanOpen && fanOpen.owner === owner && fanOpen.ability === group.ability);
      const isClosing = !isOpen && !!(fanClosing && fanClosing.owner === owner && fanClosing.ability === group.ability);
      const hasSelectedInside = !!(selected && selected.owner === owner && group.cards.some((c) => c.handIdx === selected.idx));
      const hasHintInside = owner === campAugure && !!hint && group.cards.some((c) => c.handIdx === hint.cardIdx);

      return (
        <div key={group.ability} className={`order-tile-wrap ${isOpen ? "fan-open" : ""}`}>
          <button
            type="button"
            className={`order-tile ${hasSelectedInside || hasHintInside ? "tile-pending" : ""}`}
            onPointerDown={canInteract && group.cards.length === 1 ? (e) => {
              // Groupe à carte unique (bac à sable, Confluence, fins de partie) : la
              // vignette EST la carte — la saisir, c'est la glisser. startCardDrag garde
              // ses propres refus (tour adverse, partie finie) : on ne marque la saisie
              // que s'il accepte vraiment.
              if (canDragCard(owner)) { tuileSaisieRef.current = true; startCardDrag(owner, group.cards[0].handIdx, e); }
            } : undefined}
            onClick={() => {
              // Le navigateur envoie toujours un clic apres le toucher.
              // Si le doigt a REELLEMENT glisse, la carte a deja ete jouee : ce clic est un
              // fantome, on l'avale.
              // S'il n'a pas bouge, c'est un simple tap : on relache l'etat de glisser
              // amorce au toucher (sans quoi la carte resterait collee au doigt) et on
              // ouvre l'eventail comme pour n'importe quelle vignette. Indispensable : la
              // vignette ne montre que le portrait, c'est l'eventail qui donne les rangs.
              // Selectionner sans les afficher revenait a choisir a l'aveugle.
              if (tuileSaisieRef.current) {
                const avaitGlisse = dragMovedRef.current;
                tuileSaisieRef.current = false;
                if (avaitGlisse) return;
                setDrag(null);
                setDragHoverCell(null);
              }
              toggleFan(owner, group.ability);
            }}
            aria-expanded={isOpen}
            aria-label={`Cartes ${group.order ? group.order.name : ""}, ${group.cards.length} en main`}
          >
            {group.order && group.order.portrait ? (
              <img className="order-tile-portrait" src={group.order.portrait} alt={group.order.name} />
            ) : (
              <span className="order-tile-icon">{group.order ? group.order.icon : "?"}</span>
            )}
            {group.cards.some((c) => c.card.heroActive) && <span className="order-tile-hero" title="Héraut actif">★</span>}
            {/* Combien de cartes restent dans cet Ordre. Masque a 1 : le medaillon seul
                le dit deja, et un "1" sur chaque vignette ferait du bruit pour rien. */}
            {group.cards.length > 1 && (
              <span className="order-tile-compte" aria-hidden="true">{group.cards.length}</span>
            )}
          </button>
          {(isOpen || isClosing) && (
            <>
              {/* Fond invisible : capte un tap "à côté" pour refermer, sans jamais
                  assombrir le plateau (rien ne doit visuellement le masquer). */}
              <div className="fan-backdrop" onClick={() => setFanOpen(null)} aria-hidden="true" />
              <div className={`card-fan fan-${sens} ${isClosing ? "fan-closing" : ""}`}>
                {group.cards.map(({ card, handIdx }, i) => (
                  <div key={card.id} className="fan-slot" style={fanSlotVars(i, group.cards.length, sens)}>
                    <Card
                      card={card}
                      owner={owner}
                      extraClass={`hand in-fan ${canDragCard(owner) ? "draggable" : ""} ${drag && drag.owner === owner && drag.idx === handIdx ? "dragging-source" : ""} ${owner === campAugure && hint && hint.cardIdx === handIdx ? "hint-source" : ""}`}
                      onPointerDown={canInteract ? (e) => startCardDrag(owner, handIdx, e) : undefined}
                      selected={!!(selected && selected.owner === owner && selected.idx === handIdx)}
                      concealed={isConcealed(card)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      );
    });
  }

  // Simple clic sur une carte de la main : la sélectionne (ou la désélectionne si elle
  // l'était déjà), sans passer par le glisser. Alternative au glisser pour ceux qui
  // préfèrent survoler le plateau à la souris avant de confirmer.
  // Pose la carte sélectionnée (par clic) sur la case cliquée.
  function playCard(position, e) {
    // ---- Neutralisation du "clic fantôme" ----
    // L'éventail d'Azur s'ouvre vers le haut et mord sur la ligne du bas du plateau.
    // Quand on touche une carte pour la choisir, startCardDrag referme l'éventail
    // immédiatement : au moment où le navigateur émet le clic qui suit le toucher, la
    // carte n'est plus là et c'est la CASE située dessous qui le reçoit. Résultat, la
    // carte se posait toute seule sur la ligne du bas au lieu d'être simplement
    // sélectionnée. On ignore donc un clic qui tombe au même endroit et juste après la
    // saisie. Le double filtre (même endroit ET tout de suite) est volontaire : un vrai
    // clic du joueur, forcément ailleurs sur le plateau ou plus tard, n'est jamais bloqué.
    const grab = fanGrabRef.current;
    if (grab && e && Date.now() - grab.t < 700 && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < 44) {
      fanGrabRef.current = null;
      return;
    }
    fanGrabRef.current = null;
    // Un tap sur le plateau referme un éventail resté ouvert, même s'il n'aboutit à
    // aucune pose (aucune carte sélectionnée) — l'utilisateur "regardait" l'éventail,
    // taper à côté (sur le plateau) le referme, comme taper une seconde fois la vignette.
    setFanOpen(null);
    if (!selected || gameOver || board[position]) return;
    if (selected.owner !== turn) return;
    if (mode === "online" && selected.owner !== onlineRole) return;
    placeCardAt(selected.owner, selected.idx, position, true);
  }

  // Trouve, à partir des coordonnées du pointeur, la case du plateau survolée
  // (via l'attribut data-cell-idx posé sur chaque case).
  function cellIndexAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const cellEl = el && el.closest ? el.closest("[data-cell-idx]") : null;
    if (!cellEl) return null;
    const idx = Number(cellEl.getAttribute("data-cell-idx"));
    return Number.isNaN(idx) ? null : idx;
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(e) {
      const point = e.touches && e.touches[0] ? e.touches[0] : e;
      const dx = point.clientX - drag.startX, dy = point.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 6) dragMovedRef.current = true; // seuil au-delà duquel on considère qu'il y a eu un vrai glisser
      setDrag((d) => (d ? { ...d, x: point.clientX, y: point.clientY } : d));
      const idx = cellIndexAtPoint(point.clientX, point.clientY);
      setDragHoverCell(idx !== null && !board[idx] ? idx : null);
    }
    function onUp(e) {
      const point = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
      const idx = cellIndexAtPoint(point.clientX, point.clientY);
      if (dragMovedRef.current) {
        // Vrai glisser : on pose directement là où le pointeur a été relâché.
        if (idx !== null && !board[idx]) placeCardAt(drag.owner, drag.idx, idx, true);
      } else {
        // Aucun déplacement notable : c'était un simple clic → on sélectionne la carte
        // pour permettre la prévisualisation au survol, sans la poser tout de suite.
        setSelected({ owner: drag.owner, idx: drag.idx });
      }
      setDrag(null);
      setDragHoverCell(null);
    }
    // Tant que la carte est tenue, aucun defilement natif : sur iPhone le rebond
    // elastique de la page peut voler le geste meme quand rien ne depasse. Ecouteur
    // NON passif obligatoire, sinon preventDefault est ignore. Retire au relacher.
    const bloqueDefilement = (ev) => { ev.preventDefault(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", bloqueDefilement, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("touchmove", bloqueDefilement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, board]);

  // Prévisualisation "en direct" pendant le glisser : tant que la carte est maintenue
  // au-dessus d'une case vide valide, on calcule le plateau TEL QU'IL SERAIT si elle y
  // était posée maintenant — rangs modifiés par une capacité (Éveil, Mue, Dévoreuse...)
  // et captures — et on l'affiche directement à la place du plateau réel, sans rien y
  // toucher. Dès que le doigt/curseur quitte la case ou relâche ailleurs, on revient au
  // plateau réel automatiquement (le plateau réel n'est jamais modifié tant qu'on ne
  // relâche pas vraiment dessus).
  const liveDragPreview = useMemo(() => {
    if (!drag || dragHoverCell === null || board[dragHoverCell]) return null;
    const hand = drag.owner === "blue" ? blueHand : redHand;
    const card = hand[drag.idx];
    if (!card) return null;
    const { board: resultBoard, events: previewEvents, poisonedCells: resultPoison } = simulateMove(board, card, dragHoverCell, drag.owner, poisonedCells);
    // Gardiens : leur +1 défensif n'existe que le temps du combat et n'est jamais écrit
    // sur la carte. Pour l'aperçu, on le matérialise visuellement sur le côté attaqué de
    // chaque Gardien ennemi qui a résisté (encore adverse après résolution), pour qu'on
    // voie bien le bouclier. Ce plateau d'aperçu est jetable : le vrai plateau n'est pas touché.
    const previewBoard = resultBoard.slice();
    const pr = Math.floor(dragHoverCell / COLS), pc = dragHoverCell % COLS;
    // Côtés du Gardien qu'on est en train de poser qui frappent réellement un ennemi.
    // On regarde le plateau AVANT résolution : après, un voisin capturé est devenu allié
    // et on ne saurait plus qu'il a été attaqué.
    const cotesAttaquants = [];
    DIRS.forEach((d) => {
      const nr = pr + d.dr, nc = pc + d.dc;
      if (!inBounds(nr, nc)) return;
      const ni = idx(nr, nc);
      // Capacité de base : un Gardien ADVERSE gagne +1 sur le côté qu'on attaque.
      const g = previewBoard[ni];
      if (g && g.ability === "guardian" && g.owner !== drag.owner) {
        previewBoard[ni] = { ...g, guardianBoostedSides: [d.their], [d.their]: g[d.their] + 1 };
      }
      // Capacité supérieure : le Gardien qu'on pose gagne +1 sur chaque côté qui frappe.
      if (card.ability === "guardian" && card.heroActive && board[ni] && board[ni].owner !== drag.owner) {
        cotesAttaquants.push(d.my);
      }
    });
    if (cotesAttaquants.length > 0 && previewBoard[dragHoverCell]) {
      const posee = { ...previewBoard[dragHoverCell], guardianBoostedSides: cotesAttaquants };
      cotesAttaquants.forEach((s) => { posee[s] = previewBoard[dragHoverCell][s] + 1; });
      previewBoard[dragHoverCell] = posee;
    }
    // Résonance en avant-première : on ne montre PAS l'animation de capture (le flip, le
    // changement de couleur n'ont pas encore eu lieu), seulement le clignotement des rangs
    // qui matcheraient, pour que le joueur repère l'opportunité avant de relâcher.
    const resonanceByCell = {};
    previewEvents.forEach((e) => {
      if ((e.kind === "same" || e.kind === "same-self") && e.dir) {
        if (!resonanceByCell[e.index]) resonanceByCell[e.index] = [];
        resonanceByCell[e.index].push(e.dir);
      }
    });
    return { board: previewBoard, poisonedCells: resultPoison, resonanceByCell };
  }, [drag, dragHoverCell, board, blueHand, redHand, poisonedCells]);
  const liveDragPreviewBoard = liveDragPreview ? liveDragPreview.board : null;

  const draggedCard = drag ? (drag.owner === "blue" ? blueHand : redHand)[drag.idx] : null;

  // Sauvegarde automatique : à chaque coup joué, on garde une trace légère de la
  // partie en cours pour pouvoir la reprendre si la page se ferme par accident.
  useEffect(() => {
    // Les parties en ligne ne sont pas sauvegardées localement : Firestore fait déjà foi,
    // et la reprise locale ne connaît pas le code de partie / le rôle en ligne.
    if (phase !== "play" || mode === "online") return;
    // Une partie TERMINEE n'a rien a reprendre. La garder en sauvegarde faisait
    // reapparaitre "Reprendre la partie en cours" apres un rechargement, et la reprise
    // rejouait l'enregistrement des statistiques (le verrou est neuf a chaque
    // chargement) : chaque aller-retour recharger -> Reprendre offrait une partie de
    // maitrise a chaque Ordre de la main, sans jouer un coup. On efface des que l'issue
    // tombe.
    if (gameOver) { clearSavedGame(); return; }
    try {
      const data = {
        board: board.map(stripForSave),
        blueHand: blueHand.map(stripForSave),
        redHand: redHand.map(stripForSave),
        poisonedCells, turn, firstPlayer, mode, gameOver, confluenceActive, botDifficulty,
        blueOrderKeys: blueOrders.map((l) => l.key),
        redOrderKeys: redOrders.map((l) => l.key),
      };
      sessionStorage.setItem("emprise-save", JSON.stringify(data));
      setHasSavedGame(true);
    } catch (e) { /* stockage indisponible : tant pis, on continue sans sauvegarder */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, blueHand, redHand, poisonedCells, turn, gameOver, phase]);

  // Tour du bot (uniquement en mode "vs Bot")
  useEffect(() => {
    if (mode !== "bot" || phase !== "play" || gameOver || turn !== "red") return;
    const timer = setTimeout(() => {
      const move = botChooseMove(board, redHand, blueHand, "red", "blue", botDifficulty, poisonedCells);
      if (move) placeCardAt("red", move.cardIdx, move.cellIdx);
    }, 3200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, turn, phase, gameOver, board, redHand, blueHand, botDifficulty]);

  // Draft Confluence contre le bot : quand c'est au bot de choisir un Ordre, il pioche
  // automatiquement au hasard après un court délai (le bot ne "réfléchit" pas stratégiquement
  // à ce choix, contrairement à ses coups en partie).
  useEffect(() => {
    if (mode !== "bot" || phase !== "confluence-draft" || draft.turn !== "red") return;
    const timer = setTimeout(() => {
      const remaining = ORDERS.filter((l) => isOrderAvailable(l) && !draft.pool.includes(l.key));
      if (remaining.length > 0) {
        const pick = remaining[Math.floor(Math.random() * remaining.length)];
        pickDraftOrder(pick.key);
      }
    }, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phase, draft.turn, draft.pool]);

  // Minuteur de tour : ne compte que pendant un tour JOUEUR (jamais pendant que le bot réfléchit).
  // En ligne, chaque appareil ne gère QUE le minuteur de son propre camp (onlineRole) —
  // sinon les deux appareils décompteraient et auto-joueraient pour les deux camps à la fois.
  const isHumanTurn =
    phase === "play" && !gameOver &&
    (mode === "online" ? turn === onlineRole : (turn === "blue" || (mode === "local" && turn === "red")));

  useEffect(() => {
    setTimeLeft(TURN_SECONDS);
    autoForfaitRef.current = false;
  }, [turn, phase]);

  // Garde-fou d'inactivité en ligne : le minuteur de l'adversaire tourne sur SON appareil.
  // S'il ferme l'application ou verrouille son téléphone, rien n'auto-joue pour lui et la
  // partie resterait figée à jamais. Le joueur qui attend compte donc de son côté : passé
  // l'équivalent de 2 tours complets (plus une marge réseau), il constate le forfait et
  // l'écrit dans le document — les deux appareils voient alors la partie se terminer.
  const FORFAIT_APRES_S = TURN_SECONDS * 2 + 15;
  useEffect(() => {
    if (mode !== "online" || phase !== "play" || gameOver || turn === onlineRole || !onlineGameId) {
      setAttenteAdv(0);
      forfaitEcritRef.current = false;
      return;
    }
    const debut = Date.now();
    const t = setInterval(() => {
      const ecoulees = Math.floor((Date.now() - debut) / 1000);
      setAttenteAdv(ecoulees);
      if (ecoulees >= FORFAIT_APRES_S && !forfaitEcritRef.current) {
        forfaitEcritRef.current = true;
        // Précondition dans la transaction : le fautif n'a toujours pas joué (c'est
        // encore son tour). S'il a joué pendant notre attente, on ne touche à rien.
        deposerAbandon(onlineGameId, turn, "forfait", (d) => d.turn === turn)
          .then((fait) => { if (!fait) forfaitEcritRef.current = false; });
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phase, gameOver, turn, onlineGameId]);

  // Forfait d'AVANT-match : je suis prêt (mes Ordres confirmés, écran d'attente), les
  // deux sièges sont pris, mais l'adversaire ne choisit pas les siens. Passé le même
  // délai que le forfait de jeu, on constate son absence — la précondition est revérifiée
  // dans la transaction (ses Ordres toujours manquants). C'est ce qui permet de GAGNER
  // contre un inscrit fantôme en tournoi au lieu de devoir lui offrir la victoire.
  useEffect(() => {
    const enAttente = mode === "online" && !!onlineGameId && phase === "online-waiting"
      && !fileAttente && advPresent && !advPret && !gameOver;
    if (!enAttente) { setAttentePreMatch(0); preForfaitEcritRef.current = false; return; }
    const debut = Date.now();
    const cleAdv = onlineRole === "blue" ? "redOrderKeys" : "blueOrderKeys";
    const fautif = onlineRole === "blue" ? "red" : "blue";
    const t = setInterval(() => {
      const ecoulees = Math.floor((Date.now() - debut) / 1000);
      setAttentePreMatch(ecoulees);
      if (ecoulees >= FORFAIT_APRES_S && !preForfaitEcritRef.current) {
        preForfaitEcritRef.current = true;
        deposerAbandon(onlineGameId, fautif, "forfait", (d) => !d[cleAdv])
          .then((fait) => { if (!fait) preForfaitEcritRef.current = false; });
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, onlineGameId, phase, fileAttente, advPresent, advPret, gameOver]);

  // Minuteur du choix des Ordres. Reserve au jeu en ligne : en solo, personne n'attend
  // en face, et imposer une horloge la ou le joueur reflechit tranquillement n'aurait
  // aucun sens.
  const minuteurOrdresActif = mode === "online" && phase === "select-blue" && !gameOver;
  useEffect(() => {
    if (!minuteurOrdresActif) { setTempsOrdres(ORDRES_SECONDS); ordresAutoRef.current = false; return; }
    if (tempsOrdres <= 0) {
      if (ordresAutoRef.current) return;
      ordresAutoRef.current = true;
      // On respecte le choix en cours s'il est complet, sinon on tire au sort : mieux
      // vaut une main choisie au hasard qu'une partie qui ne demarre jamais.
      if (pickerChoice.length === 2) confirmOrders();
      else chooseRandomOrders();
      return;
    }
    const t = setTimeout(() => setTempsOrdres((n) => n - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minuteurOrdresActif, tempsOrdres]);

  useEffect(() => {
    if (!isHumanTurn || testMode) return; // pas de minuteur en mode test
    if (timeLeft <= 0 && mode !== "online") {
      // Hors ligne : temps écoulé, un coup aléatoire est joué automatiquement — les
      // joueurs sont dans la même pièce, la partie ne doit jamais rester figée.
      const hand = turn === "blue" ? blueHand : redHand;
      const opponentHand = turn === "blue" ? redHand : blueHand;
      const move = botChooseMove(board, hand, opponentHand, turn, turn === "blue" ? "red" : "blue", "debutant", poisonedCells);
      if (move) placeCardAt(turn, move.cardIdx, move.cellIdx);
      return;
    }
    // En ligne, AUCUN coup automatique : ne pas jouer est un choix qui se paie. Le
    // décompte continue sous zéro pendant l'équivalent d'un second tour, affiché au
    // joueur ; au bout de 2 tours complets sans jouer, son propre client constate le
    // forfait (transaction, seulement si c'est toujours son tour). Le garde-fou de
    // l'adversaire reste en secours si cet appareil a disparu.
    if (mode === "online" && timeLeft <= -TURN_SECONDS) {
      if (!autoForfaitRef.current) {
        autoForfaitRef.current = true;
        deposerAbandon(onlineGameId, onlineRole, "forfait", (d) => d.turn === onlineRole)
          .then((fait) => { if (!fait) autoForfaitRef.current = false; });
      }
      return;
    }
    const t = setTimeout(() => setTimeLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHumanTurn, timeLeft, turn, board, blueHand, redHand]);

  // Minuteur du draft (15s) : ne tourne que pour un choix HUMAIN — jamais pendant le tour du
  // bot en Confluence contre bot, qui pioche lui-même via l'effet dédié ci-dessus.
  useEffect(() => {
    if (phase !== "confluence-draft") return;
    if (mode === "bot" && draft.turn === "red") return;
    if (draft.timeLeft <= 0) {
      const remaining = ORDERS.filter((l) => isOrderAvailable(l) && !draft.pool.includes(l.key));
      if (remaining.length > 0) {
        const pick = remaining[Math.floor(Math.random() * remaining.length)];
        pickDraftOrder(pick.key);
      }
      return;
    }
    const t = setTimeout(() => setDraft((d) => ({ ...d, timeLeft: d.timeLeft - 1 })), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, draft.timeLeft, draft.turn, draft.pool, mode]);


  return (
    <div
      className={`emprise-root ${reducedMotion ? "reduced-motion" : ""} ${phase === "play" ? "ecran-jeu" : ""}`}
    >
      <style>{APP_STYLES}</style>

      {phase === "landing" && (
        <div className={`landing hub intro-e${introEtape}`}>
          {/* Voile noir de la première étape : recouvre tout, puis s'efface pour laisser
              apparaître l'illustration. Retiré du DOM une fois l'intro finie. */}
          {introEtape < 2 && <div className="landing-voile" aria-hidden="true" />}
          <img className="landing-hero" src={ORDERS.find((l) => l.key === "devoreuse")?.portrait} alt="" />

          {/* ---------- Bandeau du haut : joueur, trophées, réglages ---------- */}
          <header className="hub-haut">
            <div className="hub-joueur">
              {/* Le pseudo est la porte du profil : on y lit le genre de joueur qu'on est.
                  Il reste en dur pour l'instant, faute de comptes nommes. */}
              <button className="hub-pseudo" onClick={() => setActiveModal("profil")} aria-haspopup="dialog" title="Voir mon profil">
                CARNAGE
                {titrePrincipal(stats) && <span className="hub-pseudo-titre">{titrePrincipal(stats)}</span>}
              </button>
              <span className="hub-trophees" title="Trophées">
                <svg className="hub-icone-coupe" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 4h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V6h3V4zm-1 4v1a2 2 0 0 0 2 2V8H6zm12 0h-2v3a2 2 0 0 0 2-2V8z" />
                </svg>
                <span className="hub-trophees-nombre">{stats.trophies || 0}</span>
              </span>
            </div>
            <span className="hub-haut-boutons">
            <button
              className="hub-rouage hub-horloge"
              onClick={() => setActiveModal("historique")}
              aria-label="Dernières parties classées"
              title="Dernières parties classées"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm1 3v5.2l3.5 2.1-1 1.7L11 13.5V7h2z" />
              </svg>
            </button>
            <button
              className="hub-rouage"
              onClick={() => setActiveModal("settings")}
              aria-label="Réglages"
              title="Réglages"
            >
              <img className="hub-rouage-img" src="/nav/rouage.webp" alt="" />
              <svg viewBox="0 0 24 24" aria-hidden="true" style={{ display: "none" }}>
                <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                <path d="M10.6 2h2.8l.5 2.3c.5.2 1 .4 1.5.7l2.2-1 2 3.4-1.8 1.5c0 .3.1.7.1 1.1s0 .8-.1 1.1l1.8 1.5-2 3.4-2.2-1c-.5.3-1 .5-1.5.7l-.5 2.3h-2.8l-.5-2.3c-.5-.2-1-.4-1.5-.7l-2.2 1-2-3.4 1.8-1.5c0-.3-.1-.7-.1-1.1s0-.8.1-1.1L4.4 7.4l2-3.4 2.2 1c.5-.3 1-.5 1.5-.7L10.6 2zm1.4 4.5A5.5 5.5 0 1 0 17.5 12 5.5 5.5 0 0 0 12 6.5z" />
              </svg>
            </button>
            </span>
          </header>

          {/* ---------- Pages du hub ---------- */}
          <main className="hub-pages">
            {hubPage === "boutique" && (
              <section key="boutique" className={`hub-page hub-glisse-${hubSens}`} aria-label="Boutique">
                <div className="hub-boutique-vide" role="status">
                  <svg className="hub-boutique-icone" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 8l1.5-4h11L19 8v12H5V8zm2.3-2l-.75 2h10.9l-.75-2H7.3zM7 10v8h10v-8H7zm3 2h4v2h-4v-2z" />
                  </svg>
                  <h2 className="hub-boutique-titre">Boutique</h2>
                  <p className="hub-boutique-texte">Prochainement.</p>
                  <p className="hub-boutique-sous">Les marchands de la Faille préparent leurs étals.</p>
                </div>
              </section>
            )}
            {hubPage === "jouer" && (
              <section key="jouer" className={`hub-page hub-glisse-${hubSens}`} aria-label="Jouer">
                <div className="landing-emblem"><span className="landing-line-single" /></div>
                <h1 className="landing-title">EMPRISE</h1>
                <p className="landing-subtitle">Un duel de cartes stratégique</p>
                <div className="league-badge">Le multijoueur arrive prochainement</div>

                {/* Seules les parties SOLO se reprennent. En ligne, un adversaire attend
                    en face : une partie quittee est abandonnee, le forfait tranche pour
                    celui qui reste. Proposer d'y revenir laissait croire le contraire. */}
                {hasSavedGame && (
                  <button className="landing-link" onClick={resumeSavedGame}>Reprendre la partie en cours</button>
                )}

                {/* L'arène de la ligue : la pièce centrale du hub, et ce qui pousse les
                    deux boutons vers le bas de l'écran, à portée du pouce. Seul le Bronze
                    a son illustration pour l'instant ; les ligues suivantes reprendront la
                    même tant que les leurs n'existent pas, plutôt que d'afficher un trou.
                    Si le fichier venait à manquer, l'image s'efface et le nom reste. */}
                <button className="hub-arene" onClick={() => setActiveModal("arenes")} aria-haspopup="dialog" title="Voir toutes les arènes">
                  <span className="hub-arene-nom">Arène {getLeague(stats.trophies || 0).name}</span>
                  <img
                    className="hub-arene-img"
                    src={getLeague(stats.trophies || 0).hub || "/arenes/bronze-hub.webp"}
                    alt=""
                    onError={(e) => { e.currentTarget.style.display = "none"; }}
                  />
                </button>

                {/* Les retours en ligne ratés (adversaire parti, réseau coupé) ramènent
                    ici : sans cet avis, le joueur se retrouvait au hub sans savoir
                    pourquoi. Un clic le chasse. */}
                {onlineError && (
                  <div className={`online-error hub-avis ${avisBon ? "avis-bon" : ""}`} role="status" onClick={() => { setOnlineError(""); setAvisBon(false); }}>
                    {onlineError}
                  </div>
                )}

                {/* Deux entrees seulement : le Classe, action phare, et la porte vers
                    tous les autres modes. Le detail vit dans un panneau, la page reste
                    epuree comme un ecran d'accueil de jeu mobile. */}
                <div className="hub-jouer-rang">
                  <button className="hub-jouer-classe" onClick={chercherAdversaire}>
                    <img className="hub-jouer-classe-img" src="/nav/classe.webp" alt="" />
                    <span className="hub-jouer-classe-titre">Classé</span>
                    <span className="hub-jouer-classe-sous">Trouver un adversaire</span>
                  </button>
                  <button className="hub-jouer-modes-btn" onClick={() => setActiveModal("modes")} aria-haspopup="dialog">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7zm-7-7v3h3V6H6zm9 0v3h3V6h-3zM6 15v3h3v-3H6zm9 0v3h3v-3h-3z" />
                    </svg>
                    <span className="hub-jouer-classe-titre">Modes</span>
                    <span className="hub-jouer-classe-sous">Tous les autres</span>
                  </button>
                </div>
              </section>
            )}
            {hubPage === "ordres" && (
              <section key="ordres" className={`hub-page hub-glisse-${hubSens}`} aria-label="Les Ordres">
                <h2 className="hub-page-titre">Les Ordres</h2>
                <p className="hub-page-sous">Votre maîtrise de chaque maison, partie après partie.</p>
                {/* Cette page dit quel joueur on est, Ordre par Ordre : chaque portrait se
                    remplit de sa couleur a la hauteur de la maitrise, gris au-dessus. Un
                    Ordre jamais joue est entierement gris. On appuie pour l'agrandir et
                    lire le detail. Le Geolier garde son portrait scelle : le cadenas dit tout. */}
                <div className="hub-ordres-grille4">
                  {ORDERS.map((order) => {
                    const bientot = !isOrderAvailable(order);
                    const m = maitriseOrdre(stats, order.key);
                    return (
                      <button
                        key={order.key}
                        type="button"
                        className={`hub-ordre-vignette ${bientot ? "scellee" : ""}`}
                        title={bientot ? "Bientôt disponible" : `${order.name} · ${m.pourcent} %`}
                        onClick={() => { if (!bientot) setOrdreDetail(order.key); }}
                        disabled={bientot}
                      >
                        <div className="hub-ordre-cadre">
                          {bientot ? (
                            <ComingSoonThumb order={order} />
                          ) : (
                            <VagueMaitrise order={order} taux={m.taux} />
                          )}
                          <span className="hub-ordre-vignette-nom">{order.name}</span>
                          {!bientot && <span className="hub-ordre-pourcent">{m.pourcent} %</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </main>

          {/* ---------- Navigation basse : Boutique, Jouer (central), Ordres ---------- */}
          <nav className="hub-nav" aria-label="Navigation du hub">
            {/* Degrade metallique partage par les trois icones. Un seul <defs> pour tout
                le hub : les tracés y font référence par identifiant. */}
            <svg className="hub-nav-defs" aria-hidden="true" focusable="false">
              <defs>
                <linearGradient id="or-metal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f2dfae" />
                  <stop offset="38%" stopColor="#e8c877" />
                  <stop offset="100%" stopColor="#b89742" />
                </linearGradient>
              </defs>
            </svg>
            <button
              className={`hub-onglet ${hubPage === "boutique" ? "actif" : ""}`}
              onClick={() => allerPageHub("boutique")}
              aria-current={hubPage === "boutique" ? "page" : undefined}
            >
              <img className="hub-onglet-img" src="/nav/boutique.webp" alt="" onError={(e) => { e.currentTarget.style.display = "none"; const s2 = e.currentTarget.nextElementSibling; if (s2) s2.style.display = ""; }} />
              <svg viewBox="0 0 24 24" aria-hidden="true" style={{ display: "none" }}>
                <path fillRule="evenodd" d="M6.4 3h11.2L21 8.4H3L6.4 3zM4.6 10h14.8v11H4.6V10zm5.2 3.4v5.2h4.4v-5.2H9.8z" />
              </svg>
              <span>Boutique</span>
            </button>
            <button
              className={`hub-onglet hub-onglet-central ${hubPage === "jouer" ? "actif" : ""}`}
              onClick={() => allerPageHub("jouer")}
              aria-current={hubPage === "jouer" ? "page" : undefined}
            >
              <img className="hub-onglet-img" src="/nav/jouer.webp" alt="" onError={(e) => { e.currentTarget.style.display = "none"; const s2 = e.currentTarget.nextElementSibling; if (s2) s2.style.display = ""; }} />
              <svg viewBox="0 0 24 24" aria-hidden="true" style={{ display: "none" }}>
                <path d="M4 3l6.2 6.2-1.4 1.4L4 6.4V3zm16 0v3.4l-9.9 9.9 1.8 1.8-1.4 1.4-2.1-2.1L6 19.8 4.2 18l2.4-2.4-2.1-2.1 1.4-1.4 1.8 1.8L17.6 4H20zM6.4 4H4v2.4L6.4 4zm11.4 8.4l2.2 2.2-1.4 1.4 1.8 1.8L18.6 19.6l-1.8-1.8-1.4 1.4-2.2-2.2 4.6-4.6z" />
              </svg>
              <span>Jouer</span>
            </button>
            <button
              className={`hub-onglet ${hubPage === "ordres" ? "actif" : ""}`}
              onClick={() => allerPageHub("ordres")}
              aria-current={hubPage === "ordres" ? "page" : undefined}
            >
              <img className="hub-onglet-img" src="/nav/ordres.webp" alt="" onError={(e) => { e.currentTarget.style.display = "none"; const s2 = e.currentTarget.nextElementSibling; if (s2) s2.style.display = ""; }} />
              <svg viewBox="0 0 24 24" aria-hidden="true" style={{ display: "none" }}>
                <path fillRule="evenodd" d="M12 1.6l8.6 3.2v6.4c0 5.4-3.6 10.1-8.6 11.8-5-1.7-8.6-6.4-8.6-11.8V4.8L12 1.6zm-.9 5.2v4.4H8.4v1.8h2.7v4.4h1.8v-4.4h2.7v-1.8h-2.7V6.8h-1.8z" />
              </svg>
              <span>Ordres</span>
            </button>
          </nav>

          {ordreDetail && (() => {
            const order = ORDERS.find((o) => o.key === ordreDetail);
            if (!order) return null;
            const m = maitriseOrdre(stats, order.key);
            return (
              <div className="info-overlay ordre-detail-voile" onClick={() => setOrdreDetail(null)}>
                <div className="ordre-detail" onClick={(e) => e.stopPropagation()}>
                  {/* A gauche la carte, grossie ; a droite ce qu'elle dit de vous. */}
                  <div className="ordre-detail-carte">
                    <VagueMaitrise order={order} taux={m.taux} grand />
                  </div>
                  <div className="ordre-detail-texte">
                    <div className="ordre-detail-pourcent">{m.pourcent} %</div>
                    <div className="ordre-detail-nom">{order.name}</div>
                    <div className="ordre-detail-rang">
                      <span className="ordre-detail-rang-num">{m.numero}/{MAITRISE_RANGS.length}</span>
                      {m.rang.nom}
                    </div>
                    {/* Ni compte de parties, ni "encore X pour..." : chiffrer le chemin en
                        fait une corvee. Le rang et le pourcentage suffisent, le reste se
                        decouvre en jouant. */}
                    <div className="ordre-detail-parties">
                      {m.parties === 0
                        ? "Jamais joué"
                        : m.parties >= MAITRISE_PARTIES_MAX
                        ? "Maîtrise complète"
                        : m.suivant
                        ? `Prochain rang : ${m.suivant.nom}`
                        : ""}
                    </div>
                    <p className="ordre-detail-desc">{order.desc}</p>
                  </div>
                  <button className="arenes-fermer ordre-detail-fermer" onClick={() => setOrdreDetail(null)} aria-label="Fermer">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
              </div>
            );
          })()}

          {activeModal === "arenes" && (() => {
            const ligue = getLeague(stats.trophies || 0);
            // Une echelle se gravit : le Bronze occupe le bas, la Legende le sommet. On
            // renverse donc l'ordre des ligues, et l'on ouvre la galerie sur l'arene ou
            // le joueur se trouve — sinon il tomberait sur la Legende, qu'il n'a pas.
            const echelle = LEAGUES.slice().reverse();
            const rang = Math.max(0, echelle.findIndex((l) => l.name === ligue.name));
            return (
              <div className="info-overlay arenes-voile" onClick={() => setActiveModal(null)}>
                {/* Une arene par ecran, calee au defilement : on part de la sienne et l'on
                    monte vers les suivantes. Le voile se ferme au clic a cote. */}
                <div
                  className="arenes-defile"
                  ref={(el) => {
                    // Une seule fois par ouverture : la fonction de ref est rappelee a
                    // chaque rendu, et recaler le defilement a chaque fois empecherait le
                    // joueur de bouger.
                    if (!el || el.dataset.cale) return;
                    el.dataset.cale = "1";
                    const page = el.children[rang];
                    if (page) el.scrollTop = page.offsetTop;
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {echelle.map((l, i) => {
                    const ici = l.name === ligue.name;
                    // Verrouillee tant que les trophees n'atteignent pas son seuil. On la
                    // montre quand meme, assombrie : savoir ce qu'on vise vaut mieux qu'une
                    // case vide, et le cadenas dit clairement que ce n'est pas encore a soi.
                    const verrouillee = (stats.trophies || 0) < l.min;
                    return (
                      <section key={l.name} className={`arene-page ${ici ? "ici" : ""}`}>
                        {i > 0 && (
                          <span className="arene-page-fleche" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M12 4v14M6 10l6-6 6 6" /></svg>
                            arène supérieure
                          </span>
                        )}
                        {/* Le nom coiffe la page : on doit savoir ou l'on est des que
                            l'arene se pose, sans avoir a descendre le regard. */}
                        <div className="arene-page-entete">
                          <div className="arene-page-nom">Arène {l.name}</div>
                          <div className={`arene-page-seuil ${verrouillee ? "a-conquerir" : ""}`}>
                            {l.min === 0
                              ? "Dès votre premier duel"
                              : verrouillee
                              ? `Encore ${l.min - (stats.trophies || 0)} trophées`
                              : `À partir de ${l.min} trophées`}
                          </div>
                          {ici && <span className="arene-page-ici">Vous êtes ici</span>}
                        </div>
                        <div className={`arene-page-corps ${verrouillee ? "verrouillee" : ""}`}>
                          {l.hub ? (
                            <img className="arene-page-img" src={l.hub} alt="" />
                          ) : (
                            <div className="arene-page-chantier" aria-hidden="true">
                              <svg viewBox="0 0 24 24"><path d="M12 2 2 20h20L12 2zm0 5 6 11H6l6-11zm-1 3v4h2v-4h-2zm0 5v2h2v-2h-2z" /></svg>
                              <span>En construction</span>
                            </div>
                          )}
                          {verrouillee && (
                            <span className="arene-cadenas-rond" aria-label="Arène verrouillée">
                              <img src="/arenes/cadenas.webp" alt="" />
                            </span>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
                <button className="arenes-fermer" onClick={() => setActiveModal(null)} aria-label="Fermer">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            );
          })()}

          {activeModal === "profil" && (() => {
            const profil = titresDuProfil(stats);
            const total = stats.gamesPlayed || 0;
            const victoires = stats.mesVictoires || 0;
            return (
              <div className="info-overlay" onClick={() => setActiveModal(null)}>
                <div className="info-panel settings-panel profil-panel" onClick={(e) => e.stopPropagation()}>
                  <div className="info-panel-title">CARNAGE</div>

                  <div className="profil-chiffres">
                    <div><b>{total}</b><span>parties</span></div>
                    <div><b>{victoires}</b><span>victoires</span></div>
                    <div><b>{stats.trophies || 0}</b><span>trophées</span></div>
                  </div>

                  <div className="modes-groupe-titre">Le joueur que vous êtes</div>
                  {profil.titres.length > 0 ? (
                    profil.titres.map((t, i) => (
                      <div key={t.combo.key} className={`profil-titre ${i === 0 ? "principal" : ""}`}>
                        <div className="profil-titre-haut">
                          <span className="profil-titre-nom">{t.combo.nom}</span>
                          <span className="profil-titre-taux">{Math.round(t.taux * 100)} %</span>
                        </div>
                        <span className="profil-titre-recit">{t.combo.recit}</span>
                        <span className="profil-titre-ordres">
                          {t.combo.ordres.map((k) => ORDERS.find((o) => o.key === k)?.name).filter(Boolean).join(" + ")}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="profil-vide">
                      {profil.pret
                        ? "Vous jouez de tout, sans manie affirmée. Aucun combo ne revient assez souvent pour vous donner un titre."
                        : `Encore ${profil.restantes} partie${profil.restantes > 1 ? "s" : ""} avant qu'un style se dégage. Seules comptent vos parties à deux Ordres, contre un Écho ou en ligne.`}
                    </div>
                  )}

                  {profil.classement.length > 0 && (
                    <>
                      <div className="modes-groupe-titre">Combos réalisés</div>
                      <div className="profil-liste">
                        {profil.classement.map((t) => (
                          <div key={t.combo.key} className="profil-ligne" title={t.combo.signe}>
                            <span className="profil-ligne-nom">{t.combo.nom}</span>
                            <span className="profil-ligne-jauge"><i style={{ width: `${Math.min(100, Math.round(t.taux * 100))}%` }} /></span>
                            <span className="profil-ligne-nombre">{t.parties}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <button className="reset-btn" onClick={() => setActiveModal(null)}>Fermer</button>
                </div>
              </div>
            );
          })()}

          {activeModal === "modes" && (
            <div className="info-overlay" onClick={() => setActiveModal(null)}>
              <div className="info-panel settings-panel modes-panel" onClick={(e) => e.stopPropagation()}>
                <div className="info-panel-title">Modes de jeu</div>

                <div className="modes-groupe-titre">Contre un Écho</div>
                <div className="modes-groupe">
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); chooseMode("bot"); }} aria-label="Contre un Écho : Solo, 4 niveaux de difficulté" title="Solo, 4 niveaux de difficulté">
                    <img src={ORDERS.find((o) => o.key === "eveil")?.portrait} alt="" />
                    <span>Contre un Écho</span>
                  </button>
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); setPhase("chapters"); }} aria-label="Mode Histoire : 8 chapitres solo, un par Ordre" title="8 chapitres solo, un par Ordre">
                    <img src={ORDERS.find((o) => o.key === "cendres")?.portrait} alt="" />
                    <span>Mode Histoire</span>
                  </button>
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); chooseConfluenceBot(); }} aria-label="Confluence (Écho) : 8 Ordres draftés à tour de rôle, même main pour les deux" title="8 Ordres draftés à tour de rôle, même main pour les deux">
                    <img src={ORDERS.find((o) => o.key === "portee")?.portrait} alt="" />
                    <span>Confluence (Écho)</span>
                  </button>
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); setPhase("tourney-menu"); }} aria-label="Tournoi : 8 Commandants, trois tours, un seul champion" title="8 Commandants, trois tours, un seul champion">
                    <img src={ORDERS.find((o) => o.key === "maudits")?.portrait} alt="" />
                    <span>Tournoi</span>
                  </button>
                </div>

                <div className="modes-groupe-titre">À deux sur le même écran</div>
                <div className="modes-groupe">
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); chooseMode("local"); }} aria-label="2 Commandants : Chacun son tour, sur le même téléphone" title="Chacun son tour, sur le même téléphone">
                    <img src={ORDERS.find((o) => o.key === "cendres")?.portrait} alt="" />
                    <span>2 Commandants</span>
                  </button>
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); chooseConfluenceLocal(); }} aria-label="Confluence (à 2) : 8 Ordres draftés à tour de rôle, même téléphone" title="8 Ordres draftés à tour de rôle, même téléphone">
                    <img src={ORDERS.find((o) => o.key === "mue")?.portrait} alt="" />
                    <span>Confluence (à 2)</span>
                  </button>
                </div>

                <div className="modes-groupe-titre">En ligne</div>
                <div className="modes-groupe">
                  <button className="hub-mode-tuile" onClick={() => { setActiveModal(null); setOnlineError(""); setPhase("online-menu"); }} aria-label="Jouer avec un ami : À distance, avec un code de partie à partager" title="À distance, avec un code de partie à partager">
                    <img src={ORDERS.find((o) => o.key === "mue")?.portrait} alt="" />
                    <span>Jouer avec un ami</span>
                  </button>
                </div>

                <div className="modes-groupe-titre">Bac à sable</div>
                <div className="modes-groupe">
                  <button className="hub-mode-tuile test" onClick={() => { setActiveModal(null); chooseTestMode(); }} aria-label="Mode test : Bac à sable : les 2 camps, tous les Ordres, sans minuteur" title="Bac à sable : les 2 camps, tous les Ordres, sans minuteur">
                    <img src={ORDERS.find((o) => o.key === "guardian")?.portrait} alt="" />
                    <span>Mode test</span>
                  </button>
                </div>

                <button className="reset-btn" onClick={() => setActiveModal(null)}>Fermer</button>
              </div>
            </div>
          )}

          {activeModal === "historique" && (
            <div className="info-overlay" onClick={() => setActiveModal(null)}>
              <div className="info-panel settings-panel" onClick={(e) => e.stopPropagation()}>
                <div className="info-panel-title">Dernières parties classées</div>
                {historique.length === 0 && (
                  <div className="histo-vide" role="status">
                    <p>Aucune partie classée terminée pour le moment.</p>
                    <p className="histo-vide-sous">Vos 3 dernières parties classées apparaîtront ici. Les autres modes ne sont pas comptés.</p>
                  </div>
                )}
                {historique.map((h, i) => {
                  const resultat = h.camp
                    ? (h.vainqueur === h.camp ? "Victoire" : "Défaite")
                    : (h.vainqueur === "blue" ? "Azur l'emporte" : "Écarlate l'emporte");
                  const gagnee = h.camp ? h.vainqueur === h.camp : null;
                  return (
                    <div key={h.t + "-" + i} className="histo-ligne">
                      <div className={`histo-resultat ${gagnee === true ? "gagnee" : gagnee === false ? "perdue" : ""}`}>
                        {resultat}
                        {h.motif === "abandon" && <span className="histo-motif"> (abandon)</span>}
                        {h.motif === "forfait" && <span className="histo-motif"> (forfait)</span>}
                      </div>
                      <div className="histo-detail">
                        {/* Toutes les lignes etant classees, le nom du mode n'apprendrait
                            rien : la variation de trophees, elle, est l'enjeu du mode. */}
                        <span className="histo-mode">
                          {typeof h.trophees === "number" && h.trophees !== 0
                            ? `${h.trophees > 0 ? "+" : ""}${h.trophees} trophées`
                            : "Classé"}
                        </span>
                        <span className="histo-score"><b className="histo-sb">{h.sb}</b> &middot; <b className="histo-sr">{h.sr}</b></span>
                        <span className="histo-quand">{ilYa(h.t)}</span>
                      </div>
                    </div>
                  );
                })}
                <button className="reset-btn" onClick={() => setActiveModal(null)}>Fermer</button>
              </div>
            </div>
          )}

          {activeModal === "settings" && (
            <div className="info-overlay" onClick={() => setActiveModal(null)}>
              <div className="info-panel settings-panel" onClick={(e) => e.stopPropagation()}>
                <div className="info-panel-title">Réglages</div>
                <div className="settings-row" role="button" tabIndex={0} onClick={() => { setActiveModal(null); startTutorial(); }} onKeyDown={KEY_ACTIVATE(() => { setActiveModal(null); startTutorial(); })}>
                  <div className="settings-texte">
                    <div className="settings-nom">Tutoriel</div>
                    <div className="settings-desc">Apprenez à jouer en quelques coups guidés.</div>
                  </div>
                  <span className="settings-fleche" aria-hidden="true">›</span>
                </div>
                <div className="settings-row" role="button" tabIndex={0} onClick={() => setActiveModal("story")} onKeyDown={KEY_ACTIVATE(() => setActiveModal("story"))}>
                  <div className="settings-texte">
                    <div className="settings-nom">L'Histoire</div>
                    <div className="settings-desc">La Faille, les deux camps et le Rite d'Emprise.</div>
                  </div>
                  <span className="settings-fleche" aria-hidden="true">›</span>
                </div>
                <div className="settings-row" role="button" tabIndex={0} onClick={() => setActiveModal("rules")} onKeyDown={KEY_ACTIVATE(() => setActiveModal("rules"))}>
                  <div className="settings-texte">
                    <div className="settings-nom">Règles du jeu</div>
                    <div className="settings-desc">Capture, Résonance, Onde et capacités d'Ordre.</div>
                  </div>
                  <span className="settings-fleche" aria-hidden="true">›</span>
                </div>
                <div className="settings-row" role="button" tabIndex={0} onClick={() => setActiveModal("stats")} onKeyDown={KEY_ACTIVATE(() => setActiveModal("stats"))}>
                  <div className="settings-texte">
                    <div className="settings-nom">Statistiques</div>
                    <div className="settings-desc">Parties jouées, victoires, trophées.</div>
                  </div>
                  <span className="settings-fleche" aria-hidden="true">›</span>
                </div>
                <div className="settings-row" role="button" tabIndex={0} onClick={toggleReducedMotion} onKeyDown={KEY_ACTIVATE(toggleReducedMotion)}>
                  <div className="settings-texte">
                    <div className="settings-nom">Animations réduites</div>
                    <div className="settings-desc">Raccourcit les effets de capacité et saute les cérémonies.</div>
                  </div>
                  <div className={`settings-bascule ${reducedMotion ? "on" : ""}`} aria-hidden="true"><span /></div>
                </div>
                <button className="reset-btn" onClick={() => setActiveModal(null)}>Fermer</button>
              </div>
            </div>
          )}

          {activeModal === "story" && (
            <div className="info-overlay" onClick={() => setActiveModal(null)}>
              <div className="info-panel rules-panel" onClick={(e) => e.stopPropagation()}>
                <div className="info-panel-title">L'Histoire</div>

                <div className="rules-section">
                  <div className="rules-h">Avant la Faille</div>
                  <div className="rules-p">Bien avant que le monde ne se scinde en deux camps, dix Ordres légendaires arpentaient déjà les terres, chacun selon ses propres lois : les <b>Dorés</b>, confrérie sacrée de champions cuirassés d'or ; les <b>Cendres</b>, guerriers nés des braises d'anciens volcans ; les <b>Piques</b>, phalanges disciplinées des plaines ; les <b>Archers</b>, chasseurs silencieux des forêts profondes ; les <b>Abysses</b>, horreurs remontées des tréfonds océaniques ; les <b>Chimères</b>, êtres instables capables de se reforger sans cesse ; les <b>Pestiférés</b>, porteurs de fléaux qui empoisonnaient la terre à leur passage ; les <b>Gardiens</b>, sentinelles immuables dressées en remparts vivants ; les <b>Scribes</b>, copistes silencieux qui gardaient leurs secrets jusqu'au dernier instant ; et les <b>Maudits</b>, damnés qu'une antique malédiction rendait plus redoutables à chaque capture.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">L'ouverture de la Faille</div>
                  <div className="rules-p">Un jour, sans avertissement, le ciel se déchira. Une plaie béante, <b>la Faille</b>, s'ouvrit au cœur du monde, aspirant la réalité et recrachant des flots de magie brute. Cette énergie bouleversa chaque Ordre, et bientôt deux bannières émergèrent pour tenter de maîtriser le chaos.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Le Pacte Azur</div>
                  <div className="rules-p">Une alliance née de la volonté de refermer la Faille, ou du moins de la contenir. Ses rangs rassemblent ceux qui croient en la loi et la discipline, un pacte de circonstance entre Ordres que tout, autrefois, séparait.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">La Horde Écarlate</div>
                  <div className="rules-p">Une coalition plus chaotique, convaincue que la Faille n'est pas une menace à combattre mais un pouvoir à exploiter. Ses membres se pressent pour puiser dans son énergie avant que quiconque ne referme la brèche.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Le Rite d'Emprise</div>
                  <div className="rules-p">La Faille refusant d'obéir à une seule force, les deux camps s'accordent sur un moyen de trancher leurs différends sans détruire davantage le monde : le Rite d'Emprise. Les Ordres ne jurent fidélité à aucune bannière fixe, seulement au vainqueur du Rite, c'est pourquoi un commandant peut invoquer n'importe lesquels de ses deux Ordres favoris, sans distinction de camp. Le plateau rituel accueille l'affrontement, case par case, jusqu'à ce que l'une des deux mains soit vidée. Celui qui contrôle le plus de territoire prend l'ascendant sur la Faille, jusqu'au prochain Rite.</div>
                </div>

                <button className="reset-btn" onClick={() => setActiveModal(null)}>Fermer</button>
              </div>
            </div>
          )}

          {activeModal === "rules" && (
            <div className="info-overlay" onClick={() => setActiveModal(null)}>
              <div className="info-panel rules-panel" onClick={(e) => e.stopPropagation()}>
                <div className="info-panel-title">Règles du jeu</div>

                <div className="rules-section">
                  <div className="rules-h">Objectif</div>
                  <div className="rules-p">Contrôlez plus de cases du plateau que votre adversaire quand les deux mains sont vides. Chaque carte sur le plateau vaut 1 point ; l'Azur part avec +1 point bonus pour compenser l'avantage du second Commandant.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Jouer une carte</div>
                  <div className="rules-p">Choisissez une carte de votre main, puis une case vide du plateau (4×5 cases). L'Azur joue toujours en premier.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Capturer</div>
                  <div className="rules-p">Une carte posée capture une carte adverse adjacente si son rang, du côté qui la touche, est supérieur au rang opposé de la défenseuse.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Résonance</div>
                  <div className="rules-p">Si 2 rangs ou plus de votre carte répondent à ceux des cartes voisines, toutes les voisines adverses concernées sont capturées en même temps, même sans être normalement suffisantes pour capturer seules. Vos propres cartes comptent pour déclencher la Résonance, mais ne sont évidemment jamais capturées.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Onde</div>
                  <div className="rules-p">Une carte capturée via Résonance attaque aussitôt ses propres voisines adverses avec la règle de capture normale, qui peuvent à leur tour déclencher d'autres captures en chaîne.</div>
                </div>

                <div className="rules-section">
                  <div className="rules-h">Les Ordres</div>
                  <div className="rules-p">Chaque Ordre possède une capacité spéciale unique (échange de rangs, attraction, transperce, tir à distance, croissance, retournement...) qui se déclenche en plus des règles ci-dessus, jamais à la place. Appuyez sur le bouton ⓘ en jeu pour voir le détail des Ordres en présence.</div>
                </div>

                <button className="reset-btn" onClick={() => setActiveModal(null)}>Fermer</button>
              </div>
            </div>
          )}

          {activeModal === "stats" && (() => {
            const topOrders = Object.entries(stats.orderPlays)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([key, count]) => ({ order: ORDERS.find((l) => l.key === key), count }))
              .filter((e) => e.order);
            return (
              <div className="info-overlay" onClick={() => { setActiveModal(null); setConfirmResetStats(false); }}>
                <div className="info-panel rules-panel" onClick={(e) => e.stopPropagation()}>
                  <div className="info-panel-title">Statistiques</div>
                  <div className="rules-section">
                    <div className="rules-p">
                      {stats.gamesPlayed === 0
                        ? "Aucune partie terminée pour l'instant. Reviens ici après ta première victoire !"
                        : `${stats.gamesPlayed} partie${stats.gamesPlayed > 1 ? "s" : ""} jouée${stats.gamesPlayed > 1 ? "s" : ""} · ${stats.blueWins} victoire${stats.blueWins > 1 ? "s" : ""} Azur · ${stats.redWins} victoire${stats.redWins > 1 ? "s" : ""} Écarlate`}
                    </div>
                  </div>
                  {topOrders.length > 0 && (
                    <div className="rules-section">
                      <div className="rules-h">Ordres les plus joués</div>
                      {topOrders.map((e, i) => (
                        <div key={i} className="rules-p">{i + 1}. {e.order.name}, {e.count} fois</div>
                      ))}
                    </div>
                  )}
                  {stats.gamesPlayed > 0 && (
                    <button className="landing-link" onClick={handleResetStatsClick}>
                      {confirmResetStats ? "Confirmer la remise à zéro ?" : "Réinitialiser les statistiques"}
                    </button>
                  )}
                  <button className="reset-btn" onClick={() => { setActiveModal(null); setConfirmResetStats(false); }}>Fermer</button>
                </div>
              </div>
            );
          })()}
        </div>
      )}


      {/* La carte du mode Histoire ("chapters") s'affiche en plein ecran, comme l'accueil
          et le plateau : le bandeau global mangerait 180 px de haut sur une carte qu'on
          explore au doigt. */}
      {phase !== "landing" && phase !== "play" && phase !== "tutorial" && phase !== "chapters" && (
        <>
          {/* Le bandeau des deux camps ne se justifie qu'au moment ou l'on compose sa
              main : partout ailleurs il repete une evidence et mange de la hauteur. */}
          {(phase === "select-blue" || phase === "select-red") && <div className="eyebrow">Pacte Azur vs Horde Écarlate</div>}
          <h1 className="title">EMPRISE</h1>
        </>
      )}

      {phase === "play" && (
        <button className="legend-btn" onClick={() => setInfoAbility(true)}>i</button>
      )}

      {phase === "tutorial" && (
        <div className="order-picker">
          {TUTORIAL_STEPS[tut.stepIdx].kind === "info" ? (
            <>
              <h2>{TUTORIAL_STEPS[tut.stepIdx].title}</h2>
              <div className="rules-p tut-text">{TUTORIAL_STEPS[tut.stepIdx].text}</div>
              <button className="reset-btn" onClick={nextTutorialStep}>
                {tut.stepIdx === 0 ? "Commencer" : "Terminer"}
              </button>
              {tut.stepIdx === 0 && (
                <button className="landing-link" onClick={skipTutorial}>Passer le tutoriel</button>
              )}
            </>
          ) : (
            <>
              <h2 className="blue-t">{TUTORIAL_STEPS[tut.stepIdx].title}</h2>
              <div className="rules-p tut-text">
                {tut.resolved ? TUTORIAL_STEPS[tut.stepIdx].after : TUTORIAL_STEPS[tut.stepIdx].text}
              </div>

              <div className="tut-board-wrap">
                <div className="table">
                  {tut.board && tut.board.map((cell, i) => (
                    <div
                      key={i}
                      className={`cell ${!cell ? "empty" : ""} ${!cell && !tut.resolved && i === TUTORIAL_STEPS[tut.stepIdx].requiredCell ? "tut-highlight" : ""}`}
                      role="button" tabIndex={0} onClick={() => tutorialCellClick(i)} onKeyDown={KEY_ACTIVATE(() => tutorialCellClick(i))}
                    >
                      {cell && <Card card={cell} owner={cell.owner} events={tut.flashes[i] ? [{ kind: tut.flashes[i] }] : []} />}
                    </div>
                  ))}
                </div>

                {!tut.resolved && (
                  <div className="hand-row active">
                    <Card card={TUTORIAL_STEPS[tut.stepIdx].handCard} owner="blue" extraClass="hand" />
                  </div>
                )}
              </div>

              {tut.resolved && (
                <button className="reset-btn" onClick={nextTutorialStep}>Continuer</button>
              )}
              <button className="landing-link" onClick={skipTutorial}>Passer le tutoriel</button>
            </>
          )}
        </div>
      )}


      {phase === "chapters" && (() => {
        const chapter = STORY_CHAPTERS[storyMapIndex];
        const theme = STORY_THEMES[chapter.orderKey] || STORY_THEMES.cendres;
        const wins = storyProgress.chapterWins[chapter.orderKey] || 0;
        const completed = storyProgress.completedChapters.includes(chapter.orderKey);
        const prevChapter = STORY_CHAPTERS[chapter.chapterNumber - 2]; // undefined pour le chapitre 1
        const locked = !completed && chapter.chapterNumber > 1 && !storyProgress.completedChapters.includes(prevChapter.orderKey);
        // La partie en cours : la seule case tapable. Un chapitre terminé garde son
        // Seigneur de Guerre rejouable (même comportement que la liste d'avant).
        const currentGame = Math.min(wins + 1, chapter.numGames);
        // Chapitre illustre : positions mesurees dans l'image, sinon trace genere.
        // Si l'image ne contient pas assez d'ilots pour toutes les parties du chapitre,
        // on retombe sur le trace genere plutot que d'empiler deux noeuds au meme endroit.
        const peinte = STORY_CARTES_PEINTES[chapter.orderKey];
        const carteImage = peinte && peinte.noeuds.length >= chapter.numGames ? peinte : null;
        // Surface monde d'un chapitre illustre : 2,1 fois la hauteur de la fenetre, la
        // largeur suivant le ratio de l'image pour ne jamais la deformer.
        const mondeTaille = carteImage
          ? { h: fenetreTaille.h * MONDE_FACTEUR * (carteImage.zoom || 1),
              w: (fenetreTaille.h * MONDE_FACTEUR * (carteImage.zoom || 1)) / carteImage.ratio }
          : { h: 0, w: 0 };
        const positions = carteImage
          ? carteImage.noeuds.slice(0, chapter.numGames)
          : storyMapLayout(chapter.numGames);
        // Intensité de l'embrasement : 0 au tout début, 1 sur la dernière case. Elle
        // nourrit --sm-feu, dont dépendent l'opacité du cadre, la taille des flammes et
        // la vivacité des braises — le chapitre s'échauffe à mesure qu'on le remonte.
        const avancement = chapter.numGames > 1 ? (currentGame - 1) / (chapter.numGames - 1) : 1;
        const feu = locked ? 0 : (completed ? 1 : avancement);
        const ambiance = theme.ambiance || "simple";
        const themeVars = {
          "--th-a": theme.a, "--th-b": theme.b, "--th-cadre": theme.cadre, "--th-lueur": theme.lueur,
          "--th-noyau": theme.noyau || theme.b, "--th-braise": theme.braise || theme.a,
          "--sm-feu": feu.toFixed(3),
        };
        return (
          <div className={`story-map th-${theme.forme} th-${theme.sens} amb-${ambiance} ${locked ? "story-map-locked" : ""}`} style={themeVars}>
            {/* Décor : cadre thématique sur les 4 bords + particules figées (feu qui
                monte, feuilles qui tombent...) — jamais par-dessus le chemin (z-index). */}
            <div className="story-map-cadre" aria-hidden="true" />

            {/* Ambiance "brasier" : le pourtour s'embrase. Langues de feu en bas, braises
                le long des côtés, lueur dans les coins. Tout est en dessous du contenu
                (z-index 1) et ne capte aucun toucher. */}
            {ambiance === "brasier" && (
              <div className="sm-brasier" aria-hidden="true">
                <div className="sm-brasier-lueur" />
                {STORY_FLAMMES_BAS.map((f, i) => (
                  <span
                    key={`fb-${i}`}
                    className="sm-flamme-bas"
                    style={{ left: `${f.gauche}%`, "--fw": `${f.largeur}%`, "--fh": `${f.hauteur}px`, animationDuration: f.duree, animationDelay: f.retard }}
                  />
                ))}
                {STORY_BRAISES_COTES.map((b, i) => (
                  <span
                    key={`bc-${i}`}
                    className={`sm-braise-cote ${b.cote === "g" ? "bc-g" : "bc-d"}`}
                    style={{ bottom: `${b.bas}%`, "--bt": `${b.taille}px`, animationDuration: b.duree, animationDelay: b.retard }}
                  />
                ))}
              </div>
            )}

            {STORY_MAP_PARTICULES.map((p, i) => (
              <div key={i} className="sm-particule" aria-hidden="true" style={{ left: `${p.gauche}%`, "--pt": `${p.taille}px`, animationDuration: p.duree, animationDelay: p.retard }} />
            ))}

            <button className="back-btn story-map-retour" onClick={goBack}>← Retour</button>

            <div className="story-map-entete">
              <div className="story-map-titres">
                <h2 className="story-map-nom">{chapter.order.name}</h2>
                <div className="story-map-sous">Chapitre {chapter.chapterNumber}-{currentGame}</div>
              </div>
              <div className="story-map-medaillon-cadre">
                <img className="story-map-medaillon" src={chapter.order.portrait} alt={chapter.order.name} />
              </div>
            </div>

            <div
              className="story-map-panneau"
              ref={fenetreCarteRef}
              onPointerDown={onCartePointerDown}
              onPointerMove={onCartePointerMove}
              onPointerUp={onCartePointerUp}
              onPointerCancel={onCartePointerUp}
              onPointerLeave={onCartePointerUp}
            >
              {locked && (
                <div className="story-map-verrou">🔒 Terminez le chapitre précédent</div>
              )}
              {completed && !locked && (
                <div className="story-map-fini">✓ {chapter.hero?.name} débloqué</div>
              )}
              {/* La surface MONDE : plus grande que la fenetre, on la fait glisser. Le
                  deplacement passe par transform (et non par top/left) pour rester sur le
                  compositeur du navigateur — c'est ce qui garde le glissement fluide.
                  Sur une carte peinte, c'est la HAUTEUR qui commande (2,1 fois la fenetre)
                  et la largeur suit le ratio de l'image : dimensionner par la largeur sur
                  une image tres allongee donnait une surface enorme ou l'on ne voyait plus
                  qu'un seul rocher. */}
              <div
                className={`sm-monde ${carteImage ? "sm-monde-peint" : ""}`}
                style={
                  carteImage
                    ? {
                        height: `${mondeTaille.h}px`,
                        width: `${mondeTaille.w}px`,
                        transform: `translate3d(${carteOffset.x}px, ${carteOffset.y}px, 0)`,
                      }
                    : {
                        width: `${MONDE_FACTEUR * 100}%`,
                        height: `${MONDE_FACTEUR * 100}%`,
                        transform: `translate3d(${carteOffset.x}px, ${carteOffset.y}px, 0)`,
                      }
                }
              >
                {carteImage && (
                  <img className="sm-fond-peint" src={carteImage.src} alt="" draggable="false" />
                )}
              {/* Le SVG est etire sur tout le panneau : les traces relient les centres exacts des
                  ilots quelles que soient les proportions de l'ecran. vector-effect garde une
                  epaisseur constante malgre l'etirement. */}
              {/* Le chemin : une COULEE DE LAVE qui serpente d'un ilot a l'autre, comme
                  sur la reference. Chaque liaison est une courbe et non un trait droit —
                  le point de controle est decale perpendiculairement, d'un cote puis de
                  l'autre en alternance, pour un serpentement regulier mais pas mecanique.
                  Trois traits superposes donnent son volume a la coulee : bords refroidis
                  sombres, corps orange, veine claire au centre. */}
              {!carteImage && <svg className="sm-chemin" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {positions.slice(0, -1).map((p, i) => {
                  const q = positions[i + 1];
                  const fait = i + 1 < currentGame || completed;
                  const x1 = p.x, y1 = 100 - p.y, x2 = q.x, y2 = 100 - q.y;
                  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
                  const dx = x2 - x1, dy = y2 - y1;
                  const len = Math.hypot(dx, dy) || 1;
                  const cote = i % 2 === 0 ? 1 : -1; // serpente d'un cote puis de l'autre
                  const ampleur = 11;
                  const cx = mx + (-dy / len) * ampleur * cote;
                  const cy = my + (dx / len) * ampleur * cote;
                  const d = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
                  return (
                    <g key={`seg-${i}`}>
                      <path className={`sm-coulee-bord ${fait ? "sm-coulee-active" : ""}`} d={d} vectorEffect="non-scaling-stroke" />
                      {fait && <path className="sm-coulee-corps" d={d} vectorEffect="non-scaling-stroke" />}
                      {fait && (
                        <path className="sm-coulee-veine" d={d} vectorEffect="non-scaling-stroke" style={{ animationDelay: `${i * 0.5}s` }} />
                      )}
                    </g>
                  );
                })}
              </svg>}
              {/* Les nœuds. Aucun chiffre : le premier est le FOYER d'où part la lave, le
                  dernier le nœud du Seigneur de Guerre, plus imposant. Comme le chemin est
                  une ligne continue sans embranchement, ces deux repères suffisent à lire
                  le sens de parcours, même sur les chapitres à 9 étapes qui repartent vers
                  la gauche en haut. */}
              {positions.map((pos, i) => {
                const num = i + 1;
                const gagnee = completed || num < currentGame;
                const enCours = !locked && !completed && num === currentGame;
                const rejouable = !locked && completed && num === chapter.numGames;
                const tapable = enCours || rejouable;
                const estFoyer = num === 1;
                const estBoss = num === chapter.numGames;
                return (
                  <div
                    key={num}
                    className={`sm-case sm-ilot-${(i % 3) + 1} ${gagnee ? "sm-gagnee" : ""} ${enCours ? "sm-encours" : ""} ${tapable ? "sm-tapable" : ""} ${estBoss ? "sm-seigneur" : ""} ${estFoyer ? "sm-foyer" : ""}`}
                    style={
                      carteImage
                        ? { left: `${pos.x}%`, bottom: `${pos.y}%`, width: `${pos.l}%`, height: `${pos.h}%` }
                        : { left: `${pos.x}%`, bottom: `${pos.y}%` }
                    }
                    role={tapable ? "button" : undefined}
                    tabIndex={tapable ? 0 : undefined}
                    aria-label={estBoss ? `Seigneur de Guerre ${chapter.order.name}` : estFoyer ? "Départ du chapitre" : `Étape ${num}`}
                    onClick={tapable ? () => { if (!carteBougeeRef.current) openChapter(chapter.orderKey); } : undefined}
                    onKeyDown={tapable ? KEY_ACTIVATE(() => openChapter(chapter.orderKey)) : undefined}
                  >
                    {/* Carte peinte : on pose la decoupe eteinte du rocher par-dessus
                        l'original tant que l'etape n'est pas atteinte. */}
                    {carteImage && !gagnee && !enCours && (
                      <img className="sm-roche-eteinte" src={pos.eteint} alt="" draggable="false" />
                    )}
                    {/* Cœur incandescent : présent sur les nœuds allumés, éteint sinon. */}
                    <span className="sm-coeur" aria-hidden="true" />
                    {estBoss && <span className="sm-blason" aria-hidden="true" />}
                    {estFoyer && <span className="sm-foyer-marque" aria-hidden="true" />}
                    {/* Les mèches : la matière du thème qui s'échappe sous le nœud (les
                        hachures du croquis). Pas sur les nœuds éteints. */}
                    {(gagnee || enCours) && STORY_CASE_MECHES.map((m, j) => (
                      <span key={j} className="sm-meche" aria-hidden="true" style={{ left: `${m.gauche}%`, "--mt": `${m.taille}px`, animationDuration: m.duree, animationDelay: m.retard }} />
                    ))}
                  </div>
                );
              })}
              </div>
            </div>

            <div className="story-map-nav">
              <button
                className="sm-fleche"
                onClick={() => setStoryMapIndex((i) => Math.max(0, i - 1))}
                disabled={storyMapIndex === 0}
                aria-label="Chapitre précédent"
              >‹</button>
              <div className="sm-nav-texte">Chapitre {chapter.chapterNumber} / {STORY_CHAPTERS.length}</div>
              <button
                className="sm-fleche"
                onClick={() => setStoryMapIndex((i) => Math.min(STORY_CHAPTERS.length - 1, i + 1))}
                disabled={storyMapIndex === STORY_CHAPTERS.length - 1}
                aria-label="Chapitre suivant"
              >›</button>
            </div>
          </div>
        );
      })()}

      {phase === "chapter-complete" && (() => {
        const chapterMeta = STORY_CHAPTERS.find((c) => c.orderKey === storyChapterJustCompleted);
        if (!chapterMeta) return null;
        // La cérémonie de déblocage passe par-dessus l'écran de récompense, qui reste masqué
        // tant qu'elle joue. Elle est sautée d'office si les animations réduites sont actives.
        const ceremonie = !storyCeremonyDone && !reducedMotion;
        return (
          <>
          {ceremonie && (
            <div className="heraut-ceremonie" role="button" tabIndex={0} onClick={() => setStoryCeremonyDone(true)} onKeyDown={KEY_ACTIVATE(() => setStoryCeremonyDone(true))}>
              <div className="hc-scene">
                <div className="hc-secousse">
                  <div className="hc-orbe">
                    <img className="hc-portrait" src={chapterMeta.order.portrait} alt="" />
                  </div>
                  <svg className="hc-cadenas" viewBox="0 0 24 24" fill="none">
                    <path className="hc-anse" d="M6 10V7a6 6 0 0112 0v3" stroke="var(--gold-bright)" strokeWidth="2" strokeLinecap="round" fill="none" />
                    <g className="hc-corps">
                      <rect x="4" y="10" width="16" height="12" rx="2.5" fill="var(--gold-bright)" stroke="var(--gold)" strokeWidth="1" />
                      <circle cx="12" cy="15" r="1.7" fill="#1b2138" />
                      <rect x="11" y="16" width="2" height="3.5" rx="1" fill="#1b2138" />
                    </g>
                  </svg>
                </div>
                <div className="hc-flash" />
                {HC_ETINCELLES.map((e, i) => (
                  <div key={i} className="hc-etincelle" style={{ "--dx": e.dx, "--dy": e.dy, animationDuration: e.duree, animationDelay: e.retard }} />
                ))}
              </div>
              <div className="hc-eyebrow">Capacité supérieure</div>
              <div className="hc-titre">{chapterMeta.hero?.name}</div>
              <div className="hc-effet">{chapterMeta.hero?.desc}</div>
              <div className="hc-passer">Appuyez pour continuer</div>
            </div>
          )}
          <div className={`order-picker ${ceremonie ? "hc-cache" : (storyCeremonyDone ? "hc-entre" : "")}`}>
            <h2>Chapitre {chapterMeta.chapterNumber} terminé !</h2>
            <div className="sub">Vous avez vaincu le Seigneur de Guerre {chapterMeta.order.name}.</div>
            <div className="imposed-order-box hero-reveal-b">
              <img className="imposed-order-thumb" src={chapterMeta.order.portrait} alt="" />
              <div className="imposed-order-info">
                <div className="imposed-order-label">Héraut débloqué</div>
                <div className="imposed-order-name">{chapterMeta.hero?.name}</div>
                <div className="imposed-order-desc">{chapterMeta.hero?.desc}</div>
              </div>
            </div>
            <button
              className="reset-btn"
              onClick={() => { setStoryChapterJustCompleted(null); setStoryChapterKey(null); setStorySecondPick(null); setPhase("chapters"); }}
            >
              Retour aux chapitres
            </button>
          </div>
          </>
        );
      })()}

      {phase === "chapter-pick-order" && (() => {
        const chapterMeta = STORY_CHAPTERS.find((c) => c.orderKey === storyChapterKey);
        if (!chapterMeta) return null;
        const gameIndex = (storyProgress.chapterWins[storyChapterKey] || 0) + 1;
        const diffKey = storyDifficultyFor(gameIndex, chapterMeta.numGames);
        const diffLabel = DIFFICULTIES.find((d) => d.key === diffKey)?.label || diffKey;
        // Les Ordres "prochainement" restent dans la liste, en teaser verrouillé : le mode
        // Histoire est l'endroit où le joueur passe le plus de temps, c'est là qu'il faut
        // qu'il voie arriver le prochain Ordre. Ils ne sont pas sélectionnables pour autant.
        const pickable = ORDERS.filter((o) => o.key !== storyChapterKey);
        return (
          <div className="order-picker">
            <button className="back-btn" onClick={goBack}>← Retour</button>
            <h2>Chapitre {chapterMeta.chapterNumber} · {chapterMeta.order.name}</h2>
            <div className="sub">Partie {gameIndex} / {chapterMeta.numGames} · niveau {diffLabel}</div>
            <div className="imposed-order-box">
              <img className="imposed-order-thumb" src={chapterMeta.order.portrait} alt="" />
              <div className="imposed-order-info">
                <div className="imposed-order-label">Votre carte imposée</div>
                <div className="imposed-order-name">{chapterMeta.order.name}</div>
                <div className="imposed-order-desc">{chapterMeta.order.desc}</div>
              </div>
            </div>
            <div className="sub">Choisissez votre 2e Ordre :</div>
            <div className="order-grid">
              {pickable.map((order) => {
                const comingSoon = !isOrderAvailable(order);
                return (
                  <div
                    key={order.key}
                    className={`order-option ${storySecondPick === order.key ? "picked" : ""} ${comingSoon ? "order-option-locked" : ""}`}
                    role="button" tabIndex={0}
                    onClick={comingSoon ? undefined : () => setStorySecondPick(order.key)}
                    onKeyDown={KEY_ACTIVATE(comingSoon ? undefined : () => setStorySecondPick(order.key))}
                    aria-disabled={comingSoon || undefined}
                  >
                    {comingSoon ? (
                      <ComingSoonThumb order={order} />
                    ) : (
                      <div className="order-thumb-wrap"><img className="thumb" src={order.portrait} alt="" /></div>
                    )}
                    <div className="info">
                      <div className="name">{order.name}</div>
                      <span className="desc">{comingSoon ? <CountdownLabel order={order} /> : order.desc}</span>
                    </div>
                    {comingSoon && <span className="coming-soon-badge">Bientôt disponible</span>}
                  </div>
                );
              })}
            </div>
            <button className="reset-btn" disabled={!storySecondPick} onClick={launchChapterGame}>Commencer la partie</button>
          </div>
        );
      })()}

      {phase === "tourney-menu" && (
        <div className="order-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2>Tournoi</h2>
          <div className="sub">Huit Commandants, un seul champion.</div>
          <div className="diff-grid">
            <div className="diff-option" role="button" tabIndex={0} onClick={() => { setTournoiErreur(""); setPhase("tourney-online-menu"); }} onKeyDown={KEY_ACTIVATE(() => { setTournoiErreur(""); setPhase("tourney-online-menu"); })}>
              <img className="diff-thumb" src={ORDERS.find((o) => o.key === "percee")?.portrait} alt="" />
              <div className="diff-text">
                <div className="name">Tournoi en ligne</div>
                <div className="desc">Huit vrais Commandants, un code à partager : l'arbre se remplit à mesure qu'ils arrivent</div>
              </div>
            </div>
            <div className="diff-option" role="button" tabIndex={0} onClick={() => setPhase("tourney-bracket")} onKeyDown={KEY_ACTIVATE(() => setPhase("tourney-bracket"))}>
              <img className="diff-thumb" src={ORDERS.find((o) => o.key === "maudits")?.portrait} alt="" />
              <div className="diff-text">
                <div className="name">Tournoi solo</div>
                <div className="desc">Contre des Échos, difficulté croissante à chaque tour. Une victoire = un Ordre banni pour le suivant</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === "tourney-online-menu" && (
        <div className="order-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2>Tournoi en ligne</h2>
          <div className="sub">Huit Commandants, trois tours. Créez un tournoi et partagez son code, ou rejoignez avec celui d'un ami.</div>
          <button className="reset-btn" onClick={creerTournoiEnLigne}>Créer un tournoi</button>
          <div className="sub" style={{ marginTop: 18 }}>ou rejoindre avec un code</div>
          <input
            className="join-code-input"
            placeholder="CODE"
            maxLength={5}
            value={codeTournoiInput}
            onChange={(e) => setCodeTournoiInput(e.target.value.toUpperCase())}
          />
          <button className="reset-btn" disabled={!codeTournoiInput.trim()} onClick={rejoindreTournoiEnLigne}>Rejoindre</button>
          {tournoiErreur && <div className="online-error">{tournoiErreur}</div>}
        </div>
      )}

      {phase === "tourney-online" && (() => {
        // Même géométrie que l'arbre du tournoi solo — c'est voulu, et c'est la demande :
        // seul le CONTENU des plaques change. Un siège vide affiche "..." en attendant
        // qu'un Commandant le prenne ; les tours suivants affichent "..." tant que leurs
        // participants ne sont pas connus.
        const CW = 60, CH = 78, PAIR_GAP = 16, MATCH_GAP = 46, ZONE_GAP = 22, TROPHY_H = 62, STROKE = 3;
        const qfY = [0, CH + PAIR_GAP, 2 * CH + PAIR_GAP + MATCH_GAP, 3 * CH + 2 * PAIR_GAP + MATCH_GAP];
        const m1 = (qfY[0] + CH / 2 + qfY[1] + CH / 2) / 2;
        const m2 = (qfY[2] + CH / 2 + qfY[3] + CH / 2) / 2;
        const sfY = [m1 - CH / 2, m2 - CH / 2];
        const finalCenter = (m1 + m2) / 2;
        const finalY = finalCenter - CH / 2;
        const boardH = TROPHY_H + qfY[3] + CH;
        const shift = (y) => y + TROPHY_H;
        const xQF_L = 0, xSF_L = xQF_L + CW + ZONE_GAP, xFinal_L = xSF_L + CW + ZONE_GAP;
        const xFinal_R = xFinal_L + CW, xSF_R = xFinal_R + CW + ZONE_GAP, xQF_R = xSF_R + CW + ZONE_GAP;
        const boardW = xQF_R + CW;
        const centerX = (xFinal_L + CW + xFinal_R) / 2;

        const joueurs = (tournoiData && tournoiData.joueurs) || [];
        const matches = (tournoiData && tournoiData.matches) || {};
        const statut = (tournoiData && tournoiData.status) || "waiting";
        // Un uid -> sa plaque (alias + portrait de son siège, "Vous" pour soi-même).
        const plaqueDe = (uid) => {
          const i = joueurs.indexOf(uid);
          if (i === -1 || !SIEGES_TOURNOI[i]) return null;
          return { nom: uid === myUid ? "Vous" : SIEGES_TOURNOI[i].nom, key: SIEGES_TOURNOI[i].key, vous: uid === myUid };
        };
        const vainqueurDe = (k) => (matches[k] && matches[k].vainqueur) || null;
        // Éliminé : son match à ce tour est décidé et il ne l'a pas gagné.
        const elimineEn = (uid, cleMatch) => {
          const m = matches[cleMatch];
          return !!(uid && m && m.vainqueur && m.vainqueur !== uid && (m.a === uid || m.b === uid));
        };

        const Slot = ({ x, y, uid, big, cleMatch }) => {
          const p = uid ? plaqueDe(uid) : null;
          const order = p && p.key ? ORDERS.find((o) => o.key === p.key) : null;
          const elimine = uid ? elimineEn(uid, cleMatch) : false;
          return (
            <div
              className={`tb-plaque ${p && p.vous ? "tb-vous" : ""} ${big ? "tb-grand" : ""} ${elimine ? "tb-elimine" : ""} ${!p ? "tb-attente" : ""}`}
              style={{ left: x, top: y, width: CW, height: CH }}
            >
              <span className="tb-sceau">
                {order
                  ? <img src={order.portrait} alt="" className="tb-portrait" />
                  : <span className="tb-blason" aria-hidden="true" />}
              </span>
              <span className="tb-nom">{p ? p.nom : "..."}</span>
              {elimine && <span className="tb-balafre" aria-hidden="true" />}
            </div>
          );
        };

        const Brace = ({ sourceX, y1, y2, joinX, targetX, allume }) => {
          const midY = (y1 + y2) / 2;
          const d = `M ${sourceX} ${y1} L ${joinX} ${y1} L ${joinX} ${y2} L ${sourceX} ${y2} M ${joinX} ${midY} L ${targetX} ${midY}`;
          return (
            <>
              <path d={d} className="tb-lien" strokeWidth={STROKE} />
              {allume && <path d={d} className="tb-lien-allume" strokeWidth={STROKE} />}
            </>
          );
        };

        const qfEdgeL = xQF_L + CW, sfEdgeL_in = xSF_L, sfEdgeL_out = xSF_L + CW, finalEdgeL = xFinal_L;
        const qfEdgeR = xQF_R, sfEdgeR_in = xSF_R + CW, sfEdgeR_out = xSF_R, finalEdgeR = xFinal_R + CW;

        const monMatch = monMatchEnAttente();
        const champion = tournoiData && tournoiData.champion ? plaqueDe(tournoiData.champion) : null;
        // Éliminé = un de MES matchs a un vainqueur qui n'est pas moi. "Plus de match en
        // attente" ne suffit pas : entre ma victoire de quart et la création des demies,
        // je n'ai aucun match en cours sans être éliminé pour autant.
        const suisElimine = statut !== "waiting" && myUid && joueurs.includes(myUid)
          && Object.values((tournoiData && tournoiData.matches) || {}).some(
            (m) => m && (m.a === myUid || m.b === myUid) && m.vainqueur && m.vainqueur !== myUid
          );
        const suisChampion = champion && tournoiData.champion === myUid;

        return (
          <div className="order-picker">
            <button className="back-btn" onClick={goBack}>← Retour</button>
            <h2>Tournoi en ligne</h2>
            {statut === "waiting" && (
              <>
                <div className="sub">Partagez ce code : le tournoi démarre dès que les 8 sièges sont pris.</div>
                <div className="code-tournoi">{tournoiOnlineId}</div>
                <div className="sub">{8 - joueurs.length > 0 ? `En attente de ${8 - joueurs.length} Commandant${8 - joueurs.length > 1 ? "s" : ""}...` : "Lancement du tournoi..."}</div>
              </>
            )}
            {statut === "running" && (
              <div className="sub">
                {monMatch
                  ? "Votre duel est prêt, les autres se jouent en parallèle."
                  : suisElimine
                  ? "Vous êtes éliminé. Vous pouvez suivre la fin du tournoi, ou revenir plus tard."
                  : "Duel gagné ! En attente des autres résultats..."}
              </div>
            )}
            {champion && (
              <div className="sub tb-champion-annonce">
                🏆 {suisChampion ? "Vous remportez le tournoi !" : `${champion.nom} remporte le tournoi !`}
              </div>
            )}
            <div className="tb-scene">
              <div
                className="tb-arbre"
                style={{ width: boardW, height: boardH }}
                ref={(el) => {
                  if (!el || !el.parentElement) return;
                  const dispo = el.parentElement.clientWidth;
                  const haut = el.parentElement.getBoundingClientRect().top;
                  const libre = Math.max(180, window.innerHeight - haut - 118);
                  const e = Math.max(0.5, Math.min(1.9, dispo / boardW, libre / boardH));
                  el.style.setProperty("--brk-echelle", e);
                  el.parentElement.style.height = `${boardH * e}px`;
                }}
              >
                <div className="tb-trophee" style={{ left: centerX - 30, width: 60 }}>
                  <svg className="tb-coupe" viewBox="0 0 24 24" aria-hidden="true">
                    <defs>
                      <linearGradient id="tb-or-online" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#f2dda2" />
                        <stop offset="45%" stopColor="#e8c877" />
                        <stop offset="100%" stopColor="#b8944a" />
                      </linearGradient>
                    </defs>
                    <path fill="url(#tb-or-online)" d="M8 4 H16 V10.5 C16 12.5 14.2 14 12 14 C9.8 14 8 12.5 8 10.5 Z" />
                    <path fill="url(#tb-or-online)" d="M11 14 H13 V17 H15.5 V19 H8.5 V17 H11 Z" />
                    <path fill="none" stroke="#e8c877" strokeWidth="1.6" strokeLinecap="round" d="M8 5.5 C5.5 5.5 4.5 7 5.2 9 C5.8 10.6 7.2 11.2 8 11" />
                    <path fill="none" stroke="#e8c877" strokeWidth="1.6" strokeLinecap="round" d="M16 5.5 C18.5 5.5 19.5 7 18.8 9 C18.2 10.6 16.8 11.2 16 11" />
                  </svg>
                  <div className="tb-trophee-nom">Champion</div>
                </div>
                <div
                  className="tb-arene"
                  style={{ left: xFinal_L - 13, top: shift(finalY) - 13, width: CW * 2 + 26, height: CH + 26 }}
                  aria-hidden="true"
                />
                <svg className="tb-liens" style={{ width: boardW, height: boardH }}>
                  <Brace sourceX={qfEdgeL} y1={shift(qfY[0] + CH / 2)} y2={shift(qfY[1] + CH / 2)} joinX={qfEdgeL + ZONE_GAP / 2} targetX={sfEdgeL_in} allume={!!vainqueurDe("qf0")} />
                  <Brace sourceX={qfEdgeL} y1={shift(qfY[2] + CH / 2)} y2={shift(qfY[3] + CH / 2)} joinX={qfEdgeL + ZONE_GAP / 2} targetX={sfEdgeL_in} allume={!!vainqueurDe("qf1")} />
                  <Brace sourceX={sfEdgeL_out} y1={shift(sfY[0] + CH / 2)} y2={shift(sfY[1] + CH / 2)} joinX={sfEdgeL_out + ZONE_GAP / 2} targetX={finalEdgeL} allume={!!vainqueurDe("sf0")} />
                  <Brace sourceX={qfEdgeR} y1={shift(qfY[0] + CH / 2)} y2={shift(qfY[1] + CH / 2)} joinX={qfEdgeR - ZONE_GAP / 2} targetX={sfEdgeR_in} allume={!!vainqueurDe("qf2")} />
                  <Brace sourceX={qfEdgeR} y1={shift(qfY[2] + CH / 2)} y2={shift(qfY[3] + CH / 2)} joinX={qfEdgeR - ZONE_GAP / 2} targetX={sfEdgeR_in} allume={!!vainqueurDe("qf3")} />
                  <Brace sourceX={sfEdgeR_out} y1={shift(sfY[0] + CH / 2)} y2={shift(sfY[1] + CH / 2)} joinX={sfEdgeR_out - ZONE_GAP / 2} targetX={finalEdgeR} allume={!!vainqueurDe("sf1")} />
                </svg>
                {[0, 1, 2, 3].map((i) => <Slot key={"ql" + i} x={xQF_L} y={shift(qfY[i])} uid={joueurs[i] || null} cleMatch={`qf${Math.floor(i / 2)}`} />)}
                {[4, 5, 6, 7].map((i, j) => <Slot key={"qr" + j} x={xQF_R} y={shift(qfY[j])} uid={joueurs[i] || null} cleMatch={`qf${2 + Math.floor(j / 2)}`} />)}
                <Slot x={xSF_L} y={shift(sfY[0])} uid={vainqueurDe("qf0")} cleMatch="sf0" />
                <Slot x={xSF_L} y={shift(sfY[1])} uid={vainqueurDe("qf1")} cleMatch="sf0" />
                <Slot x={xSF_R} y={shift(sfY[0])} uid={vainqueurDe("qf2")} cleMatch="sf1" />
                <Slot x={xSF_R} y={shift(sfY[1])} uid={vainqueurDe("qf3")} cleMatch="sf1" />
                <Slot x={xFinal_L} y={shift(finalY)} uid={vainqueurDe("sf0")} big cleMatch="f0" />
                <Slot x={xFinal_R} y={shift(finalY)} uid={vainqueurDe("sf1")} big cleMatch="f0" />
                <div className="tb-vs" style={{ left: centerX - 15, top: shift(finalCenter) - 11 }}>VS</div>
              </div>
            </div>
            {tournoiErreur && <div className="online-error">{tournoiErreur}</div>}
            {statut === "running" && monMatch && (
              <button className="reset-btn" onClick={jouerMatchTournoi}>⚔ Jouer votre duel</button>
            )}
            {champion && (
              <button className="reset-btn" onClick={reset}>Retour au menu</button>
            )}
          </div>
        );
      })()}

      {phase === "tourney-bracket" && (() => {
        // Geometrie en PIXELS, et c'est voulu : un arbre de tournoi est une geometrie,
        // pas un flux. Les liaisons doivent tomber au pixel sur le centre des plaques ;
        // en Flexbox il faudrait recalculer chaque trait a la main.
        const CW = 60, CH = 78, PAIR_GAP = 16, MATCH_GAP = 46, ZONE_GAP = 22, TROPHY_H = 62, STROKE = 3;
        const qfY = [0, CH + PAIR_GAP, 2 * CH + PAIR_GAP + MATCH_GAP, 3 * CH + 2 * PAIR_GAP + MATCH_GAP];
        const m1 = (qfY[0] + CH / 2 + qfY[1] + CH / 2) / 2;
        const m2 = (qfY[2] + CH / 2 + qfY[3] + CH / 2) / 2;
        const sfY = [m1 - CH / 2, m2 - CH / 2];
        const finalCenter = (m1 + m2) / 2;
        const finalY = finalCenter - CH / 2;
        const boardH = TROPHY_H + qfY[3] + CH;
        const shift = (y) => y + TROPHY_H;
        const xQF_L = 0, xSF_L = xQF_L + CW + ZONE_GAP, xFinal_L = xSF_L + CW + ZONE_GAP;
        const xFinal_R = xFinal_L + CW, xSF_R = xFinal_R + CW + ZONE_GAP, xQF_R = xSF_R + CW + ZONE_GAP;
        const boardW = xQF_R + CW;
        const centerX = (xFinal_L + CW + xFinal_R) / 2;

        // Un adversaire porte le nom de ce qu'il commande, pas un numero. Fixes et lies a
        // la cle de l'Ordre : le meme adversaire garde son nom d'une partie a l'autre.
        const NOMS_TOURNOI = {
          maudits: "Le Ressac", poison: "La Vermine", devoreuse: "L'Abysse",
          scribes: "Le Copiste", mue: "La Mue", percee: "La Lance", guardian: "Le Rempart",
        };
        // Combien de tours le joueur a-t-il deja franchis. L'arbre s'allume d'autant.
        const franchis = tourney.active ? tourney.round : 0;
        // Le joueur porte le portrait des Dores. Les formes abstraites essayees avant
        // (croix, ecu, octogone plein) ne racontaient rien : dans un arbre ou chaque
        // adversaire montre un visage, une forme geometrique se lit comme une case vide.
        // Le sceau reste serti d'or, ce qui distingue la plaque sans un mot.
        const P = { you: { name: "Vous", you: true, key: "eveil" } };
        ["maudits", "poison", "devoreuse", "scribes", "mue", "percee", "guardian"].forEach((k, i) => {
          P["c" + (i + 1)] = { name: NOMS_TOURNOI[k], key: k };
        });
        // battu au tour n : quart = 0, demi = 1, finale = 2
        const battu = (p, tour) => !p.you && franchis > tour;
        const leftQF = [P.you, P.c1, P.c2, P.c3];
        const rightQF = [P.c4, P.c5, P.c6, P.c7];
        const leftSF = [P.you, P.c2];
        const rightSF = [P.c4, P.c6];

        const Slot = ({ x, y, p, big, tour }) => {
          const order = p.key ? ORDERS.find((o) => o.key === p.key) : null;
          const elimine = battu(p, tour);
          return (
            <div
              className={`tb-plaque ${p.you ? "tb-vous" : ""} ${big ? "tb-grand" : ""} ${elimine ? "tb-elimine" : ""}`}
              style={{ left: x, top: y, width: CW, height: CH }}
            >
              <span className="tb-sceau">
                {order
                  ? <img src={order.portrait} alt="" className="tb-portrait" />
                  : <span className="tb-blason" aria-hidden="true" />}
              </span>
              <span className="tb-nom">{p.name}</span>
              {elimine && <span className="tb-balafre" aria-hidden="true" />}
            </div>
          );
        };

        // Deux traces superposes : le gris (toujours la) et le dore (seulement si le
        // chemin a ete franchi). Le dore est dessine par-dessus.
        const Brace = ({ sourceX, y1, y2, joinX, targetX, allume }) => {
          const midY = (y1 + y2) / 2;
          const d = `M ${sourceX} ${y1} L ${joinX} ${y1} L ${joinX} ${y2} L ${sourceX} ${y2} M ${joinX} ${midY} L ${targetX} ${midY}`;
          return (
            <>
              <path d={d} className="tb-lien" strokeWidth={STROKE} />
              {allume && <path d={d} className="tb-lien-allume" strokeWidth={STROKE} />}
            </>
          );
        };

        const qfEdgeL = xQF_L + CW, sfEdgeL_in = xSF_L, sfEdgeL_out = xSF_L + CW, finalEdgeL = xFinal_L;
        const qfEdgeR = xQF_R, sfEdgeR_in = xSF_R + CW, sfEdgeR_out = xSF_R, finalEdgeR = xFinal_R + CW;

        return (
          <div className="order-picker">
            <button className="back-btn" onClick={goBack}>← Retour</button>
            <h2>Tournoi</h2>
            <div className="sub">Huit commandants, trois tours, un seul champion.</div>
            <div className="tb-scene">
              <div
                className="tb-arbre"
                style={{ width: boardW, height: boardH }}
                ref={(el) => {
                  // L'echelle tient compte de la largeur ET de la hauteur libres, et
                  // l'agrandissement est autorise : sur ordinateur et tablette l'arbre
                  // grandit au lieu de rester minuscule, sur telephone il se reduit sans
                  // jamais deborder. C'est toujours la plus petite des deux qui gagne.
                  if (!el || !el.parentElement) return;
                  const dispo = el.parentElement.clientWidth;
                  const haut = el.parentElement.getBoundingClientRect().top;
                  const libre = Math.max(180, window.innerHeight - haut - 118);
                  const e = Math.max(0.5, Math.min(1.9, dispo / boardW, libre / boardH));
                  el.style.setProperty("--brk-echelle", e);
                  el.parentElement.style.height = `${boardH * e}px`;
                }}
              >
                <div className="tb-trophee" style={{ left: centerX - 30, width: 60 }}>
                  {/* Coupe simplifiee a l'extreme : une vasque et un pied en silhouette
                      pleine, deux anses en trait fin, rien d'autre. Une coupe avec des
                      reliefs ou des anses pleines redevenait un griffonnage a cette
                      taille ; ramenee a 2 formes + 2 traits, elle se lit aussi vite que
                      le losange qu'elle remplace. */}
                  <svg className="tb-coupe" viewBox="0 0 24 24" aria-hidden="true">
                    <defs>
                      <linearGradient id="tb-or" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#f2dda2" />
                        <stop offset="45%" stopColor="#e8c877" />
                        <stop offset="100%" stopColor="#b8944a" />
                      </linearGradient>
                    </defs>
                    <path fill="url(#tb-or)" d="M8 4 H16 V10.5 C16 12.5 14.2 14 12 14 C9.8 14 8 12.5 8 10.5 Z" />
                    <path fill="url(#tb-or)" d="M11 14 H13 V17 H15.5 V19 H8.5 V17 H11 Z" />
                    <path fill="none" stroke="#e8c877" strokeWidth="1.6" strokeLinecap="round" d="M8 5.5 C5.5 5.5 4.5 7 5.2 9 C5.8 10.6 7.2 11.2 8 11" />
                    <path fill="none" stroke="#e8c877" strokeWidth="1.6" strokeLinecap="round" d="M16 5.5 C18.5 5.5 19.5 7 18.8 9 C18.2 10.6 16.8 11.2 16 11" />
                  </svg>
                  <div className="tb-trophee-nom">Champion</div>
                </div>
                {/* Cadre d'arene autour du duel central : le point d'orgue de l'ecran. */}
                <div
                  className="tb-arene"
                  style={{ left: xFinal_L - 13, top: shift(finalY) - 13, width: CW * 2 + 26, height: CH + 26 }}
                  aria-hidden="true"
                />
                <svg className="tb-liens" style={{ width: boardW, height: boardH }}>
                  <defs>
                    <linearGradient id="tb-degrade" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#e8c877" />
                      <stop offset="100%" stopColor="#ffaa00" />
                    </linearGradient>
                  </defs>
                  <Brace sourceX={qfEdgeL} y1={shift(qfY[0] + CH / 2)} y2={shift(qfY[1] + CH / 2)} joinX={qfEdgeL + ZONE_GAP / 2} targetX={sfEdgeL_in} allume={franchis >= 1} />
                  <Brace sourceX={qfEdgeL} y1={shift(qfY[2] + CH / 2)} y2={shift(qfY[3] + CH / 2)} joinX={qfEdgeL + ZONE_GAP / 2} targetX={sfEdgeL_in} allume={franchis >= 1} />
                  <Brace sourceX={sfEdgeL_out} y1={shift(sfY[0] + CH / 2)} y2={shift(sfY[1] + CH / 2)} joinX={sfEdgeL_out + ZONE_GAP / 2} targetX={finalEdgeL} allume={franchis >= 2} />
                  <Brace sourceX={qfEdgeR} y1={shift(qfY[0] + CH / 2)} y2={shift(qfY[1] + CH / 2)} joinX={qfEdgeR - ZONE_GAP / 2} targetX={sfEdgeR_in} allume={franchis >= 1} />
                  <Brace sourceX={qfEdgeR} y1={shift(qfY[2] + CH / 2)} y2={shift(qfY[3] + CH / 2)} joinX={qfEdgeR - ZONE_GAP / 2} targetX={sfEdgeR_in} allume={franchis >= 1} />
                  <Brace sourceX={sfEdgeR_out} y1={shift(sfY[0] + CH / 2)} y2={shift(sfY[1] + CH / 2)} joinX={sfEdgeR_out - ZONE_GAP / 2} targetX={finalEdgeR} allume={franchis >= 2} />
                </svg>
                {leftQF.map((p, i) => <Slot key={"ql" + i} x={xQF_L} y={shift(qfY[i])} p={p} tour={0} />)}
                {leftSF.map((p, i) => <Slot key={"sl" + i} x={xSF_L} y={shift(sfY[i])} p={p} tour={1} />)}
                {rightQF.map((p, i) => <Slot key={"qr" + i} x={xQF_R} y={shift(qfY[i])} p={p} tour={0} />)}
                {rightSF.map((p, i) => <Slot key={"sr" + i} x={xSF_R} y={shift(sfY[i])} p={p} tour={1} />)}
                <Slot x={xFinal_L} y={shift(finalY)} p={P.you} big tour={2} />
                <Slot x={xFinal_R} y={shift(finalY)} p={P.c4} big tour={2} />
                <div className="tb-vs" style={{ left: centerX - 15, top: shift(finalCenter) - 11 }}>VS</div>
              </div>
            </div>
            <button className="reset-btn" onClick={startTourney}>Commencer le tournoi</button>
          </div>
        );
      })()}

      {phase === "online-menu" && (
        <div className="order-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2>Affrontement en ligne</h2>
          <div className="sub">Défiez un ami à distance : créez une partie et partagez le code, ou rejoignez avec le sien.</div>
          <button className="reset-btn" onClick={createOnlineGame}>Créer une partie</button>
          <div className="sub" style={{ marginTop: 18 }}>ou rejoindre avec un code</div>
          <input
            className="join-code-input"
            placeholder="CODE"
            maxLength={5}
            value={joinCodeInput}
            onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
          />
          <button className="reset-btn" disabled={!joinCodeInput.trim()} onClick={joinOnlineGame}>Rejoindre</button>
          {onlineError && <div className="online-error">{onlineError}</div>}
        </div>
      )}

      {phase === "online-waiting" && (
        <div className="order-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2>{fileAttente ? "Recherche d'un adversaire" : "Partie en ligne"}</h2>
          {/* Pendant la recherche, l'illustration porte tout : les textes d'Histoire et
              d'astuces s'incrustent en bas du portrait, sur un voile sombre. La consigne
              et la ligne d'etat ont ete retirees, le titre de l'ecran les disait deja. */}
          {fileAttente && ordreAttente && (
            <div className="attente-ordre">
              <div className="attente-ordre-cadre">
                <img src={ordreAttente.portrait} alt={ordreAttente.name} />
                <RecitsAttente actif surImage />
              </div>
            </div>
          )}
          {!fileAttente && onlineRole === "blue" && onlineGameId && (
            <>
              <div className="sub">Partagez ce code avec votre adversaire :</div>
              <div className="game-code-display">{onlineGameId}</div>
              <button className="landing-link" onClick={copierCode}>Copier le code</button>
              <div className="code-copie">{codeCopie ? "Code copié" : ""}</div>
            </>
          )}
          {!fileAttente && <div className="sub" style={{ marginTop: 14 }}>{onlineStatus || "Connexion..."}</div>}
          {/* Meuble les secondes d'attente : recherche d'adversaire, ou attente de ses
              Ordres. Masque des qu'un compte a rebours de forfait s'affiche, pour ne pas
              detourner l'attention d'une information qui, elle, demande une decision. */}
          {!fileAttente && <RecitsAttente actif={attentePreMatch <= TURN_SECONDS} />}
          {attentePreMatch > TURN_SECONDS && (
            <div className="sub">{
              // Hors tournoi, ce compte a rebours n'accorde aucune victoire : la partie est
              // simplement annulee et l'on rentre au menu. Promettre une victoire qui ne
              // vient jamais etait la seule chose que cet ecran disait de faux.
              tournoiOnlineId
                ? `L'adversaire ne se présente pas : victoire dans ${Math.max(1, FORFAIT_APRES_S - attentePreMatch)}s...`
                : `L'adversaire ne se présente pas : la partie sera annulée dans ${Math.max(1, FORFAIT_APRES_S - attentePreMatch)}s...`
            }</div>
          )}
          {onlineError && <div className="online-error">{onlineError}</div>}
        </div>
      )}

      {(phase === "select-blue" || phase === "select-red") && (
        <div className="order-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2 className={(mode === "online" ? onlineRole === "red" : phase === "select-red") ? "red-t" : ""}>
            {mode === "online"
              ? (onlineRole === "blue" ? "Azur : Choisissez vos 2 Ordres" : "Écarlate : Choisissez vos 2 Ordres")
              : tourney.active
              ? `${TOURNEY_ROUNDS[tourney.round].label} · Choisissez vos 2 Ordres`
              : phase === "select-blue" ? "Azur : Choisissez vos 2 Ordres" : "Écarlate : Choisissez vos 2 Ordres"}
          </h2>
          {/* Minuteur du choix des Ordres, en haut a droite, avec un sablier qui tourne
              en continu (transform seule) pour dire d'un coup d'oeil que le temps court. */}
          {minuteurOrdresActif && (
            <div className={`ordres-minuteur ${tempsOrdres <= 10 ? "urgent" : ""}`} role="timer" aria-live="off">
              <img className="ordres-sablier" src="/nav/sablier.webp" alt="" />
              <span className="ordres-temps">{Math.floor(tempsOrdres / 60)}:{String(tempsOrdres % 60).padStart(2, "0")}</span>
            </div>
          )}
          {/* Etat de l'adversaire : savoir qu'il a fini change la facon dont on prend
              son temps, et evite de croire la partie figee. */}
          {mode === "online" && phase === "select-blue" && (
            <div className={`ordres-adversaire ${advPret ? "pret" : ""}`} role="status">
              {advPret ? (
                <>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
                  L'adversaire a choisi ses Ordres
                </>
              ) : "L'adversaire choisit ses Ordres..."}
            </div>
          )}
          {/* Le code n'a de sens qu'entre amis : en Classé l'appariement est automatique,
              en tournoi c'est l'arbre qui decide. L'afficher ailleurs laissait croire
              qu'il fallait le transmettre a quelqu'un. */}
          {mode === "online" && onlineGameId && !partieClassee && !tournoiOnlineId && (
            <div className="code-rappel">Code de partie :<b>{onlineGameId}</b></div>
          )}
          <div className="sub">
            {pickerChoice.length}/2 sélectionnées · 4 cartes de chaque Ordre
            {tourney.active && tourney.ban && ` · ${ORDERS.find((o) => o.key === tourney.ban)?.name} banni ce tour-ci`}
          </div>
          <div className="order-grid">
            {ORDERS.filter((order) => !(tourney.active && tourney.ban === order.key)).map((order) => {
              const comingSoon = !isOrderAvailable(order);
              return (
                <div
                  key={order.key}
                  className={`order-option ${pickerChoice.find((l) => l.key === order.key) ? "picked" : ""} ${comingSoon ? "order-option-locked" : ""}`}
                  role="button" tabIndex={0} onClick={comingSoon ? undefined : () => toggleOrderPick(order)} onKeyDown={KEY_ACTIVATE(comingSoon ? undefined : () => toggleOrderPick(order))}
                  aria-disabled={comingSoon || undefined}
                >
                  {order.portrait ? (
                    comingSoon ? (
                      <ComingSoonThumb order={order} />
                    ) : (
                      <div className="order-thumb-wrap">
                        <img className="thumb" src={order.portrait} alt={order.name} />
                      </div>
                    )
                  ) : (
                    <div className="icon-frame">{order.icon}</div>
                  )}
                  <div className="info">
                    <span className="name">{order.name}</span>
                    <span className="desc">{comingSoon ? <CountdownLabel order={order} /> : order.desc}</span>
                  </div>
                  {comingSoon && <span className="coming-soon-badge">Bientôt disponible</span>}
                  {!comingSoon && encocheVisible(order) && (
                    <div
                      className={`heraut-encoche ${encocheCochee(order) ? "actif" : ""}`}
                      role="checkbox" tabIndex={0}
                      aria-checked={encocheCochee(order)}
                      aria-label={`Capacité supérieure des ${order.name}`}
                      title={HEROES.find((h) => h.orderKey === order.key)?.desc}
                      onClick={(e) => { e.stopPropagation(); basculerEncoche(order); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); basculerEncoche(order); }
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none">
                        <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {HEROES_LEAGUES_ENABLED && !tourney.active && !confluenceActive && !testMode && pickerChoice.length === 2 && (() => {
            const available = HEROES.filter((h) => pickerChoice.some((o) => o.key === h.orderKey) && isHeroUnlocked(h, stats.trophies || 0));
            if (available.length === 0) return null;
            return (
              <div className="rules-section">
                <div className="rules-h">Héros disponible{available.length > 1 ? "s" : ""}</div>
                {available.map((h) => (
                  <div
                    key={h.orderKey}
                    className={`order-option ${heroChoice === h.orderKey ? "picked" : ""}`}
                    role="button" tabIndex={0} onClick={() => setHeroChoice(heroChoice === h.orderKey ? null : h.orderKey)} onKeyDown={KEY_ACTIVATE(() => setHeroChoice(heroChoice === h.orderKey ? null : h.orderKey))}
                  >
                    <div className="info">
                      <span className="name">{h.name}</span>
                      <span className="desc">{h.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
          <button className="landing-link" onClick={chooseRandomOrders}>🎲 Ordres aléatoires</button>
          <button className="reset-btn" disabled={pickerChoice.length !== 2} onClick={confirmOrders}>Confirmer</button>
          {onlineError && <div className="online-error">{onlineError}</div>}
        </div>
      )}

      {phase === "confluence-draft" && (
        <div className="order-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2 className={draft.turn === "red" ? "red-t" : ""}>
            {mode === "bot"
              ? (draft.turn === "red" ? "L'Écho choisit un Ordre..." : "Vous choisissez un Ordre")
              : `${draft.turn === "blue" ? "Azur" : "Écarlate"} choisit un Ordre`}
            {" "}({draft.pool.length}/8)
          </h2>
          <div className="sub">Chaque Ordre choisi rejoint le pool commun : les deux Commandants en auront une carte, que ce soit vous ou l'adversaire qui l'ayez choisi.</div>
          {testMode && (
            <button className="landing-link" onClick={fillDraftRandomly}>🎲 Distribuer le reste au hasard</button>
          )}
          {!(mode === "bot" && draft.turn === "red") && <TimerBar timeLeft={draft.timeLeft} max={DRAFT_SECONDS} />}
          <div className="order-grid">
            {ORDERS.map((order) => {
              const taken = draft.pool.includes(order.key);
              const pickedBy = draft.pickedBy[order.key]; // "blue" | "red" | undefined
              const botIsPicking = mode === "bot" && draft.turn === "red";
              const comingSoon = !isOrderAvailable(order);
              return (
                <div
                  key={order.key}
                  className={`order-option ${taken ? `picked picked-${pickedBy}` : ""} ${botIsPicking ? "disabled" : ""} ${comingSoon ? "order-option-locked" : ""}`}
                  role="button" tabIndex={0} onClick={() => !taken && !botIsPicking && !comingSoon && pickDraftOrder(order.key)} onKeyDown={KEY_ACTIVATE(() => !taken && !botIsPicking && !comingSoon && pickDraftOrder(order.key))}
                  aria-disabled={comingSoon || undefined}
                >
                  {order.portrait ? (
                    comingSoon ? (
                      <ComingSoonThumb order={order} />
                    ) : (
                      <div className="order-thumb-wrap">
                        <img className="thumb" src={order.portrait} alt={order.name} />
                      </div>
                    )
                  ) : (
                    <div className="icon-frame">{order.icon}</div>
                  )}
                  <div className="info">
                    <span className="name">{order.name}</span>
                    <span className="desc">{comingSoon ? <CountdownLabel order={order} /> : taken ? `Choisie par ${pickedBy === "blue" ? "Azur" : "Écarlate"}` : order.desc}</span>
                  </div>
                  {comingSoon && <span className="coming-soon-badge">Bientôt disponible</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {phase === "tourney-ban" && (
        <div className="order-picker">
          <h2>Victoire ! ({TOURNEY_ROUNDS[tourney.round].label})</h2>
          <div className="sub">Choisissez un Ordre à bannir pour le prochain tour (remplace le ban précédent, s'il y en avait un).</div>
          <div className="order-grid">
            {ORDERS.filter(isOrderAvailable).map((order) => (
              <div
                key={order.key}
                className={`order-option ${tourneyBanPick === order.key ? "ban-picked" : ""}`}
                role="button" tabIndex={0} onClick={() => setTourneyBanPick(order.key)} onKeyDown={KEY_ACTIVATE(() => setTourneyBanPick(order.key))}
              >
                {order.portrait ? (
                  <div className="order-thumb-wrap">
                    <img className="thumb" src={order.portrait} alt={order.name} />
                  </div>
                ) : (
                  <div className="icon-frame">{order.icon}</div>
                )}
                <div className="info">
                  <span className="name">{order.name}</span>
                </div>
                {tourneyBanPick === order.key && (
                  <svg className="ban-crack-overlay" viewBox="0 0 100 140" preserveAspectRatio="none">
                    <path d="M 62 0 L 38 28 L 68 52 L 30 80 L 58 108 L 42 140" />
                  </svg>
                )}
              </div>
            ))}
          </div>
          <button className="reset-btn" disabled={!tourneyBanPick} onClick={() => confirmTourneyBan(tourneyBanPick)}>Confirmer le ban</button>
          <button className="landing-link" onClick={() => confirmTourneyBan(null)}>Ne rien bannir cette fois</button>
        </div>
      )}

      {phase === "tourney-eliminated" && (
        <div className="diff-picker">
          <h2>Éliminé · {TOURNEY_ROUNDS[tourney.round].label}</h2>
          <div className="sub">L'Écho l'emporte cette fois. Le tournoi s'arrête ici pour vous.</div>
          <button className="reset-btn" onClick={reset}>Retour au menu</button>
        </div>
      )}

      {phase === "tourney-champion" && (
        <div className="diff-picker">
          <h2>🏆 Vous remportez le tournoi !</h2>
          <div className="sub">Quart de finale, demi-finale, finale : les 3 tours passés, bravo.</div>
          <button className="reset-btn" onClick={reset}>Retour au menu</button>
        </div>
      )}

      {phase === "select-difficulty" && (
        <div className="diff-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2>Choisissez le niveau de l'Écho</h2>
          <div className="diff-grid">
            {DIFFICULTIES.map((d) => (
              <div key={d.key} className="diff-option" role="button" tabIndex={0} onClick={() => chooseDifficulty(d.key)} onKeyDown={KEY_ACTIVATE(() => chooseDifficulty(d.key))}>
                <div className="diff-text">
                  <div className="name">{d.label}</div>
                  <div className="desc">{d.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {phase === "select-assist" && (
        <div className="diff-picker">
          <button className="back-btn" onClick={goBack}>← Retour</button>
          <h2>{mode === "local" ? "Options de la partie" : "Options d'assistance"}</h2>
          <div className="sub">{mode === "local" ? "Réglages du duel à deux sur cet appareil." : "Réglages valables pour cette partie contre l'Écho uniquement."}</div>
          {mode === "local" ? (
            <div className="assist-grid">
              <label className={`assist-option ${allowUndo ? "checked" : ""}`}>
                <input type="checkbox" checked={allowUndo} onChange={(e) => setAllowUndo(e.target.checked)} />
                <div className="assist-text">
                  <div className="name">Repentir</div>
                  <div className="desc">Autorise à annuler le dernier coup joué (bouton "Annuler").</div>
                </div>
              </label>
              <label className={`assist-option ${allowHint ? "checked" : ""}`}>
                <input type="checkbox" checked={allowHint} onChange={(e) => setAllowHint(e.target.checked)} />
                <div className="assist-text">
                  <div className="name">Augure</div>
                  <div className="desc">Un bouton révèle le meilleur coup du joueur dont c'est le tour.</div>
                </div>
              </label>
              <label className={`assist-option ${passageTelephone ? "checked" : ""}`}>
                <input type="checkbox" checked={passageTelephone} onChange={togglePassageTelephone} />
                <div className="assist-text">
                  <div className="name">Se passer le téléphone</div>
                  <div className="desc">La main du joueur dont c'est le tour descend en bas de l'écran. Rien ne pivote : on tend l'appareil tel quel.</div>
                </div>
              </label>
            </div>
          ) : (
          <div className="assist-grid">
            <label className={`assist-option ${allowUndo ? "checked" : ""}`}>
              <input type="checkbox" checked={allowUndo} onChange={(e) => setAllowUndo(e.target.checked)} />
              <div className="assist-text">
                <div className="name">Repentir</div>
                <div className="desc">Autorise à annuler un mauvais coup pendant la partie (bouton "Annuler").</div>
              </div>
            </label>
            <label className={`assist-option ${allowHint ? "checked" : ""}`}>
              <input type="checkbox" checked={allowHint} onChange={(e) => setAllowHint(e.target.checked)} />
              <div className="assist-text">
                <div className="name">Augure</div>
                <div className="desc">Un bouton en jeu révèle le meilleur coup, selon l'IA "Seigneur de Guerre".</div>
              </div>
            </label>
          </div>
          )}
          <button className="reset-btn" onClick={confirmAssistOptions}>Continuer</button>
        </div>
      )}

      {phase === "preview" && (() => {
        const isConfluence = redOrders.length > 2;
        // Aperçu : UNE carte par Ordre présent dans la main, et non les 2 premières cartes.
        // La main étant mélangée, un slice(0, 2) tombait souvent deux fois sur le même Ordre
        // et le second n'apparaissait jamais, alors que le sous-titre l'annonçait.
        const apercuParOrdre = (main) => {
          const vus = new Set();
          return main.filter((c) => {
            if (vus.has(c.ability)) return false;
            vus.add(c.ability);
            return true;
          });
        };
        return (
          <div className="order-picker">
            <button className="back-btn" onClick={goBack}>← Retour</button>
            {isConfluence ? (
              <>
                <h2>Votre main</h2>
                <div className="sub">
                  Confluence ({new Set(redHand.map((c) => c.ability)).size} Ordres) · niveau {DIFFICULTIES.find((d) => d.key === botDifficulty)?.label} · même main pour les deux camps
                </div>
                <div className="hand-row" style={{ maxWidth: 320 }}>
                  {blueHand.map((card) => (
                    <Card key={card.id} card={card} owner="blue" extraClass="hand" />
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2>Cartes de l'adversaire</h2>
                <div className="sub">
                  {DIFFICULTIES.find((d) => d.key === botDifficulty)?.label}
                </div>
                <div className="hand-row" style={{ maxWidth: 320 }}>
                  {apercuParOrdre(redHand).map((card) => (
                    <Card key={card.id} card={card} owner="red" extraClass="hand" concealed={card.ability === "scribe"} />
                  ))}
                </div>
                <div className="sub" style={{ color: "var(--blue-bright)", marginTop: 16 }}>Votre main</div>
                <div className="hand-row" style={{ maxWidth: 320 }}>
                  {apercuParOrdre(blueHand).map((card) => (
                    <Card key={card.id} card={card} owner="blue" extraClass="hand" />
                  ))}
                </div>
              </>
            )}
            <button className="reset-btn" onClick={startMatch}>Commencer la partie</button>
          </div>
        );
      })()}

      {phase === "play" && (
        <>
          <div className="status-line">
            {gameOver
              ? mode === "bot" ? (winner === "blue" ? "Victoire ! Vous l'emportez." : "L'Écho remporte la partie.")
                : mode === "online" ? (winner === onlineRole ? "Victoire ! Vous l'emportez." : "Défaite cette fois.")
                : `Victoire du camp ${winner === "blue" ? "Azur" : "Écarlate"} !`
              : mode === "online" && turn !== onlineRole
                ? (attenteAdv > TURN_SECONDS
                  ? `L'adversaire ne répond plus : victoire dans ${Math.max(1, FORFAIT_APRES_S - attenteAdv)}s...`
                  : "En attente de l'adversaire...")
              : mode === "online" && turn === onlineRole && timeLeft <= 0
                ? `Temps écoulé : jouez un coup, forfait dans ${Math.max(1, TURN_SECONDS + timeLeft)}s...`
              : drag ? "Relâchez sur une case en surbrillance pour poser la carte."
              : selected ? "Cliquez sur une case du plateau pour poser la carte."
              : mode === "local" ? `Au camp ${turn === "blue" ? "Azur" : "Écarlate"} de jouer.`
              : ""}
          </div>
          {mode === "online" && onlineError && <div className="online-error">{onlineError}</div>}

          <div className="zone-main">
            {labelCamp(campHaut)}
            {mainCamp(campHaut)}
          </div>

          {isHumanTurn && turn === campHaut && !testMode && <TimerBar timeLeft={timeLeft} />}

          {/* ═══ TEMPORAIRE — sélecteur d'arène, à retirer avant publication ═══ */}
          {testMode && (
            <div className="arene-test">
              <button className={!areneTest ? "actif" : ""} onClick={() => setAreneTest(null)}>Aucune</button>
              {Object.keys(ARENES).map((nom) => (
                <button key={nom} className={areneTest === nom ? "actif" : ""} onClick={() => setAreneTest(nom)}>{nom}</button>
              ))}
            </div>
          )}
          {/* ═══ TEMPORAIRE — bascule des capacités supérieures, bac à sable seulement ═══
              Un bouton par Ordre disposant d'un Héraut et ayant encore au moins une carte
              en main. N'agit que sur les cartes encore EN MAIN : celles déjà posées gardent
              l'état qu'elles avaient au moment de la pose, comme en partie réelle. Un Ordre
              dont toutes les cartes sont posées disparaît donc de la barre — le bouton n'a
              plus rien sur quoi agir. */}
          {testMode && (() => {
            const abilitiesEnMain = new Set([...blueHand, ...redHand].map((c) => c.ability));
            const ordres = HEROES
              .map((h) => ORDERS.find((o) => o.key === h.orderKey))
              .filter((o) => o && abilitiesEnMain.has(o.ability));
            if (ordres.length === 0) return null;
            return (
              <div className="arene-test heraut-test">
                <span className="heraut-test-label">Capacités supérieures</span>
                {ordres.map((o) => (
                  <button
                    key={o.key}
                    className={herautTestActif(o) ? "actif" : ""}
                    onClick={() => basculerHeraut(o)}
                    title={HEROES.find((h) => h.orderKey === o.key)?.desc}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
            );
          })()}
          {/* Bras de fer : le score, juste au-dessus du plateau, la ou le regard est deja.
              Le total en jeu se deduit des cartes encore en main — jamais 17 en dur, le bac
              a sable et le plateau 6x6 n'ont pas le meme compte. */}
          {(() => {
            const totalPts = blueScore + redScore + blueHand.length + redHand.length;
            if (!totalPts) return null;
            const pctAzur = (blueScore / totalPts) * 100;
            const pctEcarlate = (redScore / totalPts) * 100;
            // Le halo dore ne s'allume QU'A LA FIN. En cours de partie, depasser le
            // trait n'a rien d'acquis : une carte reprise et on repasse dessous. L'annoncer
            // comme une victoire serait mentir au joueur. Pendant le jeu, le trait reste un
            // simple repere ; c'est le coup final qui allume le camp vainqueur.
            const acquis = !gameOver ? null : blueScore * 2 > totalPts ? "blue" : redScore * 2 > totalPts ? "red" : null;
            return (
              <div
                className={`bras-de-fer ${acquis ? "franchi" : ""}`}
                role="img"
                aria-label={`Azur ${blueScore}, Ecarlate ${redScore}, sur ${totalPts} points en jeu`}
              >
                <span className={`bdf-num blue ${acquis === "blue" ? "acquis" : ""}`}>{blueScore}</span>
                <div className="bdf-piste">
                  <div className="bdf-cote bdf-azur" style={{ width: `${pctAzur}%` }} />
                  <div className="bdf-cote bdf-ecarlate" style={{ width: `${pctEcarlate}%` }} />
                  <span className="bdf-seuil" aria-hidden="true" />
                </div>
                <span className={`bdf-num red ${acquis === "red" ? "acquis" : ""}`}>{redScore}</span>
              </div>
            );
          })()}
          <div
            className={`table ${areneActive ? "arene" : ""} ${boardShake ? "table-shake" : ""} ${boardShakeBig ? "table-shake-big" : ""} ${ceremonieFin === "defaite" ? "board-defeat-shake" : ""}`}
            style={{
              "--board-cols": COLS,
              ...(areneActive ? { "--arene": `url(${ARENES[areneActive].img})`, "--arene-marge": ARENES[areneActive].marge, "--arene-braise": ARENES[areneActive].braise } : {}),
            }}
          >
            {areneActive && (
              <>
                {/* Ambiance : la même image, très agrandie, floutée et fondue jusqu'à
                    disparaître avant l'interface du haut et la main du bas. Elle porte la
                    couleur de la ligue dans la page sans montrer de contour d'image. */}
                <div className="arene-ambiance" aria-hidden="true" />
                {/* Cadre : l'image nette, cantonnée au pourtour de l'aire de jeu. Il ne
                    déborde plus vers l'interface — l'ambiance fait la transition. */}
                <div className="arene-cadre" aria-hidden="true">
                  {(ARENE_GEMMES[areneActive]?.pts || []).map(([x, y], i) => (
                    <span key={`c${i}`} className="arene-gemme" style={{
                      left: `${x}%`, top: `${y}%`,
                      "--gemme": ARENE_GEMMES[areneActive].teinte,
                      animationDelay: `${i * 0.9}s`,
                    }} />
                  ))}
                  {(ARENE_GEMMES[areneActive]?.mid || []).map(([x, y], i) => (
                    <span key={`m${i}`} className="arene-gemme mid" style={{
                      left: `${x}%`, top: `${y}%`,
                      "--gemme": ARENE_GEMMES[areneActive].teinte,
                      animationDelay: `${0.45 + i * 0.9}s`,
                    }} />
                  ))}
                </div>
                {/* Fumerolles et étincelles. Chacune part d'un coin, avec sa propre durée et
                    son propre retard : rien ne se synchronise, le mouvement reste crédible. */}
                <div className="arene-fumee" aria-hidden="true">
                  {ARENE_PARTICULES.map((p, i) => (
                    <span key={i} className={`arene-particule ${p.type}`} style={{
                      left: p.x, bottom: p.y, animationDuration: p.duree,
                      animationDelay: p.retard, "--derive": p.derive, "--taille": p.taille,
                    }} />
                  ))}
                </div>
              </>
            )}
            {banner && (
              <div key={banner.key} className={`ability-banner ${banner.text === "Résonance" ? "banner-resonance" : "banner-onde"}`}>
                {banner.text}
              </div>
            )}
            {board.map((cell, i) => {
              const previewing = !!liveDragPreviewBoard;
              // Un Scribe adverse encore dissimulé à vos yeux ne doit RIEN laisser deviner
              // pendant l'aperçu de pose — ni son rang (déjà masqué en "?"), ni le simple
              // fait qu'il serait capturé ou qu'il ferait Résonance. On ignore donc
              // complètement l'aperçu pour cette case précise et on garde son état réel.
              const cellConcealed = !!(cell && cell.scribeJustPlaced && (mode === "bot" ? cell.scribePlacedBy === "red" : mode === "online" ? cell.scribePlacedBy !== onlineRole : cell.scribePlacedBy !== turn));
              // Cas symétrique : VOS propres Scribes. Vous voyez vos rangs normalement, mais
              // ils sont masqués pour l'adversaire. Sans repère visuel, la capacité semble
              // ne rien faire — d'où ce compteur de tours restants affiché sur votre carte.
              const monCamp = mode === "bot" ? "blue" : mode === "online" ? onlineRole : turn;
              const cacheeAuxAutres = cell && cell.scribeJustPlaced && cell.scribePlacedBy === monCamp
                ? (cell.scribeConcealTurnsLeft || 0)
                : 0;
              const previewCard = previewing ? liveDragPreviewBoard[i] : null;
              // Une case est "affectée par l'aperçu" si son contenu différerait de l'état réel :
              // se remplit (pose, attirée par Cendres), se vide (attirée AILLEURS par Cendres),
              // ou son rang/propriétaire change (Éveil, Mue, Dévoreuse, capture...).
              const isBeingPreviewed = previewing && !cellConcealed && (
                (!cell && !!previewCard) ||
                (!!cell && !previewCard) ||
                (!!cell && !!previewCard && (
                  cell.owner !== previewCard.owner ||
                  cell.top !== previewCard.top || cell.right !== previewCard.right ||
                  cell.bottom !== previewCard.bottom || cell.left !== previewCard.left
                ))
              );
              const displayCard = (previewing && !cellConcealed) ? previewCard : cell;
              // En aperçu : AUCUNE animation de capacité — on montre uniquement les rangs
              // et couleurs hypothétiques. Les animations ne jouent qu'à la pose réelle.
              const displayEvents = previewing ? [] : (flashes[i] || []);
              // Pestiférés : cases qui deviendraient empoisonnées si on posait ici (pas encore
              // réellement empoisonnées tant qu'on n'a pas relâché).
              const willBePoisoned = previewing && !poisonedCells[i] && liveDragPreview.poisonedCells[i];
              // Profondeur du poison telle qu'elle coûterait au joueur dont c'est le tour
              // (le Héraut des Pestiférés épargne son propre camp : la case lui paraît donc
              // moins chargée qu'à l'adversaire).
              const poisonLvl = cell ? 0 : poisonCount(
                willBePoisoned ? liveDragPreview.poisonedCells[i] : poisonedCells[i],
                turn
              );
              const previewResonanceDirs = (previewing && !cellConcealed) ? (liveDragPreview.resonanceByCell[i] || []) : [];
              return (
                <div
                  key={i}
                  data-cell-idx={i}
                  role="button" tabIndex={0} onClick={(e) => playCard(i, e)} onKeyDown={KEY_ACTIVATE(() => playCard(i))}
                  className={`cell ${!cell ? "empty" : ""} ${!cell && selected ? "can-play" : ""} ${!cell && drag && dragHoverCell === i ? "can-play drag-target" : ""} ${!cell && (poisonedCells[i] || willBePoisoned) ? "poisoned" : ""} ${poisonLvl > 1 ? `poison-lvl-${Math.min(4, poisonLvl)}` : ""} ${willBePoisoned ? "poison-previewing" : ""} ${hint && hint.cellIdx === i ? "hint-target" : ""} ${justPoisoned.includes(i) ? "poison-burst" : ""} ${isBeingPreviewed ? "cell-previewing" : ""}`}
                >
                  {/* Terrain empoisonné : le calque porte les fissures, ses pseudo-éléments les
                      ronces et la flaque, et les deux <i> la fumée et les bulles qui éclatent. */}
                  {!cell && (poisonedCells[i] || willBePoisoned) && (
                    <span className="poison-fx"><i /><i /><i /></span>
                  )}
                  {displayCard && (
                    <Card
                      card={displayCard}
                      owner={displayCard.owner}
                      events={displayEvents}
                      extraClass={`${isBeingPreviewed ? "previewing" : ""} ${dernierCoup === i ? "dernier-coup" : ""}`}
                      poisoned={!!(displayCard && (poisonedCells[i] || willBePoisoned))}
                      hiddenFromFoe={cacheeAuxAutres}
                      concealed={displayCard.scribeJustPlaced && (mode === "bot" ? displayCard.scribePlacedBy === "red" : mode === "online" ? displayCard.scribePlacedBy !== onlineRole : displayCard.scribePlacedBy !== turn)}
                      previewResonanceDirs={previewResonanceDirs}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {isHumanTurn && turn === campBas && !testMode && <TimerBar timeLeft={timeLeft} />}

          <div>
            {mainCamp(campBas)}
            {labelCamp(campBas)}
          </div>

          {mode === "online" && (
            <>
              {/* Messages en direct : un bouton flottant, un panneau ancré au-dessus de la
                  main. Le badge compte les messages adverses arrivés panneau fermé. */}
              {/* Message affiche directement au-dessus du plateau. Double-clic dessus
                  (ou sur le bouton) pour couper ou remettre cet affichage. */}
              {messageBulle && !chatOuvert && (
                <div
                  className={`chat-bulle-directe ${messageBulle.by === onlineRole ? "de-moi" : "de-lui"}`}
                  role="button" tabIndex={0}
                  onDoubleClick={basculerMessagesDirects}
                  onClick={basculerChat}
                  onKeyDown={KEY_ACTIVATE(basculerChat)}
                  title="Toucher pour ouvrir les messages, double-toucher pour couper l'affichage direct"
                >
                  <span className="chat-bulle-auteur">{messageBulle.by === onlineRole ? "Vous" : "Adversaire"}</span>
                  {String(messageBulle.texte || "").slice(0, 200)}
                </div>
              )}
              {bulleAvis && <div className="chat-bulle-avis" role="status">{bulleAvis}</div>}
              <button
                className={`chat-bouton ${messagesDirects ? "" : "directs-coupes"}`}
                onClick={basculerChat}
                onDoubleClick={basculerMessagesDirects}
                aria-label={`Messages. Affichage direct ${messagesDirects ? "activé" : "coupé"}. Double-toucher pour changer.`}
                title={`Messages (double-toucher : affichage direct ${messagesDirects ? "activé" : "coupé"})`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3c5 0 9 3.3 9 7.4 0 4-4 7.3-9 7.3-.9 0-1.7-.1-2.5-.3L5 20l1-3.4C4.1 15.2 3 13 3 10.4 3 6.3 7 3 12 3zm0 2c-3.9 0-7 2.4-7 5.4 0 1.9 1.2 3.6 3.1 4.6l.8.4-.4 1.3 2-1 .5.1c.6.2 1.3.2 2 .2 3.9 0 7-2.4 7-5.4S15.9 5 12 5z" />
                </svg>
                {chatNonLus > 0 && <span className="chat-badge">{chatNonLus > 9 ? "9+" : chatNonLus}</span>}
              </button>
              {chatOuvert && (
                <div className="chat-panneau">
                  <div className="chat-liste" ref={chatListeRef}>
                    {chatMessages.length === 0 && <div className="chat-vide">Saluez votre adversaire !</div>}
                    {chatMessages.map((m) => (
                      <div key={m.id} className={`chat-msg ${m.by === onlineRole ? "chat-moi" : "chat-lui"}`}>{String(m.texte || "").slice(0, 200)}</div>
                    ))}
                  </div>
                  <div className="chat-saisie-ligne">
                    <input
                      className="chat-saisie"
                      maxLength={200}
                      placeholder="Votre message..."
                      value={chatSaisie}
                      onChange={(e) => setChatSaisie(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") envoyerMessage(); }}
                    />
                    <button className="chat-envoyer" onClick={envoyerMessage} disabled={!chatSaisie.trim()} aria-label="Envoyer">➤</button>
                  </div>
                </div>
              )}
            </>
          )}

          {drag && draggedCard && !liveDragPreviewBoard && (
            <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
              <Card card={draggedCard} owner={drag.owner} extraClass="hand" concealed={draggedCard.ability === "scribe"} />
            </div>
          )}

          <div className="action-row">
            {mode !== "online" && (testMode || allowUndo) && (
              <button className="reset-btn undo-btn" onClick={undo} disabled={history.length === 0 || !!drag}>
                <svg className="btn-icone" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
                Annuler
              </button>
            )}
            {(mode === "bot" || mode === "local") && allowHint && (
              <button className="reset-btn hint-btn" onClick={toggleHint} disabled={gameOver || (mode === "bot" && turn !== "blue")}>
                🔮 {hint ? "Masquer l'augure" : "Augure"}
              </button>
            )}
            {gameOver && boutonRevanche()}
            {/* En Classe, tant que la partie n'est pas finie, aucun bouton pour partir :
                un duel classe se joue jusqu'au bout. Le bouton reparait des la fin, ou il
                sert a lancer la partie suivante. Un adversaire qui cesse de jouer ne peut
                pas nous retenir pour autant : le forfait tranche tout seul apres deux
                tours sans coup. */}
            {!(partieClassee && !gameOver) && (
            <button
              className={`reset-btn ${gameOver ? "" : "quitter-discret"}`}
              onClick={gameOver ? (storyChapterKey ? continueChapter : (tourney.active ? finishTourneyMatch : tournoiOnlineId ? retournerAuTournoi : reset)) : () => setConfirmQuit(true)}
            >
              {gameOver ? (storyChapterKey ? (storyChapterJustCompleted ? "Voir la récompense" : "Continuer") : (tourney.active ? "Continuer le tournoi" : tournoiOnlineId ? "Retour au tournoi" : "Nouvelle partie")) : (<><svg className="btn-icone" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /><path d="m16 16 5-4-5-4" /><path d="M21 12H9" /></svg>Quitter</>)}
            </button>
            )}
          </div>

          {infoAbility && (
            <div className="info-overlay" onClick={() => setInfoAbility(null)}>
              <div className="info-panel" onClick={(e) => e.stopPropagation()}>
                <div className="info-panel-title">Capacités de cette partie</div>
                {(confluenceActive
                  ? draft.pool.map((k) => ORDERS.find((l) => l.key === k)).filter(Boolean)
                  : [
                      ...blueOrders.map((l) => ({ ...l, side: "blue" })),
                      ...redOrders.map((l) => ({ ...l, side: "red" })),
                    ]
                ).map((l, i) => (
                  <div key={i} className={`info-row ${l.side || ""}`}>
                    {l.portrait ? (
                      <img className="info-thumb-sm" src={l.portrait} alt={l.name} />
                    ) : (
                      <span className="info-icon-sm">{l.icon}</span>
                    )}
                    <div className="info-row-text">
                      <div className="info-row-name">{l.name}{l.side && <span className="info-row-side"> ({l.side === "blue" ? "Azur" : "Écarlate"})</span>}</div>
                      <div className="info-row-desc">{l.desc}</div>
                    </div>
                  </div>
                ))}
                <button className="reset-btn" onClick={() => setInfoAbility(null)}>Fermer</button>
              </div>
            </div>
          )}
        </>
      )}

      {ceremonieFin === "victoire" && (
        <div className={`cer-fin ${cerPose ? "cer-pose" : ""}`} onClick={() => setCerPose(true)}>
          <div className="cer-voile" aria-hidden="true" />
          <div className="cer-braises" aria-hidden="true">
            {CER_BRAISES.map((b, i) => (
              <span key={i} style={{ left: b.gauche, width: b.taille, height: b.taille, animationDuration: b.duree, animationDelay: b.retard, "--derive": b.derive }} />
            ))}
          </div>
          <div className="cer-scene">
            <div className="cer-onde" aria-hidden="true" />
            <div className="cer-titre" role="heading" aria-level={1} aria-label="Victoire">
              {"VICTOIRE".split("").map((l, i) => (
                <span key={i} style={{ "--li": i }} aria-hidden="true">{l}</span>
              ))}
            </div>
            <div className="cer-trait" aria-hidden="true" />
            <div className="cer-sous-titre">
              {mode === "bot" ? "L'Écho est repoussé"
                : mode === "online"
                  ? (finMotif === "abandon" ? "L'adversaire a abandonné"
                    : finMotif === "forfait" ? "L'adversaire n'a plus donné signe de vie"
                    : "Vous l'emportez")
                  : `Le camp ${winner === "blue" ? "Azur" : "Écarlate"} l'emporte`}
            </div>
            <div className="cer-recap" onClick={(e) => e.stopPropagation()}>
              <div className="cer-score">
                <span className="cer-sb">{blueScore}</span><span className="cer-sep">·</span><span className="cer-sr">{redScore}</span>
              </div>
              <div className="bdf-piste cer-piste">
                <div className="bdf-cote bdf-azur" style={{ width: `${(blueScore / (blueScore + redScore)) * 100}%` }} />
                <div className="bdf-cote bdf-ecarlate" style={{ width: `${(redScore / (blueScore + redScore)) * 100}%` }} />
                <span className="bdf-seuil" aria-hidden="true" />
              </div>
              {boutonRevanche()}
              <button className="reset-btn cer-continuer" onClick={tournoiOnlineId ? retournerAuTournoi : () => { setCeremonieFin(null); setCerPose(false); }}>
                {tournoiOnlineId ? "Retour au tournoi" : "Continuer"}
              </button>
            </div>
          </div>
        </div>
      )}

      {ceremonieFin === "defaite" && (
        <div className={`defeat-overlay ${cerPose ? "cer-pose" : ""}`} onClick={() => setCerPose(true)}>
          <div className="defeat-ruine" aria-hidden="true">
            {CER_BRAISES.map((b, i) => (
              <span key={i} style={{ left: b.gauche, width: b.taille, height: b.taille, animationDuration: b.duree, animationDelay: b.retard, "--derive": b.derive }} />
            ))}
          </div>
          <div className="defeat-title-container">
            <h1 className="defeat-title" aria-label="Défaite">DÉFAITE</h1>
            <div className="defeat-divider" aria-hidden="true" />
            <p className="defeat-subtitle">
              {mode === "bot" ? "L'Emprise vous a submergé" : "L'Emprise a submergé votre camp"}
            </p>
          </div>
          <div className="defeat-recap" onClick={(e) => e.stopPropagation()}>
            <div className="cer-score">
              <span className="cer-sb">{blueScore}</span><span className="cer-sep">·</span><span className="cer-sr">{redScore}</span>
            </div>
            <div className="bdf-piste cer-piste">
              <div className="bdf-cote bdf-azur" style={{ width: `${(blueScore / (blueScore + redScore)) * 100}%` }} />
              <div className="bdf-cote bdf-ecarlate" style={{ width: `${(redScore / (blueScore + redScore)) * 100}%` }} />
              <span className="bdf-seuil" aria-hidden="true" />
            </div>
            {boutonRevanche()}
            <button className="defeat-button" onClick={tournoiOnlineId ? retournerAuTournoi : () => { setCeremonieFin(null); setCerPose(false); reset(); }}>
              {tournoiOnlineId ? "Retour au tournoi" : mode === "online" ? "Retour au menu" : "Recommencer"}
            </button>
            <button className="defeat-lien" onClick={() => { setCeremonieFin(null); setCerPose(false); }}>
              Revoir le plateau
            </button>
          </div>
        </div>
      )}

      {confirmQuit && (
        <div className="info-overlay" onClick={() => setConfirmQuit(false)}>
          <div className="info-panel confirm-panel" onClick={(e) => e.stopPropagation()}>
            <div className="info-panel-title">{tourney.active ? "Abandonner le tournoi ?" : mode === "online" && !gameOver ? "Abandonner la partie ?" : "Quitter la partie ?"}</div>
            <div className="confirm-text">
              {tourney.active
                ? "Le tournoi en cours sera perdu et vous reviendrez au menu principal."
                : mode === "online" && !gameOver && tournoiOnlineId
                ? "L'adversaire remportera le duel et vous serez éliminé du tournoi. Vous reviendrez à l'arbre."
                : mode === "online" && !gameOver
                ? `L'adversaire remportera la victoire${partieClassee ? " et vous perdrez des trophées" : ""}. Vous reviendrez au menu principal.`
                : "La partie en cours sera perdue et vous reviendrez au menu principal."}
            </div>
            <div className="confirm-actions">
              <button className="reset-btn" onClick={() => setConfirmQuit(false)}>Continuer</button>
              <button className="reset-btn quit-confirm" onClick={mode === "online" && !gameOver ? quitterPartieEnLigne : reset}>
                {mode === "online" && !gameOver ? "Abandonner" : "Retour au menu"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
