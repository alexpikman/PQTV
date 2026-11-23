FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/assets ./assets
COPY --from=build --chown=node:node /app/logo ./logo
COPY --from=build --chown=node:node /app/views ./views
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/manifest.webmanifest ./manifest.webmanifest
COPY --from=build --chown=node:node /app/sw.js ./sw.js
COPY --from=build --chown=node:node /app/favicon.ico ./favicon.ico
COPY --from=build --chown=node:node /app/playlist ./playlist
COPY --from=build --chown=node:node /app/firebase-applet-config.json ./firebase-applet-config.json
COPY --from=build --chown=node:node /app/firebase-blueprint.json ./firebase-blueprint.json
RUN mkdir -p /app/data /app/data/cache /app/data/backups/playlist && chown -R node:node /app/data /app/playlist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
