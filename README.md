# Aurimmo — comparaison Muse / OpenAI

Application Vercel protégée par mot de passe pour comparer un rendu **Muse
Image** et un rendu **OpenAI Image** à partir de la même photo, du même programme,
des mêmes surfaces et de la même sélection catalogue figée.

L'interface reprend le laboratoire Aurimmo existant : identité visuelle et CSS,
prise ou ajout de photo, quatre programmes, choix indépendants du sol et des murs,
cartes produits, panier local, carnet d'essai et comparaison côte à côte.

## Sécurité

- les clés API restent dans les variables d'environnement Vercel ;
- les photos et résultats sont placés dans un stockage Vercel Blob privé ;
- une génération nécessite une session authentifiée et une confirmation explicite ;
- chaque clic autorise un seul appel image, sans retry automatique ;
- aucun ancien rendu, photo locale, historique ou fichier `.env` n'est versionné.

## Développement

```sh
npm install
npm test
npx vercel dev
```

Variables requises : voir `.env.example`. La génération reste bloquée si
`GENERATION_ENABLED` n'est pas exactement `true`.

## Limite volontaire

Le panier et les fiches produits sont locaux au navigateur. Les points bleus ne
sont pas inventés dans la version Vercel : ils exigent le repérage visuel local
hors ligne du laboratoire complet. La version publique affiche donc les produits
figés sous le rendu, sans prétendre les localiser dans l'image.
