# Image du résolveur : exécute un cycle 7E sur le dépôt monté en /depot.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

# gitleaks, pour le contrôle de 3.2 (version épinglée)
RUN curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
    | tar -xz -C /usr/local/bin gitleaks

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY resolveur7e.mjs modele-executif-12f-7e.yaml ./

ENV DEPOT_7E=/depot \
    MODELE_7E=/app/modele-executif-12f-7e.yaml \
    RESOLVEUR_7E=/app/resolveur7e.mjs
ENTRYPOINT ["node", "/app/resolveur7e.mjs"]
