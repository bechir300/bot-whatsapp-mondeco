# MONDECO — Agent IA omnicanal

Assistant client automatique de **Mondeco** (mobilier, Tunisie) sur **WhatsApp**, **Instagram** et **Facebook Messenger**, avec un **centre de pilotage** web pour l'équipe commerciale (boîte de réception unifiée, prise en main humaine, SLA, commentaires sociaux, catalogue, statistiques).

## Architecture

| Fichier | Rôle |
| --- | --- |
| `server.js` | Serveur Express : webhooks Meta, logique de conversation, appels IA (Gemini, secours Groq), envoi des messages, relances automatiques. |
| `Admin.js` | Routeur `/admin` : authentification, comptes et rôles, catalogue produits, instructions IA, paramètres, inbox commerciale, commentaires, sauvegardes, WooCommerce. |
| `Admin.html` | Interface du centre de pilotage (page unique, JS/CSS inline). |
| `lib/` | Modules partagés et testés : stockage JSON groupé, file par conversation, réseau, quotas IA, logs, confidentialité, prompt, indicateurs, évaluation IA. |
| `evals/` | Questions de référence de l'évaluation qualité IA (modifiables). |
| `business-info.txt` | Informations entreprise importées au premier démarrage comme instructions IA. |
| `tests/`, `test_*.js` | Tests automatisés (`npm test`). |
| `scripts/` | Vérification syntaxique d'Admin.html et lanceur de tests. |

Les données (conversations, comptes, produits, paramètres…) sont stockées en JSON dans `DATA_DIR` (Volume Railway `/data`). Elles ne sont **jamais** versionnées.

```
Client (WhatsApp / Instagram / Messenger)
        │  webhook Meta (signé HMAC)
        ▼
   server.js ──► file d'attente par conversation ──► IA Gemini (secours Groq)
        │                                              │
        │◄──────────── réponse / transfert commercial ◄┘
        ▼
   Admin.js + Admin.html (équipe commerciale)
```

## Démarrage local

```bash
npm install
cp .env.example .env    # puis renseigner les valeurs
npm start               # http://localhost:3000/admin
```

Node.js 20 ou plus est requis.

## Déploiement (Railway)

1. Monter un Volume sur `/data`.
2. Définir les variables de `.env.example` dans Railway → Variables. **`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `VERIFY_TOKEN` et `META_APP_SECRET` sont indispensables en production**, puis activer `WEBHOOK_SIGNATURE_REQUIRED=true`.
3. Configurer le webhook Meta sur `https://<domaine>/webhook` avec le même `VERIFY_TOKEN`.

À chaque redéploiement, le serveur reçoit `SIGTERM` : il arrête d'accepter de nouvelles connexions et termine les messages en cours (jusqu'à `SHUTDOWN_GRACE_MS`) avant de s'arrêter.

## Routes principales

| Route | Accès |
| --- | --- |
| `GET /health` | Public (supervision) |
| `GET/POST /webhook` | Meta (vérification du token / de la signature) |
| `/admin` | Équipe connectée, selon le rôle |
| `/debug-env`, `/debug-log`, `/test-ia`, `/reset-test-history` | Administrateurs connectés uniquement |

## Rôles

`admin`, `responsable_commercial`, `editor`, `commercial`. Les droits de chaque rôle sont définis dans `roleCanAccess()` (`Admin.js`).

## Qualité

```bash
npm test     # vérification syntaxique (server.js, Admin.js, Admin.html) + tests
```

La CI GitHub Actions (`.github/workflows/ci.yml`) lance `npm test` et `npm audit` à chaque push.

## Garde-fous d'exploitation

- **Quotas IA** : `AI_MAX_REPLIES_PER_CONTACT_PER_HOUR` (défaut 30) et `AI_MAX_CALLS_PER_DAY` (défaut 5 000). Au-delà, la conversation est transférée à un commercial.
- **Reprise automatique** : un message dont le traitement échoue est rejoué deux fois (15 s, puis 60 s), sauf s'il a déjà été journalisé.
- **Réseau** : délai maximal sur tous les appels IA et Meta, reprise des lectures sur 429/5xx.
- **Sessions** : expiration après 12 h d'inactivité (`MONDECO_SESSION_IDLE_HOURS`).
- **Stockage** : l'état des conversations est partagé en mémoire et écrit sur disque au plus toutes les 5 s (et immédiatement à l'arrêt, avant une sauvegarde ou un export).
- **Logs** : chaque requête reçoit un identifiant (`X-Request-Id`) repris dans tous ses logs. `LOG_FORMAT=json` pour des logs structurés, `ALERT_WEBHOOK_URL` pour recevoir les erreurs sur Slack, Discord, Google Chat ou Teams.

## Pilotage

- **Indicateurs** (menu 📊) : délais de réponse, part réglée par l'IA, transferts, intentions des clients, canaux. Les journées passées sont conservées dans `kpi-daily.json` (chiffres seulement).
- **Modèles WhatsApp** : renseigner `WHATSAPP_BUSINESS_ACCOUNT_ID` pour envoyer des modèles approuvés quand la fenêtre de 24 h est fermée. Les échecs de remise signalés par Meta s'affichent dans la conversation.
- **Évaluation de la qualité IA** (page Discussion de test, administrateurs) : rejoue `evals/ai-reference-questions.json` et des questions de prix du catalogue. À relancer après chaque modification des instructions, du catalogue ou du modèle.

## Confidentialité

Par défaut, les logs masquent les numéros de téléphone (`***1234`) et le contenu des messages. `LOG_MESSAGE_CONTENT=true` les réactive pour un débogage ponctuel ; à désactiver juste après.

Voir `ETUDE-TECHNIQUE.md` pour l'audit complet et la feuille de route.
