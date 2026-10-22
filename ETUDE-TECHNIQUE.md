# Étude technique — MONDECO V6.36.0

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

### Priorité 1 — dans le mois
1. **Configurer `META_APP_SECRET` dans Railway.** Sans lui, n'importe qui peut envoyer de faux webhooks, donc de faux messages clients. Ensuite, rendre la signature obligatoire.
2. **Limiter les coûts IA par client** : quota par contact (par exemple 30 messages par heure) et plafond quotidien global avec transfert à un commercial au-delà.
3. **Webhook : marquer un message comme traité seulement après succès.** Aujourd'hui, l'identifiant est enregistré avant le traitement : un crash fait perdre le message, car la nouvelle tentative de Meta est ignorée.
4. **Délais maximaux sur les appels Meta en lecture** (téléchargement de médias, profils), avec nouvelle tentative sur 429/5xx en respectant `Retry-After`, et contrôle de taille sur `downloadWhatsAppMedia`.
5. **Sessions** : expiration après 12 h d'inactivité et révocation lors d'un changement de rôle.
6. **Protection contre l'injection de prompt** : encadrer les textes publicitaires et client dans des blocs de données délimités, et n'accepter le marqueur `[COMMERCIAL_REQUIRED]` que s'il est exact.

### Priorité 2 — dans le trimestre
7. **Passer à SQLite** (better-sqlite3) pour les conversations, les états et les notifications. Les fichiers JSON sont relus et réécrits entièrement de façon synchrone à chaque message (plus de 15 Mo pour l'état des conversations), ce qui bloque le serveur sous charge. SQLite apporte des transactions, des index et la suppression de ces blocages, sans nouveau service à héberger.
8. **Historique IA persistant**, reconstruit depuis `conversation-events` : il est aujourd'hui perdu à chaque redémarrage.
9. **Découper les fichiers monolithiques** en modules (`channels/whatsapp.js`, `channels/instagram.js`, `ai/`, `storage/`, `routes/`), en commençant par les fonctions pures, qu'on peut tester.
10. **Logs structurés** (pino) avec niveaux, identifiant de corrélation par message et alertes (par exemple Better Stack ou Sentry) sur les erreurs d'envoi et le taux de secours IA.
11. **Interface** : remplacer les `onclick` inline par des écouteurs délégués (`data-*`), ce qui permet ensuite une CSP stricte ; ne mettre à jour que les badges SLA au lieu de reconstruire toute la liste des commentaires ; remplacer `confirm()`/`prompt()` par des modales.

### Priorité 3 — évolution produit
12. **Tableau de bord KPI** : temps de première réponse, taux de résolution par l'IA, conversions vers un showroom, satisfaction.
13. **Messages modèles WhatsApp (templates)** pour relancer au-delà de la fenêtre de 24 h, avec suivi des commandes et des livraisons.
14. **Évaluation de la qualité IA** : jeu de questions de référence (prix, livraison, showrooms) rejoué à chaque changement de prompt ou de modèle.
15. **Accessibilité** : tailles de police d'au moins 11 px (environ 40 styles sont entre 7 et 8,5 px), focus visible, cartes de commentaires utilisables au clavier.

## 4. Variables à vérifier dans Railway après déploiement

- `ADMIN_EMAIL` et `ADMIN_PASSWORD` sont **obligatoires** : sans eux, aucun compte administrateur n'est créé ni réinitialisé (les comptes existants ne changent pas).
- `VERIFY_TOKEN` : sans lui, la vérification du webhook Meta est refusée.
- `META_APP_SECRET` (ou les secrets par canal) : fortement recommandé.
- `/debug-env` demande désormais une connexion administrateur dans le navigateur.
