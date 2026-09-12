import React from "react";
import ReactDOM from "react-dom/client";
// La mesure d'audience de l'hebergeur : combien de visites, d'ou elles viennent.
// Sans cookie et sans identifiant durable -- le comptage repose sur une empreinte
// technique recalculee chaque jour. Le composant ne rend rien a l'ecran : il pose
// le script de Vercel, qui reste muet en developpement local.
import { Analytics } from "@vercel/analytics/react";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    <Analytics />
  </React.StrictMode>
);
