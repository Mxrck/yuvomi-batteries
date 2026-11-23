# Batteries sidecar. Built from the repo root:
#   docker build -f service/Dockerfile -t ghcr.io/mxrck/yuvomi-batteries:0.1.0 .
# Base pinned by index digest (audited 2026-11-23, same node:24-slim the dev stack runs).
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

WORKDIR /app
# The service (zero npm dependencies) and the module page it ships to Yuvomi. Same layout as the
# dev compose: code at /app/service/app, run as service/app/server.mjs.
COPY service/app /app/service/app
COPY service/install-module.mjs /app/install-module.mjs
COPY service/entrypoint.sh /entrypoint.sh
COPY modules/batteries /app/modules/batteries
RUN chmod 0755 /entrypoint.sh

ENV NODE_ENV=production \
    PORT=3100 \
    DB_PATH=/data/batteries.db

EXPOSE 3100
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "service/app/server.mjs"]
