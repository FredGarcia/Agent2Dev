# syntax=docker/dockerfile:1
# Gabarit, exemple Django. La forme vaut pour toutes les piles :
# une image construite depuis le seul dépôt (2.2), identifiée par son commit (1.1, 5.2),
# qui sert web, worker, scheduler et tâches d'admin (8.2, 12.1).
# Épingler l'image de base par digest : dev et prod partent alors du même octet (10.1).
ARG PYTHON_IMAGE=python:3.13-slim

FROM ${PYTHON_IMAGE} AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN useradd --system --uid 10001 --no-create-home app

FROM base AS deps
# Versions verrouillées et vérifiées par empreinte (2.1).
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

# Cible dev : dépendances de développement en plus ; les sources sont montées par compose.override.yaml.
FROM deps AS dev
COPY requirements-dev.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements-dev.txt
COPY . .
USER app
ENTRYPOINT ["/app/bin/run"]
CMD ["web"]

# Cible prod (dernière étape : celle que construit la CI par défaut).
FROM deps AS prod
COPY . .
RUN SECRET_KEY=build-seulement python manage.py collectstatic --noinput
ARG REVISION=inconnue
LABEL org.opencontainers.image.revision=$REVISION
USER app
ENTRYPOINT ["/app/bin/run"]
CMD ["web"]
