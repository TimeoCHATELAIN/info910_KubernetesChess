# Échecs en ligne sur Kubernetes

TP INFO910 : application conteneurisée déployable sur un cluster Kubernetes.

## Binôme

- Timéo Chatelain (seul)

## L'application

Jeu d'échecs à deux joueurs en temps réel. Le premier arrivé joue les blancs, le deuxième
les noirs, les suivants regardent. Les coups sont validés côté serveur (`chess.js`), l'horloge
est tenue par le serveur, et les parties terminées sont archivées dans MongoDB.

### Architecture

| Composant | Image | Rôle |
|---|---|---|
| `frontend` | nginx | sert le HTML/JS/CSS et relaie `/socket.io` et `/api` vers `backend:3000` |
| `backend` | Node 20 + Express + Socket.IO | logique de jeu, horloges, diffusion temps réel |
| `redis` | redis:7-alpine | état des parties **en cours**, partagé entre tous les pods backend (TTL 24 h) + bus Socket.IO entre pods |
| `mongo` | mongo:7 | archivage des parties terminées (volume persistant) |

L'état chaud (partie en cours) vit dans Redis, donc n'importe quel pod backend peut servir
n'importe quelle partie. C'est ce qui permet de faire tourner plusieurs réplicas et de tuer
un pod en pleine partie sans perdre la partie.

L'horloge des joueurs n'est pas stockée : Redis garde un horodatage `turnStartedAt` et le temps
restant est recalculé à chaque lecture (`currentClocks()`). Deux pods donnent donc le même temps
au millième près.

Le client force le transport **WebSocket** (`transports: ['websocket']` dans `app.js`). Ce n'est
pas un détail : le transport HTTP *polling* de Socket.IO ne fonctionne pas avec plusieurs réplicas
sans sticky session, car la session du transport est créée en mémoire dans le pod qui répond au
handshake — l'adaptateur Redis ne partage que les diffusions, pas les sessions. Mesuré sur le
cluster : avec 2 réplicas backend, le polling échoue systématiquement (`Session ID unknown`), le
WebSocket passe dans tous les cas (la connexion TCP reste collée à un seul pod).

Le backend ne dépend de Mongo que pour l'archivage : si Mongo n'est pas encore prêt, la connexion
est retentée à chaque archivage et à chaque sonde (`ensure()` dans `db.js`), sans redémarrer le pod.


## Utilisation

1. Ouvrir l'application : une partie est créée, son identifiant est dans l'URL (`?game=xxxx`).
2. Choisir la cadence (1 à 30 min) et son camp, puis cliquer sur « Copier le lien de la partie »
   et l'envoyer à l'adversaire.
3. Jouer en déplaçant les pièces. Un troisième navigateur peut ouvrir le même lien : il passe
   spectateur. L'horloge démarre quand les deux joueurs sont connectés.
4. « Abandonner » termine la partie ; le résultat s'affiche aux deux joueurs et à la partie archivée.

## Lancer en local (Docker Compose)

```bash
docker compose up --build
# http://localhost:8080
```

Docker Compose démarre les quatre services, sans Kubernetes, pratique pour développer le jeu.

## Déployer sur Kubernetes (minikube)

Prérequis : `minikube`, `kubectl`, `docker`.

```bash
minikube start --cpus 2 --memory 4096
minikube addons enable ingress

# Construire les images DANS le démon Docker de minikube
# (elles seront donc visibles par le cluster, sans passer par un registry)
eval $(minikube docker-env)
docker build -t chess-backend:1.0 ./backend
docker build -t chess-frontend:1.0 ./frontend

kubectl apply -f k8s/
kubectl get pods -w
```

Attendre que `mongo-0`, `redis`, les deux `backend` et les deux `frontend` soient `Running` et
`READY 1/1`. Le premier déploiement prend ~30 s : le backend réessaie de se connecter à Mongo
et à Redis tant qu'ils ne sont pas prêts (`kubectl logs deploy/backend`).

Après une modification du code, il faut reconstruire l'image **et** forcer le redémarrage des
pods : le tag `1.0` ne change pas, donc `kubectl apply` seul ne déclenche aucun rollout.
`eval $(minikube docker-env)` est à refaire dans chaque nouveau terminal.

```bash
docker build -t chess-backend:1.0 ./backend
kubectl rollout restart deploy/backend
```

Accès à l'application :

```bash
minikube ip          # ex. 192.168.49.2  ->  http://192.168.49.2
```

Aucun nom de domaine à configurer : l'Ingress n'a pas de `host` et répond sur l'IP du cluster.
Si l'Ingress ne répond pas, repli équivalent :

```bash
kubectl port-forward svc/frontend 8080:80   # http://localhost:8080
```

Les fichiers du dossier `k8s/` sont appliqués par ordre alphabétique : `backend.yaml` crée le
Service `backend` avant que `frontend` (dont nginx résout ce nom au démarrage) ne soit déployé.

Ouvrir une session navigateur différente pour chaque joueur (fenêtre privée), sinon le
`localStorage` partage le même identifiant de joueur.

## Vérifier que le déploiement fonctionne

```bash
kubectl get pods,svc,ingress
kubectl logs deploy/backend

# Répartition de charge : deux requêtes dans deux pods différents
curl http://$(minikube ip)/api/whoami
curl http://$(minikube ip)/api/whoami

# Parties archivées après une partie terminée
kubectl exec -it mongo-0 -- mongosh -u chess -p chess-demo-password --authenticationDatabase admin \
  --eval "db.getSiblingDB('chess').games.countDocuments()"
```

Démo de résilience (à faire en pleine partie) :

```bash
kubectl delete pod -l app=backend    # les deux pods backend
kubectl delete pod -l app=frontend   # les pods frontend
kubectl scale deploy/backend --replicas=3
```

Le navigateur passe par « Connexion perdue, reconnexion… », se reconnecte au pod suivant,
renvoie `join` et récupère l'état : la partie et l'horloge repartent là où elles en étaient.

## Ce qui a été validé sur minikube

Minikube v1.39, Kubernetes v1.37, addon `ingress`, réseau lent (téléchargement des images au
premier démarrage).

- `kubectl apply -f k8s/` sur un cluster neuf : 11 ressources créées, les 6 pods finissent `Running`
  (2 backend, 2 frontend, 1 redis, 1 mongo).
- Le premier démarrage est lent (téléchargement de `mongo:7`) : le backend reste `Ready` et se
  connecte à Mongo dès qu'il répond, sans redémarrage.
- Partie complète à deux joueurs + abandon, à travers l'Ingress, avec 2 puis 3 réplicas backend.
- Partie terminée bien retrouvée dans MongoDB (`db.games`).
- `kubectl delete pod -l app=backend` en pleine partie : après reconnexion, les coups et l'horloge
  sont identiques.

## Nettoyage

```bash
kubectl delete -f k8s/    # supprime aussi le PVC de Mongo
minikube stop             # ou minikube delete
```

## Limites connues

- **Un seul Redis, sans volume.** Si le pod Redis est supprimé, les parties en cours sont perdues
  (les parties déjà archivées dans Mongo restent). On privilégie la simplicité : Redis est un cache
  d'état à durée de vie courte, pas une base de données.
- **Un seul MongoDB.** Le StatefulSet n'a qu'un réplica : pas de haute disponibilité de l'archivage.
  Un vrai réplica set demande trois pods, une initialisation `rs.initiate()` et une `connectionString`
  différente — hors du périmètre du TP.
- **`getGame` puis `saveGame` ne sont pas atomiques.** Deux coups simultanés sur la *même* partie
  pourraient s'écraser. En pratique la validation tour par tour l'empêche, mais ce n'est pas atomique.
- **`/readyz` ne teste que Redis.** Redis est la dépendance critique (sans lui, les parties ne sont
  plus partagées entre pods). Mongo ne retire pas le backend du Service : le jeu reste jouable, seules
  les archives sont perdues, et la connexion se rétablit toute seule au retour de Mongo.
- **Transport WebSocket uniquement.** Si un proxy d'entreprise bloque les WebSocket, il n'y a pas de
  repli en polling (il faudrait des sticky sessions sur l'Ingress côté frontend *et* entre le
  frontend et le backend, ce qu'un nginx standard ne fait pas sans module).
- **Mot de passe Mongo en clair** dans `k8s/config.yaml` (Secret de démonstration). En réel, le Secret
  serait créé hors dépôt (`kubectl create secret`), voire chiffré (SealedSecret, Vault).
- **Le navigateur a besoin d'Internet** : `chess.js` et les images des pièces viennent de CDN.

## Arborescence

```
backend/            sources Node.js + Dockerfile
frontend/           HTML/JS/CSS + nginx.conf + Dockerfile
k8s/
  config.yaml       ConfigMap (URLs) + Secret (identifiants Mongo)
  mongo.yaml        Service headless + StatefulSet + volume persistant
  redis.yaml        Service + Deployment
  backend.yaml      Deployment (2 réplicas) + Service + sondes
  frontend.yaml     Deployment (2 réplicas) + Service
  ingress.yaml      Ingress nginx (timeouts WebSocket)
docker-compose.yml  exécution locale sans Kubernetes
```
