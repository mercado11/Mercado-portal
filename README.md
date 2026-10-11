
# MERCADO — CJ Dropshipping

## Structure du projet

- server.js : serveur Node.js / Express
- package.json : dépendances et commandes
- .env.example : modèle des variables d'environnement
- .gitignore : fichiers à exclure de Git
- public/index.html : site web MERCADO
- public/mercado-cj-banner.png : image du bandeau CJ Dropshipping

## Installation

1. Installer Node.js 20 ou une version plus récente.
2. Ouvrir un terminal dans le dossier du projet.
3. Exécuter npm install.
4. Configurer les variables d'environnement.
5. Exécuter npm start.

## Déploiement Render

Build Command :
npm install

Start Command :
npm start

## Catalogue CJ Dropshipping

Le catalogue est récupéré via le backend.
La marge est configurable avec PRICE_MARKUP_USD.
La valeur par défaut du modèle est de 5 USD.

## Bandeau MERCADO

Le site utilise une image promotionnelle CJ Dropshipping.
La vidéo du bandeau a été retirée.
Place l'image dans public/mercado-cj-banner.png.

## Sécurité

Ne publie jamais les clés API, mots de passe ou jetons dans GitHub.
Teste le paiement en mode test avant de recevoir de vraies commandes.
