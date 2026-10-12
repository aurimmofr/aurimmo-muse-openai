# Aurimmo Intérieur

Application cliente Vercel pour concevoir un salon Japandi à partir d'une photo
et du catalogue Aurimmo. Le studio conserve le parcours photo, les programmes,
les finitions, la sélection aléatoire et personnalisable des produits, le panier
local et les points produits. Les rendus sont générés exclusivement par **Muse
Image**.

## Parcours client

La page d'accueil ouvre le portail public :

1. inscription ou connexion publique par lien sécurisé envoyé par e-mail ;
2. création du profil et du premier projet ;
3. accès au studio pour prendre une photo ou importer une image, choisir le
   programme, les surfaces et les produits ;
4. présentation des forfaits uniquement au moment de lancer la première image ;
5. retour au studio après la souscription, avec le brouillon conservé ;
6. suivi des projets, créations, crédits et abonnement depuis l'espace client.

L'inscription est publique et ne dépend pas d'une invitation. Les données du
portail sont stockées dans une base Supabase dédiée à Aurimmo Intérieur. Les
politiques RLS et les contrôles serveur isolent les profils, projets, photos,
rendus, usages et abonnements de chaque client.

Deux forfaits sont proposés, sans essai et sans report des crédits :

| Forfait | Images / mois | Mensuel | Annuel |
| --- | ---: | ---: | ---: |
| Essentiel | 10 | 9,99 € / mois | 74,28 € / an, soit 6,19 € / mois |
| Pro | 100 | 39,99 € / mois | 299,88 € / an, soit 24,99 € / mois |

Une photo correspond à une pièce. Chaque formule donne accès aux bibliothèques
de styles, meubles et finitions. Les téléchargements restent disponibles pendant
24 heures. Stripe Checkout crée l'abonnement ; le webhook Stripe reste l'unique
source d'activation de l'abonnement, puis le serveur réserve et consomme chaque
crédit au moment de la génération.

## Surfaces de l'application

- `/portal.html` : inscription, connexion, onboarding et espace client ;
- `/studio.html` : outil de création Muse authentifié ;
- `/admin.html` : suivi des clients, abonnements, crédits et générations pour les
  adresses déclarées dans `ADMIN_EMAILS`.

Le dashboard administrateur ne contient pas de données fictives. Il lit les
agrégats réels de Supabase et ne publie aucun identifiant de paiement sensible.

## Installation locale

```sh
npm install
npm test
npx vercel dev
```

Copier `.env.example` vers un fichier local ignoré par Git, puis renseigner les
variables côté serveur. Appliquer ensuite toutes les migrations de `supabase/migrations/`
à la base dédiée avant d'ouvrir les inscriptions. Le lien magique fonctionne pour
les membres autorisés du projet avec l'envoi Supabase intégré. Une ouverture à des
clients externes exige un SMTP personnalisé dans Supabase Auth ; le fournisseur
intégré refuse les adresses qui ne font pas partie de l'équipe du projet et reste
limité aux essais. La saisie facultative d'un code à six chiffres devient disponible
avec ce SMTP et un modèle OTP adapté.

Pour la facturation, `npm run stripe:configure:sandbox` crée ou retrouve les quatre
prix récurrents exacts, configure le portail client et le webhook de l'environnement
de test, sans afficher les secrets. Les événements d'abonnement et de facture sont
vérifiés par signature et traités de manière idempotente. Le passage en production
nécessite des clés et prix Stripe réels distincts du sandbox.

`GENERATION_ENABLED` doit valoir exactement `true` pour autoriser un rendu. Les
tests, le chargement du portail, l'import d'une photo et la préparation d'une
composition ne déclenchent aucun appel Muse. Un clic de génération autorisé
réserve un crédit, effectue au maximum un appel image et n'applique aucun retry
automatique.

## Stockage et sécurité

- les clés Muse, Supabase, Stripe, Vercel Blob et GitHub restent exclusivement
  dans les variables d'environnement serveur ;
- les sessions client utilisent des cookies sécurisés gérés par le serveur ;
- les photos et résultats sont conservés dans un Vercel Blob privé ;
- chaque API de projet vérifie l'identité Supabase et le propriétaire des données ;
- la génération lie exactement l'utilisateur, le projet, la photo source, la
  sélection figée et l'autorisation de crédit ;
- un résultat ambigu est signalé pour rapprochement et n'est jamais relancé
  automatiquement.

## Points produits

Après chaque rendu sauvegardé, un workflow GitHub Actions télécharge l'image
privée, exécute Grounding DINO et SAM hors ligne, puis enregistre uniquement les
positions normalisées dans le stockage privé. Il n'appelle pas de service de
génération ou de vision distant. Un produit non localisé avec assez de confiance
n'obtient aucun point inventé.

Le serveur déclenche le workflow immédiatement après la sauvegarde. Une
réconciliation planifiée reprend les tâches manquées ; l'interface expose les
états en attente, en cours, terminés ou en échec et permet une relance idempotente
limitée aux points. Les ronds sont associés au rendu exact et à sa sélection
figée, jamais à la dernière proposition mutable.

```sh
npm run hotspots:once
npm run hotspots:bridge
```

Le workflow `.github/workflows/product-hotspots.yml` utilise le secret GitHub
`BLOB_READ_WRITE_TOKEN`. Vercel conserve `GITHUB_HOTSPOT_TOKEN`, limité à ce dépôt
avec la permission `Actions: write`, pour déclencher ce workflow.
