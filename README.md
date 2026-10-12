MERCADO - correctifs recherche, e-mail et bannieres

Fichiers :
- server.js : serveur Express avec recherches CJ élargies pour Nike/Jordan et messages d'erreur Resend plus explicites.
- public/index.html : retire uniquement la première bannière CJ + MERCADO. Les deux autres diapositives (livraison gratuite et offre nouvel acheteur) restent et défilent.
- package.json et .env.example : configuration du projet.

IMPORTANT POUR RESEND :
Le code ne peut pas contourner les limites de Resend. onboarding@resend.dev est un expéditeur de test et ne permet généralement pas d'envoyer les codes à tous les clients. Dans Render > Environment :
1. Garder RESEND_API_KEY avec une clé API valide.
2. Ajouter/vérifier un domaine que vous possédez dans https://resend.com/domains et configurer les DNS demandés.
3. Définir RESEND_FROM avec une adresse de ce domaine vérifié, par exemple MERCADO <support@votre-domaine.com> (remplacer par votre vrai domaine).
4. Redéployer le service.

La recherche est élargie à plusieurs termes dans le catalogue CJ Dropshipping. Elle ne peut pas montrer des produits absents du catalogue CJ ou bloqués par les droits/paramètres de l'API. Le code n'invente pas de résultats.

Déploiement : remplacer server.js et public/index.html dans le dépôt GitHub relié à Render, puis laisser Render redéployer. Ne jamais mettre RESEND_API_KEY dans les fichiers du site ni la partager.

Mise à jour :
- Le code de vérification par e-mail a été retiré du formulaire et du serveur.
- Le client voit maintenant un court texte lui demandant de fournir des informations exactes.
- Les étapes importantes sont enregistrées dans notifications.json et envoyées à Telegram si Telegram est configuré.
- Endpoint admin pour consulter les notifications : GET /api/admin/notifications?limit=100 (protéger avec ADMIN_KEY).
- Pour conserver notifications.json après redémarrage Render, configurez un disque persistant et DATA_DIR.
