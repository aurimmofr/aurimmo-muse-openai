# Aurimmo — comparaison Muse / OpenAI

Application Vercel protégée par mot de passe pour comparer un rendu **Muse
Image** et un rendu **OpenAI Image** à partir de la même photo, du même programme,
des mêmes surfaces et de la même sélection catalogue figée.

L'interface reprend le laboratoire Aurimmo existant : identité visuelle et CSS,
prise ou ajout de photo, quatre programmes, choix indépendants du sol et des murs,
cartes produits, panier local, carnet d'essai et comparaison côte à côte. Elle
embarque les 4 192 références Salon/Japandi actives du catalogue local et garde
séparément les références exactes nécessaires à la lecture des anciens rendus.

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

## Points produits

Après chaque rendu, un worker GitHub Actions hébergé télécharge l'image privée,
exécute Grounding DINO + SAM hors ligne puis enregistre uniquement les positions
normalisées dans le Blob privé. Il n'appelle ni Muse ni OpenAI, n'envoie aucune
image à une API de vision et omet tout produit non localisé avec assez de confiance.
Le contrôle des rendus en attente a lieu toutes les cinq minutes ; l'interface
publique actualise automatiquement les points pendant le traitement.

```sh
npm run hotspots:once    # traiter les rendus en attente puis quitter
npm run hotspots:bridge  # surveiller les nouveaux rendus
```

Ces commandes restent disponibles pour le développement, mais le site public ne
dépend pas du Mac du laboratoire. Le workflow `.github/workflows/product-hotspots.yml`
utilise le secret GitHub `BLOB_READ_WRITE_TOKEN`, les poids publics épinglés et un
runner éphémère. La fiche ouverte depuis un point et le panier restent locaux au
navigateur ; aucun achat n'est connecté.
