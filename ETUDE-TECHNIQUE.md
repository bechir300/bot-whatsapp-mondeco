# Étude technique — MONDECO V6.37.0 (version VPS intégrée)

## 0. Intégration avec la version de production du VPS

L'audit initial (sections 1 à 4 ci-dessous) a été réalisé sur le code de GitHub `main`. Or la version **réellement en service** sur le VPS (`/opt/mondeco`, V6.36.102) contenait environ un mois de travail fait directement sur le serveur et jamais publié. Cette version 6.37.0 **part du code du VPS** (branche `vps-production`) et y reporte les améliorations de l'audit.

**Conservé tel quel depuis le VPS** (déjà traité, d'une autre façon) :
- cache partagé et écriture différée de `conversation-state.json` et `conversation-log.json`, accès par conversation via SQLite (`mondeco.db`). La couche de stockage proposée dans l'audit (section 2, priorité 2) **n'est pas reprise** ;
- fenêtre WhatsApp de 24 h : blocage des messages libres hors fenêtre et relance par modèle approuvé (`WHATSAPP_REENGAGEMENT_TEMPLATE_NAME`). Le système de modèles multiples de l'audit (priorité 3, point 13) **n'est pas repris** ;
- budget IA mensuel (100 $) et plage horaire IA (18 h–10 h). L'audit ajoute seulement un quota par client et un plafond quotidien optionnel, désactivé par défaut.

**Ajouté à la version du VPS :**
- **Sécurité :**
  - routes de diagnostic réservées aux admins (`/debug-env` était public sur le serveur) ;
  - XSS des gestionnaires `onclick` (51) ;
  - limite de connexion non contournable ;
  - plus de mot de passe par défaut hors `NODE_ENV=development` ;
  - protection de `users.json` ;
  - sessions inactives ;
  - en-têtes HTTP ;
  - signature des webhooks obligatoire (option) ;
  - 0 vulnérabilité npm (`multer`, `proxy-addr`, `qs` mis à jour).
- **Fiabilité :**
  - délai maximal des appels IA et Meta ;
  - file par conversation ;
  - reprise des messages en échec ;
  - historique IA persistant ;
  - **arrêt propre**. Les écouteurs `SIGTERM` existants enregistraient les fichiers mais empêchaient Node de s'arrêter : à chaque redémarrage, le gestionnaire de processus devait attendre puis tuer l'application de force.
- **Confidentialité** : 22 logs ne contiennent plus de numéros ni de textes de messages.
- **Pilotage :**
  - page Indicateurs ;
  - évaluation de la qualité IA (elle fonctionne aussi hors plage horaire IA, le budget restant appliqué) ;
  - boîtes de dialogue intégrées (47 `confirm`/`prompt` remplacés) ;
  - accessibilité (195 tailles de police relevées à 11 px, focus clavier).
- **Industrialisation** : `npm test`, CI GitHub, `.env.example`, `.gitignore` couvrant les données présentes dans le dossier de l'application.

**Performance (V6.37.2 et V6.37.3), mesurée sur les données de production :**

Mesures de départ en production :
- `conversation-state.json` faisait 135 Mo pour 38 435 conversations, dont 92,5 Mo de données publicitaires recopiées ;
- chaque enregistrement réécrivait le fichier **et** les 38 435 lignes SQLite ;
- la boîte de réception relisait environ 186 Mo d'événements toutes les 5 minutes (54 600 événements, jusqu'à 2 Go de mémoire).

Corrections :
1. `adReferral` allégé (`raw` jamais relu, lien Meta expiré quand l'image est copiée localement) : 135,7 → 77,2 Mo en production.
2. SQLite : seules les conversations modifiées sont réécrites ; la resynchronisation complète se fait une fois après le démarrage, en arrière-plan, par lots.
3. Fichier JSON d'état : réécrit au plus une fois par minute (SQLite reçoit chaque modification avant), toujours à l'arrêt, avant un snapshot ou un export ; au démarrage, les conversations plus récentes dans SQLite sont reprises. Vérifié avec un arrêt brutal (`kill -9`) : aucune perte.
4. Boîte de réception incrémentale : une copie par source en mémoire, seules les nouvelles lignes des fichiers d'événements sont lues ; les historiques Instagram/Facebook et le journal ne sont relus que s'ils ont changé (au plus toutes les 5 minutes). Résultat vérifié identique à l'ancienne fusion complète (liste et détails) ; mise à jour avec 25 nouveaux messages en 0,34 s au lieu d'environ 2 s.

Banc d'essai (38 435 conversations, trafic simulé), pire blocage du serveur : 2,77 s avec la version d'origine, 1,03 s en V6.37.2, **0,06 s en V6.37.3**.

**Recommandations propres au VPS :**
1. **Ne plus modifier le code directement sur le serveur.** Modifier sur GitHub (ou en local), puis `git pull` sur le VPS. Les ~90 fichiers `*.BACKUP-*` du dossier montrent que l'historique des modifications n'existait que sous forme de copies : git le fait mieux, et ils sont désormais ignorés.
2. **Séparer les données du code** : définir `DATA_DIR=/opt/mondeco/data` et y déplacer les fichiers de données et `mondeco.db`, application arrêtée. Une mise à jour du code ne risque alors plus d'écraser des données.
3. Lancer l'application avec un **utilisateur dédié** (pas root), via systemd ou pm2, derrière Nginx en HTTPS.
4. Appliquer les mises à jour de sécurité d'Ubuntu (92 en attente, dont 21 de sécurité) : `apt update && apt upgrade`, puis redémarrer en dehors des heures d'affluence.
5. Définir `ADMIN_PASSWORD` (12 caractères minimum) et `META_APP_SECRET`, puis `WEBHOOK_SIGNATURE_REQUIRED=true`.

_Note : les numéros de version 6.36 à 6.39 cités dans les sections suivantes sont ceux de la branche d'audit. Dans cette version, tout ce qui a été repris est regroupé en 6.37.0._

---

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

### Priorité 3 — ✅ réalisée en V6.39.0
| # | Point | Réalisation |
| --- | --- | --- |
| 12 | Tableau de bord KPI | Nouvelle page **Indicateurs** (administrateur et responsable commercial) : conversations, part réglée par l'IA, délai de première réponse (moyenne et P90), délai de réponse commerciale, conversations restées sans réponse, intentions showroom et prix, conversations issues de publicités, répartition par canal et motifs de transfert. Période de 7 à 90 jours, graphique avec infobulles (souris et clavier) et tableau par jour. Chaque journée terminée est figée dans `kpi-daily.json` (chiffres seulement, aucune donnée client) avant la purge des journaux. Les délais de réponse de l'IA sont mesurés à partir de cette version (`incoming_at`). |
| 13 | Messages modèles WhatsApp | **Échecs de remise visibles** : hors fenêtre de 24 h, Meta accepte un message libre puis le rejette plus tard (statut `failed`, code 131047). Ce statut était ignoré et le commercial croyait avoir répondu ; il est désormais affiché dans la conversation. Un bandeau prévient dès que la fenêtre est fermée. Les modèles approuvés s'envoient depuis la conversation (choix du modèle, variables, aperçu), avec les mêmes contrôles d'accès que les réponses habituelles. Il faut renseigner `WHATSAPP_BUSINESS_ACCOUNT_ID`. |
| 14 | Évaluation de la qualité IA | Section dans **Discussion de test**. L'évaluation rejoue les questions de `evals/ai-reference-questions.json` (modifiables) et 3 questions de prix tirées du catalogue, puis vérifie : réponse ou transfert attendu, éléments obligatoires, éléments interdits (prix inventé, remise accordée sous manipulation, fuite des instructions). Elle donne un score, conserve l'historique des 20 derniers passages et signale quand les instructions, le catalogue ou le modèle ont changé depuis le dernier passage. |
| 15 | Accessibilité | 194 tailles de police sous 11 px (jusqu'à 7 px) passées à 11 px, sans débordement constaté sur ordinateur ni sur mobile. Contour de focus visible pour la navigation au clavier, cartes de commentaires activables avec Entrée/Espace, boîtes de dialogue utilisables au clavier. |

**Non réalisé, à décider :**
- **Satisfaction client (CSAT)** : aucune donnée n'existe aujourd'hui. Il faudrait envoyer automatiquement une question aux clients (par exemple après la clôture d'une conversation). C'est un message sortant de plus, qui doit utiliser un modèle approuvé hors fenêtre de 24 h : à valider avant de l'activer.
- **Suivi automatique des commandes et livraisons** : il faut l'accès aux commandes WooCommerce (API orders) et un modèle « suivi de commande » approuvé. Les modèles peuvent déjà servir à l'envoyer à la main.
- **Conversions showroom réelles** : seule l'intention est mesurée. Une visite confirmée demande une saisie en showroom, ou un code promo/rendez-vous à rapprocher.
- Les 115 `alert()` natifs restants : les rendre non bloquants changerait l'ordre d'exécution du code qui les suit, il faut les migrer un par un.

## 4. Variables à vérifier dans Railway après déploiement

- `ADMIN_EMAIL` et `ADMIN_PASSWORD` sont **obligatoires** : sans eux, aucun compte administrateur n'est créé ni réinitialisé (les comptes existants ne changent pas).
- `VERIFY_TOKEN` : sans lui, la vérification du webhook Meta est refusée.
- `META_APP_SECRET` (ou les secrets par canal) : fortement recommandé, puis `WEBHOOK_SIGNATURE_REQUIRED=true`.
- `AI_MAX_REPLIES_PER_CONTACT_PER_HOUR` / `AI_MAX_CALLS_PER_DAY` : à ajuster selon le volume réel (consultable dans `/debug-env` → `ai_quota`).
- `/debug-env` demande désormais une connexion administrateur dans le navigateur.
