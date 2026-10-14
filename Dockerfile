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

# Pinned tool versions and the SHA-256 of their linux/amd64 and linux/arm64
# downloads. Every download is checked against these committed hashes, so a
# tampered or replaced upstream release fails the build. To upgrade, change the
# version and its hashes together (each project publishes the hashes with the
# release).
ARG KUBECTL_VERSION=v1.37.1
ARG KUBECTL_SHA256_AMD64=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
ARG KUBECTL_SHA256_ARM64=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7
ARG KUBELOGIN_VERSION=v1.36.4
ARG KUBELOGIN_SHA256_AMD64=9e8baeb4905d35a301304af2548324997add512fe94ab20e65993d167212bf85
ARG KUBELOGIN_SHA256_ARM64=669c2d3bcc6766351ad5a7b03971792b4e7a55117b335a12d9858d43a525d9dc
ARG TRIVY_VERSION=0.75.0
ARG TRIVY_SHA256_AMD64=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f
ARG TRIVY_SHA256_ARM64=a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3

# Patch OS packages, then install kubectl (the app shells out to it), the
# kubelogin OIDC exec plugin (as `kubectl-oidc_login`, so kubeconfigs using
# `kubectl oidc-login` work) and trivy (Security Center's built-in image scan).
# NOTE: helm is intentionally NOT installed: Helm releases are read directly
# via the Kubernetes API (see server.js), which also avoids the large cluster
# of Go-module CVEs that ship inside the helm binary.
RUN set -eu \
  && apk upgrade --no-cache \
  && apk add --no-cache bash curl ca-certificates libstdc++ \
  && apk add --no-cache --virtual .build-deps unzip \
  && case "$TARGETARCH" in \
       amd64) KUBECTL_SHA="$KUBECTL_SHA256_AMD64"; KUBELOGIN_SHA="$KUBELOGIN_SHA256_AMD64"; TRIVY_SHA="$TRIVY_SHA256_AMD64"; TRIVY_ARCH=64bit ;; \
       arm64) KUBECTL_SHA="$KUBECTL_SHA256_ARM64"; KUBELOGIN_SHA="$KUBELOGIN_SHA256_ARM64"; TRIVY_SHA="$TRIVY_SHA256_ARM64"; TRIVY_ARCH=ARM64 ;; \
       *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && cd /tmp \
  && curl -fsSL -o kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
  && echo "${KUBECTL_SHA}  kubectl" | sha256sum -c - \
  && install -m 0755 kubectl /usr/local/bin/kubectl \
  && curl -fsSL -o kubelogin.zip "https://github.com/int128/kubelogin/releases/download/${KUBELOGIN_VERSION}/kubelogin_linux_${TARGETARCH}.zip" \
  && echo "${KUBELOGIN_SHA}  kubelogin.zip" | sha256sum -c - \
  && unzip -o kubelogin.zip -d kubelogin \
  && install -m 0755 kubelogin/kubelogin /usr/local/bin/kubectl-oidc_login \
  && curl -fsSL -o trivy.tar.gz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz" \
  && echo "${TRIVY_SHA}  trivy.tar.gz" | sha256sum -c - \
  && tar -xzf trivy.tar.gz -C /usr/local/bin trivy \
  && rm -rf /tmp/kubectl /tmp/kubelogin /tmp/kubelogin.zip /tmp/trivy.tar.gz \
  && apk del .build-deps \
  # npm/npx/corepack aren't used at runtime (the app runs `node server.js`);
  # removing them drops the CVEs in npm's bundled dependencies.
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# Backend deps + source, and the built frontend
COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./
# All backend modules (server, assistant, MCP, cloud integrations, demo mode,
# kubeconfig token helpers) and the shared lib/ helpers. Copy by pattern so a
# new module can't be silently left out of the image again.
COPY *.js ./
COPY lib/ ./lib/
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
ARG APP_VERSION="dev"
LABEL org.opencontainers.image.title="k8sight" \
      org.opencontainers.image.description="k8sight: browse and operate Kubernetes clusters from your kubeconfig (workloads, logs, shells, topology, Helm, Argo CD, Flux, Flagger, security and costs). Serves the UI and API on port 3001; open the access link printed at startup." \
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
