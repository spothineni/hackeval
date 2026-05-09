FROM node:20-slim

# Install dumb-init so SIGTERM from the orchestrator reaches `node` directly
# (avoids an extra shell process eating signals on shutdown).
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

# `node` user (uid 1000) ships in the official image. Run as it instead of
# root so a process compromise can't escalate filesystem-wide.
WORKDIR /app
RUN chown -R node:node /app
USER node

# Reproducible install from the lockfile. `npm ci` errors if package.json
# and package-lock.json are out of sync, which is the right behavior in CI.
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# Staging dir for multipart uploads. In cloud mode (S3/GCS) the file is
# pushed to the bucket and the temp file is unlinked — this dir is just
# scratch space.
RUN mkdir -p uploads

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
