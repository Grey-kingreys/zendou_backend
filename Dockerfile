# syntax=docker/dockerfile:1
#
# Image Docker du backend Zendou (NestJS 11 + Prisma + BullMQ) pour Dokploy.
#
# Trois stages :
#   1. deps    : installe TOUTES les dépendances (avec devDependencies), sans
#                exécuter de scripts d'installation.
#   2. build   : génère le client Prisma, compile TypeScript (nest build).
#   3. runtime : image de production, minimale, utilisateur non-root.
#
# ── Note sur `npm ci --ignore-scripts` ──────────────────────────────────────
# Ce repo tourne avec le garde `allow-scripts` intégré à npm ≥ 11 : les
# scripts install/postinstall/preinstall des dépendances ne sont PAS exécutés
# tant qu'ils n'ont pas été explicitement approuvés (npm approve-scripts).
# On respecte cette politique dans l'image en forçant `--ignore-scripts`
# partout, et en gérant à la main les deux seuls paquets qui en ont besoin :
#   - argon2       : le paquet npm embarque des prebuilds natifs pour
#                    linux-x64 (glibc ET musl, donc compatible Alpine) sous
#                    node_modules/argon2/prebuilds/. `node-gyp-build` les
#                    résout directement au premier require(), sans script
#                    d'install ni compilation. Rien à faire de plus.
#   - prisma/@prisma/client : le postinstall générerait le client Prisma,
#                    mais on le fait explicitement via `npx prisma generate`
#                    au stage `build` (nécessaire de toute façon après tout
#                    changement de schéma, donc plus fiable qu'un postinstall
#                    implicite).
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# openssl : le moteur de requêtes Prisma (musl) s'y lie dynamiquement.
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Télécharge/génère le client Prisma pour la plateforme cible (linux-musl-x64)
# puis compile. L'ordre compte : `nest build` type-check contre le client
# Prisma généré.
RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl \
  && addgroup -S nodejs \
  && adduser -S nodejs -G nodejs

COPY package.json package-lock.json ./

# Dépendances de production uniquement, sans scripts d'install (voir note
# ci-dessus). `prisma` (CLI) est une devDependency et n'est donc PAS installé
# par cette commande.
RUN npm ci --omit=dev --ignore-scripts

# Le client Prisma généré au stage `build` (node_modules/.prisma) écrase le
# client "vide" posé par `npm ci` : c'est lui qui contient le moteur de
# requêtes compilé pour linux-musl et les types correspondant au schéma.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

# La CLI `prisma` (migrate deploy, au démarrage — voir plus bas) est une
# devDependency, donc absente de l'install ci-dessus. On la rapatrie
# explicitement depuis le stage `build`, avec son moteur de schéma
# (@prisma/engines) et son lien node_modules/.bin/prisma, pour que
# `npx prisma migrate deploy` fonctionne à 100% en local, sans dépendre
# d'un accès réseau au démarrage du conteneur pour re-télécharger la CLI.
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
COPY --from=build /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

# dist/ (code compilé) + prisma/ (schéma + migrations : indispensables pour
# `prisma migrate deploy`, qui les lit à l'exécution).
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||4000,path:'/health',timeout:4000},(res)=>{process.exit(res.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Migrations appliquées au démarrage du conteneur, avant de lancer le
# serveur. Choix documenté dans docs/DEPLOIEMENT-DOKPLOY.md :
#   - simple à opérer sur un déploiement mono-instance comme celui-ci
#     (pas d'étape CI/CD séparée demandée pour ce ticket) ;
#   - `prisma migrate deploy` est idempotent (n'applique que les migrations
#     manquantes) et sûr à ré-exécuter à chaque redémarrage/déploiement ;
#   - limite connue : avec plusieurs instances démarrant en parallèle,
#     deux `migrate deploy` concurrents peuvent se marcher dessus. Non
#     applicable ici (une seule instance backend), à revisiter si le service
#     est un jour scalé horizontalement (déplacer la migration vers une
#     "pre-deploy command" Dokploy dédiée, exécutée une seule fois).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
