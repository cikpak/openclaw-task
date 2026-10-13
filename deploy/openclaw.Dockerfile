FROM ghcr.io/openclaw/openclaw:2026.10.1
USER root
RUN install -d -m 0755 -o node -g node /bootstrap
USER node
