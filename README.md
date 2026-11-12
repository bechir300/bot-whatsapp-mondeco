# MONDECO — Agent IA WhatsApp

Assistant client automatique de **Mondeco** (mobilier, Tunisie) sur **WhatsApp**. Il s'accompagne d'un **centre de pilotage** web pour l'équipe commerciale : boîte de réception, prise en main humaine, SLA, catalogue, indicateurs.

**Instagram et Facebook (Messenger, commentaires)** : le code existe mais, depuis le 13/10, **seul WhatsApp est traité**. Les webhooks Instagram et Facebook sont acquittés puis ignorés (une ligne « ignoré » dans les logs, compteur dans `/health`). Ils se réactivent sans modifier le code : `INSTAGRAM_WEBHOOK_ENABLED=true`, `FACEBOOK_WEBHOOK_ENABLED=true` (voir `.env.example`). Tant qu'ils sont désactivés, désabonnez aussi ces champs du webhook dans l'app Meta.

Version : celle de `package.json` (**6.46.0**), affichée au démarrage et par `GET /health` (avec le commit déployé). Historique : version de production du VPS (V6.36.102) + audit de sécurité, fiabilité et pilotage (voir `ETUDE-TECHNIQUE.md`) + copilote IA des commerciaux, fiche client commerciale, messages WhatsApp interactifs, nouvelle charte graphique (V6.44), corrections V6.45–V6.46.

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

## Déploiement

### Version de Node.js

**Node.js 22 LTS** (22 ou plus ; la CI teste 22 et 24). **Node.js 20 n'est pas pris en charge** : le module SQLite (`better-sqlite3` 13) y plante (erreur de segmentation) au premier message reçu, après l'accusé envoyé à Meta, sans log ni alerte. Depuis V6.46 :

- `npm ci` refuse de s'installer sur une version trop ancienne (`engines` + `.npmrc` `engine-strict=true`) ;
- le serveur refuse de démarrer, avec un message clair, sous Node.js < 22.

Vérifiez avec `node -v` avant toute mise à jour. Installation de Node.js 22 : paquet NodeSource (`setup_22.x`) ou `nvm install 22`, puis `npm ci --omit=dev` (le module natif doit être réinstallé pour la nouvelle version).

### Branche et version à déployer

- **Production : un tag de version `vX.Y.Z`** (même numéro que `package.json`, ex. `v6.46.0`), créé sur la branche de production **`fix/annonces-prix-audit`** une fois la CI verte. Revenir en arrière = `git checkout` du tag précédent.
- ⚠️ **`main` est obsolète** (code d'août 2026, version 1.0.0, sans les corrections de sécurité V6.37+) et **`vps-production` aussi** : ne déployez jamais depuis ces branches, ni avec un simple `git pull` sur la branche par défaut.
- Création d'un tag (équipe technique) : `git tag -a v6.46.0 -m "MONDECO 6.46.0" && git push origin v6.46.0`.

### Installation sur le VPS (Ubuntu)

L'application tourne avec un **utilisateur dédié** (`mondeco`), jamais en root. Code dans `/opt/mondeco`, données dans un dossier séparé (`DATA_DIR=/opt/mondeco/data`, propriétaire `mondeco`). Le fichier **`.env` est lu dans le dossier de l'application** (`/opt/mondeco/.env`), quel que soit le dossier courant (V6.46).

Service systemd (`/etc/systemd/system/mondeco.service`) :

```ini
[Unit]
Description=MONDECO bot WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
User=mondeco
WorkingDirectory=/opt/mondeco
ExecStart=/usr/bin/node /opt/mondeco/server.js
Restart=always
RestartSec=5
# Laisse le temps à l'arrêt propre (SHUTDOWN_GRACE_MS, 20 s par défaut)
TimeoutStopSec=30
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Puis `sudo systemctl daemon-reload && sudo systemctl enable --now mondeco`. Avec pm2 : `pm2 start /opt/mondeco/server.js --name mondeco --cwd /opt/mondeco`.

### Mise à jour

```bash
cd /opt/mondeco
node -v                              # 22 ou plus, sinon installer Node.js 22 d'abord
sudo -u mondeco git fetch origin --tags
sudo -u mondeco git checkout v6.46.0  # le tag de la version à déployer
sudo -u mondeco npm ci --omit=dev    # dépendances exactes du package-lock
sudo systemctl restart mondeco       # ou : pm2 restart mondeco
curl -s http://127.0.0.1:3000/health # « status »: « ok », « version » = version déployée
```

À faire une fois en passant à V6.46 :

- **supprimez `WEBHOOK_SIGNATURE_REQUIRED=false` de `.env`** s'il y figure (conseillé avant V6.45 ; il laisse passer sans signature les canaux sans App Secret) ;
- déplacez le `.env` dans le dossier de l'application s'il était ailleurs (une alerte au démarrage le signale) ;
- sur un VPS avec Nginx local, ajoutez `HOST=127.0.0.1` (le port de l'application n'est alors plus joignable directement depuis Internet) ;
- `/health` peut maintenant répondre **503 « degraded »** (voir ci-dessous) : adaptez la supervision si elle n'attendait que 200.

Lors d'un redémarrage, le serveur reçoit `SIGTERM` : il cesse d'accepter des connexions, termine les messages en cours, enregistre les fichiers en attente (journal, état des conversations, historique IA) puis s'arrête (au plus `SHUTDOWN_GRACE_MS`, 20 s par défaut).

**HTTPS est obligatoire** pour les webhooks Meta : placez Nginx ou Caddy devant l'application (`HOST=127.0.0.1` pour que le port 3000 ne soit pas exposé ; défaut `0.0.0.0`, nécessaire sur Railway/Docker). Avec Nginx sur la même machine, laissez `TRUST_PROXY_HOPS` vide ; sur Railway, il vaut 1 automatiquement ; derrière un autre proxy distant, mettez `TRUST_PROXY_HOPS=1` (sinon toute l'équipe partage la même adresse IP pour la limite de connexion, une alerte le signale dans les logs).

### Supervision (`GET /health`)

Réponse JSON publique, sans version de Node ni secret :

- `status` : `ok` (HTTP 200) ou `degraded` (HTTP **503**) avec `reasons` : dossier des données non inscriptible, base SQLite `mondeco.db` illisible (fichier corrompu, mauvais propriétaire, module natif incompatible), ou, avec `NODE_ENV=production`, `VERIFY_TOKEN` / `WHATSAPP_TOKEN` / `PHONE_NUMBER_ID` manquant ;
- `version` (package.json) et `commit` déployés, `uptime_s` ;
- `checks.last_webhook` : date et âge du dernier webhook Meta accepté (information : la nuit, aucun message est normal) ;
- `channels` et `checks.ignored_webhooks` : canaux traités et webhooks Instagram/Facebook ignorés depuis le démarrage.

Une base SQLite indisponible n'arrête pas le bot (l'état des conversations continue sur le fichier JSON) : elle est signalée **une fois** (log d'erreur + alerte `ALERT_WEBHOOK_URL`), retentée automatiquement (30 s, puis jusqu'à 5 min), et `/health` reste « degraded » tant qu'elle n'est pas réparée. Une exception non rattrapée envoie son alerte **avant** l'arrêt du processus (le gestionnaire de processus le relance).

## Variables essentielles (`.env`)

| Variable | Rôle |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Compte administrateur (12 caractères minimum). Sans `ADMIN_PASSWORD`, aucun compte n'est créé ni réinitialisé (le mot de passe par défaut ne sert qu'avec `NODE_ENV=development`). |
| `VERIFY_TOKEN` | Vérification du webhook Meta (obligatoire). |
| `META_APP_SECRET` | Signature des webhooks. Dès qu'elle est renseignée, tout webhook non signé ou mal signé est refusé (401). Laissez `WEBHOOK_SIGNATURE_REQUIRED` vide ; `false` n'est qu'une désactivation d'urgence pour les canaux sans secret. Sans aucun secret, les webhooks restent acceptés (alerte au démarrage). |
| `TRUST_PROXY_HOPS` | Nombre de proxys devant l'application (vide avec Nginx local, 1 automatique sur Railway). |
| `ADMIN_ORIGIN_CHECK`, `ADMIN_ALLOWED_ORIGINS` | Protection CSRF de `/admin` (`enforce` par défaut, `report` pour diagnostiquer) et adresses supplémentaires du centre de pilotage. |
| `WHATSAPP_REENGAGEMENT_TEMPLATE_NAME` | Modèle approuvé pour relancer un client hors fenêtre de 24 h. |
| `HOST` | Adresse d'écoute (défaut `0.0.0.0` ; `127.0.0.1` sur un VPS derrière Nginx local). |
| `INSTAGRAM_WEBHOOK_ENABLED`, `FACEBOOK_WEBHOOK_ENABLED` | Traitement des messages Instagram / Facebook (défaut `false` : WhatsApp uniquement). |
| `ALERT_WEBHOOK_URL` | Alertes d'erreurs (Slack, Discord, Google Chat, Teams), y compris base SQLite indisponible et arrêt sur exception. |

Toutes les variables sont documentées dans `.env.example`.

## Routes principales

| Route | Accès |
| --- | --- |
| `GET /health` | Public (supervision : 200 « ok » ou 503 « degraded ») |
| `GET/POST /webhook` | Meta (token de vérification, signature) |
| `/admin` | Équipe connectée, selon le rôle |
| `/debug-env`, `/debug-log`, `/test-ia`, `/reset-test-history` | Administrateurs connectés uniquement |

## Garde-fous d'exploitation

- **IA** : plage horaire et budget mensuel (existants) ; quota par client `AI_MAX_REPLIES_PER_CONTACT_PER_HOUR` (30 par défaut) ; délai maximal de 25 s par appel avec bascule vers Groq.
- **Messages** : traitement dans l'ordre pour chaque client ; reprise automatique d'un message en échec (15 s puis 60 s), sauf s'il est déjà journalisé.
- **Réseau** : délai maximal sur tous les appels Meta ; reprise des lectures sur 429/5xx ; taille des médias plafonnée.
- **Sessions** : expiration après 12 h d'inactivité (`MONDECO_SESSION_IDLE_HOURS`) ; limite de tentatives de connexion (V6.45) : 8 échecs pour un même compte depuis une même adresse IP ou 30 échecs d'une adresse IP bloquent cette adresse 15 min ; un compte visé depuis de nombreuses adresses n'est jamais bloqué, la vérification est seulement retardée (1 s à 8 s, `LOGIN_EMAIL_MAX_DELAY_MS`) : le vrai titulaire peut toujours se connecter.
- **Sécurité du centre de pilotage** (V6.45) :
  - toute requête qui modifie des données sous `/admin` doit venir de l'application (Origin/Referer, `Sec-Fetch-Site` ou en-tête `X-Mondeco-Client`), sinon 403 `CSRF_ORIGIN_REJECTED` ; `ADMIN_ORIGIN_CHECK=report` pour diagnostiquer un proxy qui réécrit l'adresse ;
  - en-têtes : `Content-Security-Policy: script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` et `X-Frame-Options: DENY` (l'application ne peut plus être affichée dans un cadre) ;
  - réponses rapides (envoyées telles quelles aux clients, y compris automatiquement aux prospects publicitaires) : création, modification, import et suppression réservés à l'administrateur, au responsable commercial et à l'éditeur ; les commerciaux les utilisent en lecture seule. Auteur enregistré sur chaque réponse, historique (ancien et nouveau texte) dans le journal d'activité, consultable via `GET /admin/api/quick-replies/history` ;
  - suppression d'un message : un commercial ne peut que **masquer** un message d'une conversation qui lui est affectée ; le message affiche « Message masqué par … », la conversation reste dans la boîte de réception, l'administrateur peut le restaurer ou le supprimer définitivement. Chaque action est tracée (journal d'activité + `message-deletions.json`) ;
  - envois commerciaux et appels WhatsApp : le destinataire est déduit de la conversation contrôlée (un `externalContact` différent est refusé, 400 `RECIPIENT_MISMATCH`) ;
  - page « Réponses IA » : un commercial ne voit que les canaux de son planning du jour ;
  - webhooks WhatsApp : si `PHONE_NUMBER_ID` est configuré, un webhook de messages sans ce numéro (`metadata.phone_number_id`) est ignoré.
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
  - « Fiches produit automatiques » (Paramètres, désactivé par défaut) : quand la réponse de l'IA cite un seul produit du catalogue dont le prix est connu, sa fiche est envoyée juste après (au plus une fois par produit et par client en 24 h, 3 par jour ; photo seulement si elle est en JPEG ou PNG).
  - Un clic du client sur un bouton arrive comme un message texte normal (IA, transfert, notifications inchangés). Fenêtre de 24 h obligatoire, comme pour un message libre.

- **Fiche client** (panneau « Fiche client » d'une conversation, section Suivi commercial) : étape de vente (Nouveau, Qualifié, Devis envoyé, Visite showroom, Commande, Perdu), ville, budget, produits souhaités, showroom conseillé, note interne. Le bouton « ✨ Remplir avec l'IA » propose les champs à partir de la conversation, sans jamais écraser ce que le commercial a déjà saisi ; rien n'est enregistré sans clic sur « Enregistrer ». L'étape apparaît dans la liste des conversations.
- **Parcours de vente** (page 📊 Indicateurs) : combien de conversations deviennent clients qualifiés, devis, visites et commandes, et quelles publicités vendent le plus.

- **Copilote IA** (bouton ✨ dans la zone de saisie d'une conversation) : en journée, quand l'IA ne répond pas aux clients, le commercial obtient un brouillon de réponse rédigé avec les mêmes instructions, le même catalogue et le même contexte publicitaire que l'IA. Le brouillon est modifiable et n'est jamais envoyé automatiquement. Quand une information fiable manque, l'IA laisse un passage `[À COMPLÉTER : …]` (surligné) ; l'envoi est bloqué tant qu'il en reste un. Le budget IA mensuel s'applique ; quota `AI_COPILOT_MAX_PER_USER_PER_HOUR` (60 par défaut).

- **Indicateurs** (menu 📊, admin et responsable commercial) : délais de réponse, part réglée par l'IA, transferts, conversations sans réponse, intentions showroom et prix, publicités, canaux. Les journées passées sont conservées dans `kpi-daily.json`, sans aucune donnée client.
- **Évaluation de la qualité IA** (page Discussion de test, administrateurs) : rejoue `evals/ai-reference-questions.json` et des questions de prix du catalogue. À relancer après chaque modification des instructions, du catalogue ou du modèle.

## Mode sombre

Bouton « Mode sombre » en bas du menu (choix mémorisé par appareil). Les règles sombres sont générées automatiquement à partir du CSS de `Admin.html` par `scripts/build-dark-theme.js`. Après une modification importante du CSS, lancez :

```bash
npm run build:dark
```

`npm test` signale un mode sombre qui n'est plus à jour.

## Qualité

```bash
npm test     # syntaxe de tous les fichiers JS (y compris Admin.html) + tests
```

`npm run check` vérifie la syntaxe de **tous** les fichiers `.js` du dépôt (modules de la racine et `pwa-assets/sw.js` compris) et que chaque `require('./…')` désigne un fichier existant. Les tests de la racine (`test_*.js`) chargent les vraies fonctions d'`Admin.js` ; `tests/ops-boot.test.js` démarre le vrai serveur (dossier de données temporaire) : `/health`, webhook WhatsApp, base SQLite. La CI GitHub Actions (`.github/workflows/ci.yml`) lance `npm test` sous Node.js 22 et 24, puis `npm audit`, à chaque push.
