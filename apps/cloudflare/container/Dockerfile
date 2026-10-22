FROM ghcr.io/openclaw/openclaw:2026.10.1@sha256:9001e8a880d6ca028b590932b83b9335a26225e86c2a8a7aa9af7c59d6842953
USER root
RUN mkdir -p /opt/messenger-helper /recovery /var/lib/messenger-helper && chown node:node /recovery && chmod 0700 /var/lib/messenger-helper
COPY . /opt/messenger-helper/
RUN node /opt/messenger-helper/native-owner/install.mjs /app
ENV HOME=/recovery/home OPENCLAW_HOME=/recovery/home OPENCLAW_STATE_DIR=/recovery/state OPENCLAW_CONFIG_PATH=/recovery/state/openclaw.json OPENCLAW_OAUTH_DIR=/recovery/state/credentials OPENCLAW_WORKSPACE_DIR=/recovery/workspace XDG_CACHE_HOME=/recovery/cache XDG_CONFIG_HOME=/recovery/home/.config XDG_DATA_HOME=/recovery/home/.local/share XDG_STATE_HOME=/recovery/home/.local/state NODE_COMPILE_CACHE=/var/lib/messenger-helper/compile-cache TMPDIR=/recovery/tmp NODE_ENV=production
WORKDIR /opt/messenger-helper
HEALTHCHECK NONE
EXPOSE 8787 18789
ENTRYPOINT ["node", "/opt/messenger-helper/start.mjs"]
