# MONDECO — Agent IA omnicanal

Assistant client automatique de **Mondeco** (mobilier, Tunisie) sur **WhatsApp**, **Instagram** et **Facebook Messenger**. Il s'accompagne d'un **centre de pilotage** web pour l'équipe commerciale : boîte de réception unifiée, prise en main humaine, SLA, commentaires sociaux, catalogue, indicateurs.

Version **6.41.0** : version de production du VPS (V6.36.102) + audit de sécurité, fiabilité et pilotage (voir `ETUDE-TECHNIQUE.md`) + copilote IA des commerciaux fiche client commerciale messages WhatsApp interactifs et nouvelle charte graphique (étape 1 : couleurs et polices).

## Architecture

| Fichier | Rôle |
| --- | --- |
| `server.js` | Serveur Express : webhooks Meta, logique de conversation, appels IA (Gemini, secours Groq), envoi des messages, relances. |
| `Admin.js` | Routeur `/admin` : authentification, comptes et rôles, catalogue, instructions IA, paramètres, inbox commerciale, commentaires, sauvegardes, WooCommerce, indicateurs, évaluation IA. Stockage de l'état des conversations : JSON + SQLite (`mondeco.db`). |
| `Admin.html` | Interface du centre de pilotage (page unique, PWA). |
| `catalog-feed.js`, `location-showrooms.js`, `product-named.js`, `read-receipt.js`, `showroom-pin.js` | Modules métier (flux catalogue, showrooms, produits nommés, accusés de lecture, épinglage). |
| `lib/` | Modules partagés et testés : file par conversation et reprise, réseau, quotas IA, logs, confidentialité, prompt, indicateurs, évaluation IA, stockage JSON groupé. |
| `evals/` | Questions de référence de l'évaluation qualité IA (modifiables). |
| `pwa-assets/`, `sticker-assets/` | Icônes de l'application installable et stickers WhatsApp. |
| `tests/`, `test_*.js`, `scripts/` | Tests automatisés et vérifications (`npm test`). |

Les données (conversations, comptes, base SQLite, médias…) sont écrites dans `DATA_DIR`, ou à défaut dans le dossier de l'application. Elles ne doivent **jamais** être envoyées sur GitHub (voir `.gitignore`).

## Installation sur le VPS (Ubuntu)

L'application tourne avec un **utilisateur dédié**, jamais en root. Node.js 20 ou plus est requis (`node -v`).

```bash
# Mise à jour du code (dans le dossier de l'application)
cd /opt/mondeco
git fetch origin
git checkout <branche-ou-version>
npm ci --omit=dev          # installe exactement les dépendances du package-lock
npm test                   # optionnel : vérifie que tout est valide
sudo systemctl restart mondeco    # ou : pm2 restart mondeco
```

Lors d'un redémarrage, le serveur reçoit `SIGTERM` : il cesse d'accepter des connexions, termine les messages en cours, enregistre les fichiers en attente (journal, état des conversations, historique IA) puis s'arrête (au plus `SHUTDOWN_GRACE_MS`, 20 s par défaut).

**HTTPS est obligatoire** pour les webhooks Meta : placez Nginx ou Caddy devant l'application (port 3000 non exposé). Avec Nginx sur la même machine, laissez `TRUST_PROXY_HOPS` vide.

## Variables essentielles (`.env`)

| Variable | Rôle |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Compte administrateur (12 caractères minimum). Sans `ADMIN_PASSWORD`, aucun compte n'est créé ni réinitialisé (le mot de passe par défaut ne sert qu'avec `NODE_ENV=development`). |
| `VERIFY_TOKEN` | Vérification du webhook Meta (obligatoire). |
| `META_APP_SECRET` | Signature des webhooks. Une fois renseignée, activez `WEBHOOK_SIGNATURE_REQUIRED=true`. |
| `WHATSAPP_REENGAGEMENT_TEMPLATE_NAME` | Modèle approuvé pour relancer un client hors fenêtre de 24 h. |

Toutes les variables sont documentées dans `.env.example`.

## Routes principales

| Route | Accès |
| --- | --- |
| `GET /health` | Public (supervision) |
| `GET/POST /webhook` | Meta (token de vérification, signature) |
| `/admin` | Équipe connectée, selon le rôle |
| `/debug-env`, `/debug-log`, `/test-ia`, `/reset-test-history` | Administrateurs connectés uniquement |

## Garde-fous d'exploitation

- **IA** : plage horaire et budget mensuel (existants) ; quota par client `AI_MAX_REPLIES_PER_CONTACT_PER_HOUR` (30 par défaut) ; délai maximal de 25 s par appel avec bascule vers Groq.
- **Messages** : traitement dans l'ordre pour chaque client ; reprise automatique d'un message en échec (15 s puis 60 s), sauf s'il est déjà journalisé.
- **Réseau** : délai maximal sur tous les appels Meta ; reprise des lectures sur 429/5xx ; taille des médias plafonnée.
- **Sessions** : expiration après 12 h d'inactivité (`MONDECO_SESSION_IDLE_HOURS`) ; limite de tentatives de connexion par adresse IP et par compte.
- **Performance** (V6.37.2–6.37.3) :
  - `adReferral` allégé (135 → 77 Mo en production) ;
  - SQLite ne réécrit que les conversations modifiées ;
  - fichier JSON d'état réécrit au plus une fois par minute (`MONDECO_STATE_JSON_MIN_INTERVAL_MS`), toujours à l'arrêt, avant un snapshot ou un export, avec reprise depuis SQLite après un arrêt brutal ;
  - boîte de réception incrémentale : seules les nouvelles lignes d'événements sont lues.

  Les logs `⏱️ État des conversations` et `⏱️ Inbox` signalent toute opération de plus de 0,5 s.
- **Logs** : identifiant `X-Request-Id` par requête, repris dans tous ses logs ; numéros masqués et contenu des messages retiré (`LOG_MESSAGE_CONTENT=true` pour un débogage ponctuel) ; `LOG_FORMAT=json` ; alertes d'erreurs vers `ALERT_WEBHOOK_URL` (Slack, Discord, Google Chat, Teams).

## Pilotage

- **Messages WhatsApp interactifs** (bouton ＋ d'une conversation WhatsApp) :
  - « 🛋️ Fiche produit » : photo, prix (promotion barrée), dimensions et bouton « Voir le produit » vers le site ; sans lien, trois boutons de réponse. Les photos WebP sont converties en JPEG.
  - « 🔘 Question à boutons » : une question et jusqu'à 3 boutons (20 caractères chacun).
  - Un clic du client sur un bouton arrive comme un message texte normal (IA, transfert, notifications inchangés). Fenêtre de 24 h obligatoire, comme pour un message libre.

- **Fiche client** (panneau « Fiche client » d'une conversation, section Suivi commercial) : étape de vente (Nouveau, Qualifié, Devis envoyé, Visite showroom, Commande, Perdu), ville, budget, produits souhaités, showroom conseillé, note interne. Le bouton « ✨ Remplir avec l'IA » propose les champs à partir de la conversation, sans jamais écraser ce que le commercial a déjà saisi ; rien n'est enregistré sans clic sur « Enregistrer ». L'étape apparaît dans la liste des conversations.
- **Parcours de vente** (page 📊 Indicateurs) : combien de conversations deviennent clients qualifiés, devis, visites et commandes, et quelles publicités vendent le plus.

- **Copilote IA** (bouton ✨ dans la zone de saisie d'une conversation) : en journée, quand l'IA ne répond pas aux clients, le commercial obtient un brouillon de réponse rédigé avec les mêmes instructions, le même catalogue et le même contexte publicitaire que l'IA. Le brouillon est modifiable et n'est jamais envoyé automatiquement. Quand une information fiable manque, l'IA laisse un passage `[À COMPLÉTER : …]` (surligné) ; l'envoi est bloqué tant qu'il en reste un. Le budget IA mensuel s'applique ; quota `AI_COPILOT_MAX_PER_USER_PER_HOUR` (60 par défaut).

- **Indicateurs** (menu 📊, admin et responsable commercial) : délais de réponse, part réglée par l'IA, transferts, conversations sans réponse, intentions showroom et prix, publicités, canaux. Les journées passées sont conservées dans `kpi-daily.json`, sans aucune donnée client.
- **Évaluation de la qualité IA** (page Discussion de test, administrateurs) : rejoue `evals/ai-reference-questions.json` et des questions de prix du catalogue. À relancer après chaque modification des instructions, du catalogue ou du modèle.

## Qualité

```bash
npm test     # syntaxe de tous les fichiers JS (y compris Admin.html) + tests
```

La CI GitHub Actions (`.github/workflows/ci.yml`) lance `npm test` et `npm audit` à chaque push.
