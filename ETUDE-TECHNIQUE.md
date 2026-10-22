# Étude technique — MONDECO V6.38.0

Audit complet du bot omnicanal (WhatsApp, Instagram, Facebook) et du centre de pilotage, réalisé en octobre 2026. Cette étude couvre la sécurité, la fiabilité, la performance, la confidentialité, la maintenabilité et l'expérience utilisateur. Elle sépare **ce qui est corrigé dans cette version** de **ce qui reste à faire**, par priorité.

## 1. État des lieux

| Indicateur | Valeur |
| --- | --- |
| Code | `server.js` ~9 600 lignes, `Admin.js` ~21 000, `Admin.html` ~17 000 |
| Dépendances | express, multer, dotenv, compression |
| Stockage | Fichiers JSON sur Volume Railway (écriture atomique tmp + rename, sauvegardes `.bak`, snapshots) |
| Routes admin | 114, toutes authentifiées sauf login/logout et webhook WooCommerce (signé HMAC) |
| Tests | 34 tests métier (compteurs « à répondre ») + 7 tests de sécurité ajoutés |

**Points forts :**
- Mots de passe hachés en scrypt avec sel, comparaison à temps constant.
- Jetons de session aléatoires de 32 octets, seule leur empreinte SHA-256 est stockée.
- Signature HMAC des webhooks Meta vérifiée quand le secret est configuré.
- Écritures JSON atomiques, garde-fou d'espace disque, rétention de 15 jours.
- Uploads filtrés par type MIME, noms de fichiers générés côté serveur.
- Échappement HTML systématique dans l'interface (`escapeHtml`, ~170 usages).
- Gestion des rôles détaillée, avec contrôle par conversation et par canal.

**Faiblesses principales :** quelques routes de diagnostic publiques, des failles XSS dans les `onclick`, aucun délai maximal sur les appels IA, des traitements concurrents pour un même client, des données personnelles dans les logs, aucun arrêt propre et l'absence de CI.

## 2. Corrections apportées dans cette version

### Sécurité
| # | Problème | Correction |
| --- | --- | --- |
| S1 | `/test-ia` était **public** : n'importe qui pouvait consommer le quota IA payant. `/debug-env` exposait la configuration. | Ces routes, ainsi que `/debug-log` et `/reset-test-history`, sont réservées aux administrateurs connectés (`requireAdmin`). |
| S2 | XSS dans l'interface : `escapeHtml()` ne protège pas une valeur placée dans un `onclick="f('…')"`, car le navigateur décode les entités avant d'exécuter le code. Un nom de fichier envoyé par un client (`x');alert(document.cookie);//`) s'exécutait dans la session du commercial. | Nouvelle fonction `jsArg()` (JSON.stringify puis échappement HTML), appliquée à la cinquantaine de gestionnaires concernés. |
| S3 | Le nom d'un commercial était inséré sans échappement dans les bulles de message. | Le nom est désormais échappé. |
| S4 | Les liens de publications n'étaient pas filtrés : un lien `javascript:` passait. | `safeHttpUrl()` n'accepte que les liens http(s). |
| S5 | La limite de tentatives de connexion était contournable : la clé reposait sur `X-Forwarded-For`, fourni par le client. | Clé sur `req.ip` (`trust proxy` configuré), limite supplémentaire par e-mail, purge périodique des compteurs, temps de réponse constant pour un e-mail inconnu. |
| S6 | Mot de passe administrateur par défaut (`mondeco2026`) utilisé en production si `ADMIN_PASSWORD` était absent. | En production, aucun compte n'est créé ni réinitialisé sans `ADMIN_PASSWORD` explicite, et un avertissement s'affiche si le mot de passe fait moins de 12 caractères. |
| S7 | Webhook : la vérification passait avec un token vide si `VERIFY_TOKEN` n'était pas défini. | Elle est refusée tant que `VERIFY_TOKEN` n'est pas configuré. |
| S8 | Clé Gemini passée dans l'URL (risque de fuite dans les logs). | Elle est transmise dans l'en-tête `x-goog-api-key`. |
| S9 | Aucun en-tête de sécurité. | Ajout de `nosniff`, `X-Frame-Options`, `frame-ancestors`, `Referrer-Policy`, HSTS ; `x-powered-by` est retiré. |
| S10 | Identifiant de sauvegarde à restaurer peu validé. | Format strict exigé `[A-Za-z0-9_-]`. |
| S11 | 4 vulnérabilités npm, dont 1 critique (`proxy-addr`). | `npm audit fix` : 0 vulnérabilité. |

### Fiabilité
| # | Problème | Correction |
| --- | --- | --- |
| F1 | Appels Gemini et Groq sans délai maximal : un appel bloqué figeait la conversation et le secours Groq ne se déclenchait jamais. | Délai de 25 s par appel (`AI_REQUEST_TIMEOUT_MS`) ; au-delà, l'appel est abandonné et le secours Groq prend le relais. |
| F2 | Deux messages rapprochés d'un même client étaient traités en parallèle : historique entremêlé, double réponse IA, état écrasé. | File d'attente par conversation (WhatsApp, Instagram, Facebook). Les conversations différentes restent traitées en parallèle. |
| F3 | Aucun arrêt propre : chaque redéploiement Railway coupait les traitements en cours, alors que ces messages étaient déjà acquittés et donc perdus. | Gestion de `SIGTERM`/`SIGINT` : le serveur cesse d'accepter des connexions et attend la fin des traitements (`SHUTDOWN_GRACE_MS`). |
| F4 | Un `users.json` corrompu était lu comme une liste vide, puis réécrit : **tous les comptes étaient effacés**. | Le fichier est restauré depuis `users.json.bak` ; si les deux sont illisibles, toute écriture est bloquée. |
| F5 | L'historique IA en mémoire grossissait sans limite (une entrée par client). | Purge après 48 h d'inactivité. |
| F6 | Le paquet `compression` était utilisé mais absent de `package.json` (gzip désactivé en production). | Ajouté aux dépendances. |

### Confidentialité
- Les numéros de téléphone sont masqués dans les logs (`***3456`).
- Le texte des messages clients et des réponses IA n'est plus écrit dans les logs Railway. `LOG_MESSAGE_CONTENT=true` le réactive temporairement.

### Interface
- Les rafraîchissements toutes les 5 s (SLA, conversation ouverte) sont suspendus quand l'onglet est masqué. Les notifications continuent, pour ne pas manquer de client.
- Libellés `aria-label` ajoutés sur les boutons de fermeture.

### Industrialisation
- `npm test` vérifie la syntaxe des trois fichiers, y compris les scripts inline d'Admin.html, puis lance tous les tests.
- CI GitHub Actions : tests et `npm audit` à chaque push.
- Ajout de `.env.example` (toutes les variables, documentées), d'un `README.md` et de cette étude.

## 3. Feuille de route recommandée

### Priorité 1 — ✅ réalisée en V6.37.0
| # | Point | Réalisation |
| --- | --- | --- |
| 1 | Signature des webhooks | Option `WEBHOOK_SIGNATURE_REQUIRED=true` : tout webhook non signé est refusé (401). **Action requise** : renseigner `META_APP_SECRET` dans Railway, puis activer l'option. |
| 2 | Coûts IA | Quota par client (30 réponses IA par heure par défaut) et plafond quotidien global (5 000 appels). Au-delà, la conversation passe au commercial par le transfert habituel, sans appel IA. La consommation est visible dans `/debug-env`. |
| 3 | Messages perdus | Un message dont le traitement plante est rejoué automatiquement (après 15 s, puis 60 s). Un message déjà journalisé, donc déjà répondu, n'est jamais rejoué, ce qui évite les doubles réponses. |
| 4 | Appels Meta | Les lectures (médias, profils, métadonnées) ont un délai maximal par tentative et sont reprises sur erreur réseau, 429 et 5xx, en respectant `Retry-After`. Les envois ont un délai maximal, sans reprise. La taille des médias est plafonnée pendant le téléchargement, y compris quand `content-length` est absent. |
| 5 | Sessions | Déconnexion après 12 h d'inactivité (`MONDECO_SESSION_IDLE_HOURS`). Un changement de rôle ou d'e-mail déconnecte le compte concerné. |
| 6 | Injection de prompt | Les champs publicitaires (dont `ref`, que n'importe qui peut écrire dans un lien) sont mis sur une ligne, débarrassés des séparateurs, encadrés et plafonnés. Une règle explicite indique que les messages client sont des données, pas des consignes. Le marqueur `[COMMERCIAL_REQUIRED]` est conservé tel quel : il oriente toujours vers un humain, c'est le sens sûr. |

### Priorité 2 — ✅ réalisée en V6.38.0 (avec un choix d'architecture expliqué ci-dessous)
| # | Point | Réalisation |
| --- | --- | --- |
| 7 | Stockage bloquant | **Magasin partagé à écriture groupée** (`lib/json-object-store.js`). `conversation-state.json` (15 Mo+) était réécrit en entier, de façon bloquante, plusieurs fois par message, et server.js et Admin.js en gardaient chacun leur propre copie. Il n'y a plus qu'un exemplaire en mémoire, écrit sur disque au plus toutes les 5 s. Le magasin est vidé à l'arrêt, avant chaque sauvegarde et chaque export, et rechargé après une restauration ; il n'écrase jamais un fichier illisible. Le journal `conversation-log.json` n'est plus relu ni re-parsé à chaque message. |
| 8 | Historique IA | Conservé dans `ai-history.json` : il survit aux redéploiements et est purgé après 48 h sans message. |
| 9 | Découpage | Premiers modules dans `lib/`, testés directement : réseau (`http.js`), file par conversation et reprise (`conversation-queue.js`), quotas IA (`ai-quota.js`), confidentialité (`log-privacy.js`), prompt (`prompt-safety.js`), logs (`logger.js`) et stockage (`json-object-store.js`). |
| 10 | Logs et alertes | Identifiant de corrélation par requête (en-tête `X-Request-Id`), propagé à tous les logs du traitement, y compris les reprises. `LOG_FORMAT=json` produit une ligne JSON par log. `ALERT_WEBHOOK_URL` (Slack, Discord, Google Chat, Teams) reçoit les erreurs regroupées, au plus une alerte toutes les 10 min. Ce module maison remplace pino : aucune dépendance supplémentaire et les plus de 300 appels `console.*` existants n'ont pas à être modifiés. |
| 11 | Interface | Les 43 `confirm()`/`prompt()` natifs sont remplacés par des boîtes de dialogue intégrées (clavier : Échap/Entrée/Tab, adaptées au mobile, rouge pour les actions destructrices). La liste des commentaires n'est plus reconstruite toutes les 5 s : seule l'heure est mise à jour. |

**Pourquoi pas encore SQLite.** Les fichiers JSON sont utilisés par une quarantaine de fonctions : sauvegardes et snapshots, restauration, export, rétention de 15 jours, purge définitive, synchronisations Meta et sauvetage d'espace disque. Une bascule vers SQLite demande de toutes les réécrire, sans pouvoir les tester sur les vraies données de production, ce qui est risqué pour un outil en service. Le magasin partagé apporte dès maintenant le gain principal (plus de réécriture bloquante de 15 Mo à chaque message) sans changer le format des fichiers. Il est aussi le point d'entrée unique où brancher SQLite plus tard : seul `lib/json-object-store.js` serait à remplacer pour l'état des conversations.

**Reste à faire, issu de la priorité 2 :**
- Remplacer les `onclick` inline par des écouteurs délégués (`data-*`) pour permettre une CSP stricte. La faille XSS correspondante est déjà corrigée par `jsArg()`.
- Poursuivre le découpage (`channels/`, `routes/`).
- Migrer vers SQLite après une copie des données de production pour tester.

### Priorité 3 — évolution produit
12. **Tableau de bord KPI** : temps de première réponse, taux de résolution par l'IA, conversions vers un showroom, satisfaction.
13. **Messages modèles WhatsApp (templates)** pour relancer au-delà de la fenêtre de 24 h, avec suivi des commandes et des livraisons.
14. **Évaluation de la qualité IA** : jeu de questions de référence (prix, livraison, showrooms) rejoué à chaque changement de prompt ou de modèle.
15. **Accessibilité** : tailles de police d'au moins 11 px (environ 40 styles sont entre 7 et 8,5 px), focus visible, cartes de commentaires utilisables au clavier.

## 4. Variables à vérifier dans Railway après déploiement

- `ADMIN_EMAIL` et `ADMIN_PASSWORD` sont **obligatoires** : sans eux, aucun compte administrateur n'est créé ni réinitialisé (les comptes existants ne changent pas).
- `VERIFY_TOKEN` : sans lui, la vérification du webhook Meta est refusée.
- `META_APP_SECRET` (ou les secrets par canal) : fortement recommandé, puis `WEBHOOK_SIGNATURE_REQUIRED=true`.
- `AI_MAX_REPLIES_PER_CONTACT_PER_HOUR` / `AI_MAX_CALLS_PER_DAY` : à ajuster selon le volume réel (consultable dans `/debug-env` → `ai_quota`).
- `/debug-env` demande désormais une connexion administrateur dans le navigateur.
