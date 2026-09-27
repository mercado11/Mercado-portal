# MERCADO — Tout-en-un (GitHub + Render, sans Netlify)

Un seul dépôt GitHub, un seul service Render : ce serveur sert à la fois
le site (`public/index.html`) ET toutes les fonctions (emails, Telegram,
eBay, paiement). Structure du dépôt :

```
mercado-backend/
├── server.js
├── package.json
├── .env.example
├── public/
│   └── index.html      ← le site (mercado.html renommé)
└── data/
    └── products.json
```

## 1. Déployer sur Render

1. Mettez **tout ce dossier** (`mercado-backend/`, avec `public/`
   dedans) dans un dépôt GitHub.
2. Sur [render.com](https://render.com) → **New +** → **Web Service**.
3. Connectez le dépôt.
4. Build Command : `npm install`
5. Start Command : `npm start`
6. Dans l'onglet **Environment**, ajoutez toutes les variables de
   `.env.example` avec vos vraies valeurs (jamais dans le code) :
   - `RESEND_API_KEY`, `RESEND_FROM` → codes de vérification + emails
     "vous avez récemment consulté ce produit"
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` → recevoir les commandes
     avec le lien eBay caché au client
   - `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` → catalogue de produits
   - `PRICE_MARKUP` → marge ajoutée sur chaque prix (6 par défaut)
   - `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_CURRENCY`, `FLW_SECRET_HASH`
     → paiement par carte / Apple Pay / Google Pay / Mobile Money
   - `ADMIN_KEY` → clé pour déclencher les emails "produit disponible"
7. Déployez. Render vous donne une URL du type
   `https://mercado-xxxx.onrender.com` — **c'est directement l'adresse
   de votre site**, pas besoin de Netlify.

## 2. Le site se connecte automatiquement à lui-même

Comme le site et l'API tournent sur le même service Render, vous
n'avez **rien à configurer** dans le navigateur — contrairement à
avant. Si vous préférez quand même forcer l'adresse manuellement :

```js
localStorage.setItem('mercado_api_base', 'https://mercado-backend-xxxx.onrender.com');
```

Tous les autres endpoints (`email/send`, `email/verify`, `order`,
`payment/flutterwave`, `notify/subscribe`) sont déjà
déduits automatiquement de cette seule adresse — rien d'autre à
configurer, et **le code de `mercado.html` n'a pas besoin d'être
modifié davantage**.

## 3. Nouveautés : IA générale, langue et catalogue selon le pays

- **MERCADO AI** répond maintenant à deux types de questions : sur un
  produit / une commande MERCADO, **et** n'importe quelle question
  générale (comme un assistant classique). Ajoutez `ANTHROPIC_API_KEY`
  dans Render pour l'activer — sans elle, l'IA répond une seule fois
  qu'elle n'est pas configurée, sans se répéter en boucle.
- **La langue de l'interface change réellement** avec le sélecteur de
  langue (ou automatiquement selon le pays choisi) : français,
  anglais, espagnol, allemand, italien, portugais sont traduits
  immédiatement (dictionnaire intégré au site). Pour les autres
  langues du menu (néerlandais, polonais, japonais, chinois, coréen,
  arabe, russe), ajoutez `DEEPL_API_KEY` **ou**
  `GOOGLE_TRANSLATE_API_KEY` : le site traduira automatiquement via
  `/api/translate` et gardera le résultat en cache.
- **Le catalogue change de produits selon le pays** : si vous
  renseignez `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`
  (developer.ebay.com), le site interroge la marketplace eBay
  correspondant au pays choisi (EBAY_FR, EBAY_DE, EBAY_US, etc.),
  donc des produits réels et dans la bonne langue/devise. Sans ces
  clés, le catalogue de démonstration `data/products.json` est utilisé
  partout.

## 4. Ce que fait chaque flux

- **Email + code de vérification** : `mercado.html` appelle déjà
  `/api/email/send` puis `/api/email/verify` avant de débloquer
  l'adresse de livraison — c'est exactement ce que ce serveur fournit.
  Le code envoyé fait **4 chiffres** et expire après 10 minutes.
  L'envoi utilise **Resend** si `RESEND_API_KEY` est défini (le plus
  simple), sinon un SMTP classique si `SMTP_*` est défini à la place.
- **Commande** : au clic sur « Payer maintenant », le site envoie la
  commande (produit, description, photo, lien source eBay, coordonnées
  client complètes — nom, email, téléphone, adresse, ville, code
  postal, pays) à `/api/order`. Le lien source **n'est jamais affiché
  sur le site** : il ne sert qu'à composer le message envoyé
  automatiquement à l'administrateur — **Telegram** en priorité
  (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`), puis Facebook Messenger,
  puis WhatsApp (Twilio) si les précédents ne sont pas configurés.
- **Questions posées à MERCADO AI** : le client ne voit jamais si une
  vraie IA générale est connectée ou non — l'assistant répond toujours
  du mieux qu'il peut. En coulisses, chaque question posée en mode
  local (sans `ANTHROPIC_API_KEY`) est silencieusement enregistrée
  dans `data/ai-questions.json` et vous est notifiée sur le même canal
  que les commandes (Messenger ou WhatsApp), pour que vous sachiez ce
  que demandent vos clients.
- **Carte bancaire (Flutterwave)** : si le client choisit « Carte
  bancaire », le site crée une session Flutterwave via
  `/api/payment/flutterwave` puis redirige automatiquement le client
  vers la page de paiement sécurisée (carte, Apple Pay, Google Pay,
  Mobile Money selon l'appareil et le pays du client). L'argent est
  réglé sur le compte Flutterwave du titulaire (en `FLUTTERWAVE_CURRENCY`,
  XAF par défaut), puis viré vers son compte bancaire — jamais vers un
  wallet crypto.
  **Pour tester sans vrai argent** : utilisez une clé qui commence par
  `FLWSECK_TEST-` et une carte de test officielle, listées ici :
  https://developer.flutterwave.com/v3.0.0/docs/testing#cards
  (les cartes de test ne fonctionnent qu'avec une clé `_TEST`, jamais
  avec une clé de production).
- **Alertes disponibilité** : si une recherche ne donne aucun résultat,
  un champ email apparaît pour s'inscrire (`/api/notify/subscribe`).
  Quand vous ajoutez le produit correspondant à `data/products.json`,
  appelez `/api/admin/notify-broadcast` (avec l'en-tête
  `x-admin-key: VOTRE_ADMIN_KEY`) pour prévenir automatiquement par
  email tous les abonnés concernés.
- **Rappel "vous avez récemment consulté..."** : dès qu'un client dont
  l'email est connu ouvre une fiche produit, c'est noté en coulisses.
  S'il ne commande pas dans les `REMINDER_DELAY_HOURS` heures (24 par
  défaut), il reçoit automatiquement un email avec la photo du
  produit, son nom, son prix et un bouton pour le revoir — un seul
  rappel par produit, jamais après un achat. Le serveur vérifie ça
  toutes les 30 minutes tout seul ; pour forcer un envoi immédiat
  (test, ou pour un cron externe gratuit type cron-job.org si le
  service Render s'endort), appelez `POST /api/admin/run-reminders`
  avec l'en-tête `x-admin-key: VOTRE_ADMIN_KEY`.

## 5. Catalogue

`data/products.json` est un exemple simple. Ajoutez-y vos produits
réels (avec leur vrai `itemUrl` eBay). Le champ `itemUrl` est un lien
affilié **public** : c'est celui déjà utilisé par le bouton "Acheter
sur eBay" du site — différent du fonctionnement "commande MERCADO"
décrit ci-dessus, qui lui ne montre jamais ce lien à l'écran.

## 6. Limite à connaître

Le stockage des codes de vérification et des abonnés se fait ici en
mémoire/fichier local pour rester simple. Sur le plan gratuit de
Render, le disque n'est pas garanti persistant après un redéploiement.
Pour un usage réel à volume important, remplacez `data/*.json` par une
vraie base de données (ex. Postgres gratuit sur Render).
