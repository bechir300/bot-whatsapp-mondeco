# MONDECO — Agent IA omnicanal

Assistant client automatique de **Mondeco** (mobilier, Tunisie) sur **WhatsApp**, **Instagram** et **Facebook Messenger**. Il s'accompagne d'un **centre de pilotage** web pour l'équipe commerciale : boîte de réception unifiée, prise en main humaine, SLA, commentaires sociaux, catalogue, indicateurs.

Version **6.37.0** : version de production du VPS (V6.36.102) + audit de sécurité, fiabilité et pilotage (voir `ETUDE-TECHNIQUE.md`).

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
- **Logs** : identifiant `X-Request-Id` par requête, repris dans tous ses logs ; numéros masqués et contenu des messages retiré (`LOG_MESSAGE_CONTENT=true` pour un débogage ponctuel) ; `LOG_FORMAT=json` ; alertes d'erreurs vers `ALERT_WEBHOOK_URL` (Slack, Discord, Google Chat, Teams).

## Pilotage

- **Indicateurs** (menu 📊, admin et responsable commercial) : délais de réponse, part réglée par l'IA, transferts, conversations sans réponse, intentions showroom et prix, publicités, canaux. Les journées passées sont conservées dans `kpi-daily.json`, sans aucune donnée client.
- **Évaluation de la qualité IA** (page Discussion de test, administrateurs) : rejoue `evals/ai-reference-questions.json` et des questions de prix du catalogue. À relancer après chaque modification des instructions, du catalogue ou du modèle.

## Qualité

```bash
npm test     # syntaxe de tous les fichiers JS (y compris Admin.html) + tests
```

La CI GitHub Actions (`.github/workflows/ci.yml`) lance `npm test` et `npm audit` à chaque push.
