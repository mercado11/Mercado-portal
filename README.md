# MERCADO — CJ Dropshipping + CamerPay (mode test)

## 1. Fichiers a mettre sur GitHub
```
mercado-backend/
├── server.js
├── package.json
├── .gitignore
├── .env.example      (modele : NE PAS y mettre de vraies cles)
├── README.md
└── public/
    └── index.html    (le site, deja modifie : rien d'autre a changer)
```
Important : `index.html` doit etre dans le dossier `public/`.

## 2. Render
- New > Web Service > votre depot GitHub
- Build Command : `npm install`   |   Start Command : `node server.js`
- Environment : copier les variables de `.env.example`.
  Minimum pour demarrer : PUBLIC_BASE_URL, CJ_API_KEY, USD_EUR_RATE,
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RESEND_API_KEY.
- `CAMERPAY_TOKEN` vide = le site affiche "paiement bientot disponible".
  Token de TEST + `CAMERPAY_MODE=test` = paiements de test.
- Sans "Disk" Render (payant), le dossier `data/` (commandes, avis) est efface
  a chaque redemarrage. Pour le live : Disk monte sur /opt/render/project/src/data.

## 3. Regles du catalogue
- Produits : CJ Dropshipping. Accueil et categories : les MOINS CHERS d'abord.
- Au moins 20 produits par categorie (MIN_PRODUCTS_PER_CATEGORY).
- Prix affiche = (prix CJ en USD + 5 $) x USD_EUR_RATE  (PRICE_MARKUP_USD=5).
- Le prix paye est recalcule par le serveur (jamais pris du navigateur).
- CJ limite a ~1 requete/seconde : 1re ouverture lente (5-10 s), puis cache 10 min.

## 4. Attention : emails (Resend)
Avec l'expediteur de test `onboarding@resend.dev`, Resend n'envoie qu'a l'adresse
email de VOTRE compte Resend. Pour tester avec d'autres emails, verifiez un domaine
dans Resend et changez RESEND_FROM. Sans RESEND_API_KEY, le code de verification
s'affiche dans les logs Render ("[TEST] code pour ...").

## 5. Tests (dans cet ordre)
1. `https://VOTRE-SERVICE.onrender.com/api/health` -> {"ok":true}
2. Ouvrir le site : produits CJ, moins chers en premier. Tester 2-3 categories.
3. Ouvrir un produit : image, prix, description (s'affiche apres 1-2 s).
4. Verifier un prix : (prix CJ + 5 $) x taux.
5. Commander : email (code) > telephone > adresse > Payer.
   - sans CAMERPAY_TOKEN : message "bientot disponible" (normal)
   - avec le token de test : redirection vers la page CamerPay
6. Telegram recoit "🧪 TEST (ne pas commander chez CJ)" + produit + pid CJ + lien.
7. Payer en test : Telegram "PAYE" + email au client (webhook).
   Si absent : logs Render ("webhook:", "CamerPay:").
8. Au retour du paiement, le site affiche "Paiement recu — merci !".

## 6. A verifier avec la documentation CamerPay (je n'y ai pas acces)
- CAMERPAY_BASE_URL, CAMERPAY_INITIATE_PATH, CAMERPAY_STATUS_PATH (valeurs par defaut = suppositions)
- Si leur mode test utilise une autre adresse d'API, la mettre dans CAMERPAY_BASE_URL
- Webhook a declarer chez CamerPay : PUBLIC_BASE_URL + /api/payment/camerpay/webhook

## 7. Passage en LIVE
- CAMERPAY_TOKEN = token de production, CAMERPAY_MODE=live, KYC termine
- Disk Render actif, ADMIN_KEY change
- Faire une vraie commande de bout en bout, puis la commander vous-meme chez CJ
- Delais : CJ livre souvent en 7 a 20 jours. Adaptez les promesses du site
  ("livraison estimee 6-11 jours", "livraison gratuite", "retour 15 jours").
