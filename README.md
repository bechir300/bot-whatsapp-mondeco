# MONDECO — Agent IA omnicanal

Agent conversationnel de Mondeco (mobilier, Tunisie) pour WhatsApp, Instagram et Facebook, avec un back-office pour l'équipe commerciale : boîte de réception unifiée, commentaires des réseaux sociaux, prise en main par un conseiller, SLA, tâches, plannings, catalogue synchronisé avec WooCommerce.

## Fonctionnement

```
Meta (WhatsApp / Instagram / Facebook)
        │  webhooks signés (X-Hub-Signature-256)
        ▼
server.js ── IA : Gemini (principal), Groq (secours), Cloudflare (images)
        │  réponses via l'API Graph de Meta
        ▼
Admin.js  ── back-office /admin : authentification, rôles, API, données
Admin.html ─ interface des commerciaux
        │
        ▼
DATA_DIR (/data, volume Railway) : fichiers JSON + médias
```

| Fichier | Rôle |
|---|---|
| `server.js` | Webhooks Meta, moteur de réponse IA, envoi des messages, relances |
| `Admin.js` | Routeur `/admin`, utilisateurs et rôles, stockage, synchronisations, rapports |
| `Admin.html` | Application web du back-office |
| `business-info.txt` | Informations de l'entreprise injectées dans le contexte de l'IA |
| `test/` | Tests automatisés (`node:test`) |

Rôles : `admin`, `responsable_commercial`, `commercial`, `editor`. Les droits sont refusés par défaut et vérifiés côté serveur sur chaque route.

## Démarrage local

Prérequis : Node.js 20 ou 22.

```bash
npm ci
```

```bash
cp .env.example .env
```

Renseigner au minimum `ADMIN_PASSWORD` et `DATA_DIR` (un dossier local), puis :

```bash
npm start
```

Le back-office est sur http://localhost:3000/admin.

## Tests et contrôles

```bash
npm run check
```

```bash
npm test
```

Les tests chargent `Admin.js` avec un dossier de données temporaire ; ils ne touchent jamais aux données réelles. La CI GitHub Actions lance ces deux commandes et `npm audit` à chaque push et pull request.

## Déploiement (Railway)

1. Variables obligatoires : `ADMIN_PASSWORD`, `VERIFY_TOKEN`, `META_APP_SECRET`, les jetons des canaux utilisés et `GEMINI_API_KEY` (ou `GROQ_API_KEY`). La liste complète est dans `.env.example`.
2. Un volume monté sur `/data`, avec les sauvegardes Railway activées.
3. Healthcheck : `GET /health` (répond 503 seulement si le dossier de données n'est pas accessible en écriture).
4. Au démarrage, les journaux listent les variables critiques manquantes.

L'arrêt sur `SIGTERM` (redéploiement) attend la fin des messages en cours de traitement avant de quitter.

## Sécurité

- Les webhooks Meta non signés sont refusés. `ALLOW_UNSIGNED_WEBHOOKS=true` existe comme secours temporaire uniquement.
- Les jetons Meta ne sont envoyés qu'aux domaines Meta.
- Aucun mot de passe par défaut : sans `ADMIN_PASSWORD` et sans utilisateur existant, un mot de passe aléatoire est généré et affiché une seule fois dans les journaux.
- Signaler une faille : contacter directement l'administrateur du dépôt, sans ouvrir d'issue publique.

## Contribuer

- Une branche par changement, une pull request relue avant fusion dans `main`.
- Mettre à jour la version dans `package.json` et `CHANGELOG.md` à chaque mise en production.
