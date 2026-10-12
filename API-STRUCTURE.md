MERCADO — STRUCTURE DES API ET CHECKLIST DE VALIDATION
=====================================================

1) BASE URL
-----------
Production: https://mercado-portal-6.onrender.com
Toutes les routes /api/* sont servies par le même serveur Express.
Le site public se trouve dans public/index.html.

2) CATALOGUE CJ DROPSHIPPING
----------------------------
GET /api/health
  Réponse: { ok, service, time }

GET /api/catalog/home?cat=All&limit=60
  Réponse: { ok: true, items: [...] }
  Options: cat, limit (1–200)

GET /api/catalog/search?q=nike&cat=All&limit=60&page=1
  Réponse: { ok: true, items: [...] }
  Options: q (max 100 caractères), cat, limit (1–100), page.
  La recherche étend certains mots-clés (Nike/Jordan/chaussures), mais les produits doivent réellement être présents et accessibles dans CJ.

GET /api/catalog/cj/home?cat=All&limit=60
GET /api/catalog/cj/search?q=shoes&cat=All&limit=60&page=1
GET /api/catalog/item?itemId=ID_CJ
GET /api/catalog/cj/product/ID_CJ
GET /api/catalog/cj/variants/ID_CJ
GET /api/catalog/cj/stock/ID_CJ
GET /api/rates

Authentification fournisseur côté serveur:
  POST https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken
  JSON: { "apiKey": "..." }
  Les requêtes catalogue utilisent l'en-tête CJ-Access-Token.
  Garder CJ_API_KEY/CJ_ACCESS_TOKEN dans Render Environment, jamais dans index.html.

3) EMAIL — RESEND
-----------------
POST /api/email/send
  JSON: { "email": "client@example.com" }
  Succès: { ok: true, accepted: true, id, message }
  Erreur: 400 adresse invalide; 503 clé absente; 502 Resend refuse le message.
  Un code à 4 chiffres est généré, valable 10 minutes.

POST /api/email/verify
  JSON: { "email": "client@example.com", "code": "1234" }
  Succès: { ok: true, verified: true }
  Erreur: 400 code invalide ou expiré.

GET /api/admin/test-resend?to=client@example.com
GET /api/admin/test-email?to=client@example.com
GET /api/admin/diagnostics
  Authentification admin requise: en-tête x-admin-key: <ADMIN_KEY>.
  Pour tester dans un navigateur, le code accepte aussi ?key=... mais il est préférable d'utiliser l'en-tête et de ne jamais partager le secret.

Variables Render requises pour e-mail:
  RESEND_API_KEY = clé API Resend réelle
  RESEND_FROM = MERCADO <adresse@votre-domaine-verifie.com>
  ADMIN_KEY = secret long aléatoire pour les routes admin

IMPORTANT: onboarding@resend.dev est un expéditeur de test. Une réponse HTTP réussie signifie que Resend a accepté l'envoi, pas que le destinataire l'a reçu. Vérifier Resend > Emails pour Delivered/Bounced. Pour les clients, vérifier un domaine et configurer RESEND_FROM sur ce domaine.

4) COMMANDES ET PAIEMENT
------------------------
POST /api/order
  JSON attendu: { orderId, items: [{ id, qty, name? }], customer, paymentMethod, note? }
  Le serveur récupère les prix actuels côté CJ et recalcule le total.

POST /api/payment/camerpay
POST /api/payment/flutterwave
  Alias de compatibilité vers le gestionnaire CamerPay dans cette version; la route nommée flutterwave ne constitue PAS une intégration Flutterwave réelle.

POST /api/payment/camerpay/webhook
GET /api/payment/camerpay/status?id=ID
GET /api/admin/test-camerpay

Ne pas activer les paiements réels sans confirmer les URL/format exacts avec CamerPay et vérifier le webhook.

5) AUTRES ROUTES
----------------
POST /api/notify/subscribe        inscription aux alertes de recherche
GET  /api/reviews?itemId=ID       lecture des avis
POST /api/reviews                 création d'un avis
POST /api/track-view              suivi d'un produit consulté
POST /api/translate               traduction (DEEPL_API_KEY requis)
POST /api/ai                      assistant IA (clé fournisseur requise)
POST /api/ai-log                  journal léger
GET  /api/admin/cj/status         état CJ (admin)
GET  /api/admin/cj/raw?q=nike     réponse brute CJ (admin)
GET  /api/admin/test-telegram     test Telegram (admin)

6) VALIDATIONS STATIQUES EFFECTUÉES SUR CE ZIP
----------------------------------------------
- Vérification de l'intégrité ZIP (unzip -t).
- node --check server.js.
- Extraction du JavaScript intégré à public/index.html et node --check.
- Vérification des routes listées dans server.js.
- Vérification que le HTML contient exactement deux slides et deux points de navigation de bannière.
- Vérification des noms de fichiers requis: server.js, public/index.html, package.json, .env.example.

Ces contrôles ne peuvent pas confirmer les clés privées, la livraison réelle des e-mails, les droits du compte CJ ou la disponibilité de produits spécifiques. Ces points nécessitent des tests en direct sur Render avec les variables d'environnement configurées.

## Notifications de progression (mise à jour)
- `POST /api/progress` : enregistre les étapes client (informations de livraison saisies, paiement commencé, redirection, demande conservée si paiement indisponible) dans `data/notifications.json` et tente d'envoyer une notification Telegram.
- `GET /api/admin/notifications?limit=100` : consulte l'historique, protégé par `ADMIN_KEY` via l'en-tête `x-admin-key` ou le paramètre `key`.
- La création de commande et la confirmation réelle du paiement sont également enregistrées dans cet historique.
- La vérification de code par e-mail a été retirée du parcours d'achat. L'adresse e-mail reste un champ de contact facultatif ; Resend n'est plus requis pour continuer la commande.

**Persistance Render :** les fichiers JSON ne survivent aux redémarrages/redéploiements que si le service utilise un disque persistant et que `DATA_DIR` pointe vers son chemin de montage. Sinon, configurez le disque persistant dans Render pour conserver durablement l'historique.
