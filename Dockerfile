# syntax=docker/dockerfile:1

# ============================================================
# Stage 1 — build the React/Vite frontend
# ============================================================
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ============================================================
# Stage 2 — install production backend dependencies
# ============================================================
FROM node:22-alpine AS server-deps
WORKDIR /app
# node-pty (pod terminal) has no Alpine/musl prebuild, so it compiles from
# source here — needs python3 + a C/C++ toolchain. This stage is discarded;
# only the resulting node_modules is copied into the runtime image.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# ============================================================
# Stage 3 — runtime image (Node + kubectl)
# ============================================================
FROM node:22-alpine AS runtime
WORKDIR /app

# TARGETARCH is provided by BuildKit (amd64 / arm64); default to amd64
ARG TARGETARCH=amd64

# Patch OS packages, then install kubectl (the app shells out to it) and the
# kubelogin OIDC exec plugin.
# NOTE: helm is intentionally NOT installed — Helm releases are read directly
# via the Kubernetes API (see server.js), which also avoids the large cluster
# of Go-module CVEs that ship inside the helm binary.
# kubelogin is installed as `kubectl-oidc_login` so kubeconfigs that
# authenticate via `kubectl oidc-login` work inside the container (statically
# linked Go binary, so it runs fine on Alpine/musl).
RUN apk upgrade --no-cache \
  && apk add --no-cache bash curl ca-certificates libstdc++ \
  && apk add --no-cache --virtual .build-deps unzip \
  && KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl \
  && curl -fsSL "https://github.com/int128/kubelogin/releases/latest/download/kubelogin_linux_${TARGETARCH}.zip" -o /tmp/kubelogin.zip \
  && unzip -o /tmp/kubelogin.zip -d /tmp/kubelogin \
  && mv /tmp/kubelogin/kubelogin /usr/local/bin/kubectl-oidc_login \
  && chmod +x /usr/local/bin/kubectl-oidc_login \
  && rm -rf /tmp/kubelogin /tmp/kubelogin.zip \
  # trivy powers the Security Center's built-in image scan (no in-cluster
  # operator required); the official installer picks the right arch.
  && curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin \
  && apk del .build-deps \
  # npm/npx/corepack aren't used at runtime (the app runs `node server.js`);
  # removing them drops the CVEs in npm's bundled dependencies.
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# Backend deps + source, and the built frontend
COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY assistant.js ./
COPY mcp.js ./
COPY mcp-stdio.js ./
COPY aws-eks.js ./
COPY eks-token.js ./
COPY azure-aks.js ./
COPY azure-token.js ./
COPY trivy-scan.js ./
COPY --from=client-build /app/client/dist ./client/dist

# The server binds 127.0.0.1 by default (so a local install isn't exposed to the
# LAN). Inside a container it must bind all interfaces for the published port to
# work, so set HOST here. When you run the image, prefer publishing to loopback
# on the host too: `docker run -p 127.0.0.1:8080:3001 …`.
ENV NODE_ENV=production \
    HOST=0.0.0.0

EXPOSE 3001

# ------------------------------------------------------------------
# OCI image metadata.
# GHCR shows `description` as the package's short blurb and, via `source`,
# links the package to its GitHub repo — whose README then renders as the
# package "overview". The release workflow's docker/metadata-action overrides
# source/revision/created automatically; set IMAGE_SOURCE for manual builds.
# ------------------------------------------------------------------
ARG APP_VERSION="1.3.0"
LABEL org.opencontainers.image.title="Kubernetes Manager UI" \
      org.opencontainers.image.description="Web UI to browse and operate Kubernetes clusters — workloads, nodes, events, logs, in-browser exec/terminal, service port-forwarding, Helm releases, RBAC and CRDs. Reads your kubeconfig and serves the UI + REST API on port 3001." \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="MIT"

# Drop root — run as the unprivileged `node` user shipped in the base image.
# Its home (/home/node) is writable, so the default kubeconfig path becomes
# /home/node/.kube/config and the assistant config lands in /home/node/.config.
#
# HOME is set explicitly because Docker does NOT derive it from USER — without
# this it can be unset for the `node` user, so the app wouldn't know where to
# look for the kubeconfig. KUBECONFIG pins the default lookup to the documented
# mount point (`-v $HOME/.kube:/home/node/.kube`); a runtime `-e KUBECONFIG=…`
# still overrides it.
ENV HOME=/home/node \
    KUBECONFIG=/home/node/.kube/config
USER node

CMD ["node", "server.js"]
