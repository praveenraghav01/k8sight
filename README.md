<div align="center">

<img src="build/icon.png" alt="k8sight" width="104" />

# k8sight

**See your whole cluster in one beautiful window.**

A native desktop app (macOS · Windows · Linux) — and a Docker image — for browsing and operating any Kubernetes cluster from your local `kubeconfig`.

[![Build & Release](https://github.com/praveenraghav01/k8sight/actions/workflows/release.yml/badge.svg)](https://github.com/praveenraghav01/k8sight/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/praveenraghav01/k8sight?sort=semver)](https://github.com/praveenraghav01/k8sight/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/praveenraghav01/k8sight/total)](https://github.com/praveenraghav01/k8sight/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-informational)

</div>

![k8sight cluster dashboard](docs/screenshot-dashboard.png)

> [!TIP]
> Grab the latest macOS `.dmg`, Windows `.exe`, or Linux `.AppImage`/`.deb` from the [**Releases**](https://github.com/praveenraghav01/k8sight/releases/latest) page — no build required.

## Features

**Demo mode — try it with no cluster**
- Pick the built-in **demo cluster** (or click **Explore the demo** on the connect screen) to try every feature against a realistic synthetic cluster — sample workloads (including a Pending and a CrashLoopBackOff pod), live metrics, cost allocations, logs, topology, Helm, Argo CD, a Security Center scan, a pod shell and the AI assistant — with **no kubeconfig required**.

**Explore**
- Live cluster dashboard — node/pod health, workload charts, capacity.
- **Costs** — optional OpenCost/Kubecost allocations for namespaces, workloads, and nodes over the last 24 hours, 7 or 30 days, or month to date: totals and idle cost, a stacked **cost over time** chart by namespace (hover a bar for its breakdown), and a per-resource table. Detects the provider Service automatically or uses per-context settings saved locally. When no provider is found, Costs recommends a low-footprint OpenCost Collector install that does not need a separate Prometheus or OpenCost UI.
- Every workload type (Pods, Deployments, StatefulSets, DaemonSets, Services, …) with live CPU/memory, per-container status, and cross-links (namespace → node → pod → owner).
- Interactive pan/zoom topology graph and a lazy-loaded Custom Resource tree.
- **Helm** — releases with their values and rendered manifests, plus search [Artifact Hub](https://artifacthub.io) and install or upgrade charts from the UI.
- Sortable resource tables — click any column header to sort by value (CPU, memory, age, restarts, capacity), ascending → descending → off.
- Background auto-refresh that updates data in place — no loader flash, and your selection, active tab, search, scroll and topology pan/zoom are preserved.
- Command palette (⌘K), native title bar with back/forward history, light & dark themes.

**Stays up to date**
- The desktop app checks GitHub Releases on launch, downloads a new version in the background and asks to restart. Turn it off, or check manually, in **Preferences → General** (or the app menu).

**Operate**
- Edit and apply YAML; per-row Scale, Rollout restart, and Delete (two-step confirm).
- Pro log viewer — timestamps, per-container or merged streams, regex search, tail size, download.
- Interactive shell — a real TTY into pods (`kubectl exec -it` over WebSocket).
- Port-forward a Service to `localhost`, and a multi-tab bottom panel for logs/terminal/YAML.

**Cloud clusters, no CLI**
- One-click **AWS EKS** (SSO, access keys, or assume-role), **Azure AKS** (system browser or `az`), and **Google GKE** (your existing `gcloud` login, browser OAuth, or a service-account key) — discover clusters across accounts / subscriptions / projects and merge them into your kubeconfig. Bundled token helpers authenticate at runtime, so *using* imported clusters needs no `aws`/`az`/`gcloud`/`kubelogin`/`gke-gcloud-auth-plugin`.
- On-prem, kind/minikube and any other context work straight from your existing kubeconfig.

**Security Center**
- Scan running images for CVEs, audit configuration and RBAC risk, and find exposed secrets — reading **Trivy Operator** reports or a **bundled Trivy** binary, so you can scan with nothing installed in-cluster.

**Argo CD** (auto-detected)
- GitOps dashboard, resource-tree View, Applications/AppSets/Projects, and Sync/Refresh/Rollback actions.

**AI, bring your own**
- A read-only, tool-using assistant grounded in live cluster data — connect any OpenAI-compatible endpoint (secrets redacted before anything leaves the app).
- Docked coding agents — detects Claude Code, GitHub Copilot CLI, Gemini CLI, Codex and opencode on your `PATH`.
- Doubles as an [MCP](https://modelcontextprotocol.io) server so external agents can inspect the cluster ([details](#connect-ai-agents-mcp)).

## How k8sight compares

k8sight is a **desktop UI for clusters you already have** — closest in spirit to **Lens** and **k9s**, not to a management *platform* like **Rancher**. Rancher runs *inside* your clusters to provision and govern a whole fleet for a team; k8sight runs on your laptop, reads your kubeconfig, and needs nothing installed in-cluster.

| | **k8sight** | **Rancher** | **Lens / k9s** |
|---|:---:|:---:|:---:|
| Category | Native desktop UI | Multi-cluster platform (server) | Desktop UI / terminal UI |
| Setup | Download & run | Deploy & operate in-cluster | Download & run |
| Runs where | Your laptop | In a cluster | Your laptop / terminal |
| Cluster lifecycle (provision, upgrade) | — | ✅ | — |
| Centralized team RBAC & multi-tenancy | — | ✅ | — |
| Built-in security scan (image CVEs, config, RBAC) | ✅ *bundled Trivy* | via add-ons | — |
| Cost view (OpenCost/Kubecost) | ✅ | via add-ons | — |
| AI assistant + MCP server | ✅ | — | — |
| Try with no cluster (demo mode) | ✅ | — | — |
| One-click EKS/AKS/GKE onboarding (no CLI) | ✅ | ✅ | — |
| Free & open-source | ✅ | ✅ | k9s ✅ · Lens: sign-in required |

> [!NOTE]
> Reach for **Rancher** to provision and govern a fleet of clusters for a team. Reach for **k8sight** as a fast local cockpit for clusters you already have — dashboards, logs, shell, topology, security scans and an AI assistant, with nothing to deploy. They coexist happily.

## Quick start

> [!TIP]
> No cluster handy? Launch the app and click **Explore the demo** (or pick the **demo** context) to browse and operate a synthetic cluster — every feature works, no setup needed.

> [!NOTE]
> To use a real cluster, k8sight shells out to `kubectl` (required on your `PATH`) and `helm` (v3, only to install or upgrade charts; viewing releases doesn't need it), and needs a working `kubeconfig` (`~/.kube/config`, or set `KUBECONFIG`). The packaged desktop app bundles its own Node runtime; building from source needs **Node.js 20+** (24 recommended).

### Desktop app

Most people just [download a build](https://github.com/praveenraghav01/k8sight/releases/latest). To build it yourself:

```bash
npm ci && npm ci --prefix client
npm run dist        # builds the UI and packages for the current OS → release/
```

| OS | Artifact |
|----|----------|
| macOS | `k8sight-macos.dmg` (Apple Silicon) |
| Windows | `k8sight-windows.exe` (NSIS) |
| Linux | `k8sight-linux.AppImage` and `k8sight-linux.deb` |

> [!IMPORTANT]
> The **macOS** app and its `.dmg` are **Developer ID–signed and notarized**: open the `.dmg`, drag k8sight to Applications, and it launches normally. Run it from Applications so it can update itself. **Windows** builds are unsigned — SmartScreen → **More info → Run anyway**.

### Docker

The image bundles Node, `kubectl`, and `kubelogin`, and serves the UI + API on port `3001` as the unprivileged `node` user.

```bash
docker run --rm -p 127.0.0.1:8080:3001 \
  -v "$HOME/.kube:/home/node/.kube:ro" \
  praveenraghav/k8s-manager-ui:latest
```

Open **http://localhost:8080**.

> [!WARNING]
> Publishing to `127.0.0.1` keeps the unauthenticated API off your network. Expose it (`-p 8080:3001` / `HOST=0.0.0.0`) only behind an authenticating proxy — see [Security](#security).

<details>
<summary>Docker notes (local clusters, OIDC)</summary>

- **Local clusters** (Docker Desktop / kind / minikube) listen on `127.0.0.1`, which inside a container points at the container itself. Add `--add-host=host.docker.internal:host-gateway` and set the context's `server:` to `https://host.docker.internal:<port>` with `insecure-skip-tls-verify: true` — or just use the desktop app for local clusters.
- **OIDC clusters** (`kubectl oidc-login`): the container can't open a browser, so log in on the host first (`kubectl get nodes`) to cache a token, then mount `~/.kube` **read-write** (drop `:ro`) so kubelogin can refresh it.
- Kubeconfigs created by `aws eks update-kubeconfig`, `az aks get-credentials`, or GKE reference their own exec plugins, so those CLIs must be on `PATH` inside the container.

</details>

### From source (development)

```bash
npm install && npm install --prefix client
npm run dev         # UI on http://localhost:3000, API on :3001
```

For a single-port production run: `npm run build && npm start`, then open **http://localhost:3001**.

## Usage

1. **⌘K** (Ctrl+K) — jump to any view, cluster, or action; the toolbar's back/forward arrows retrace your steps.
2. **Pick a context** — the searchable sidebar selector switches clusters; pin favourites to the left rail.
3. **Add a cloud cluster** — the **+** button → **AWS**, **Azure**, or **GKE** discovers and merges clusters into your kubeconfig.
4. **Click a row** — opens the detail drawer (with live pod metric graphs); the **⋮** menu has Details, Logs, Terminal, Edit YAML.
5. **AI & agents** — launch from the toolbar; configure in **Preferences → AI / External Tools**.

## Connect AI agents (MCP)

The app is also an [MCP](https://modelcontextprotocol.io) server exposing the same capabilities as the UI — **~32 read tools** (contexts, resources, logs, events, topology, metrics, costs, Helm, CRDs, Argo CD, …) plus **6 write tools** (`apply_yaml`, `delete_resource`, `scale_workload`, `rollout_restart`, `sync_argocd_app`, `refresh_argocd_app`).

> [!NOTE]
> Write tools are **off by default**. Enable them in **Preferences → MCP Server → Write access**, or start with `MCP_ALLOW_WRITE=1`. Reconnect the agent to pick up the new tool set.

**HTTP** (recommended) — while the app runs, agents connect to `http://localhost:3001/mcp`:

```bash
claude mcp add --transport http k8sight http://localhost:3001/mcp
```

**Stdio** — for agents launched by command; the app must be running:

```jsonc
{
  "mcpServers": {
    "k8sight": {
      "command": "node",
      "args": ["/absolute/path/to/k8s-manager-ui/mcp-stdio.js"],
      "env": { "MCP_API_BASE": "http://127.0.0.1:3001", "MCP_ALLOW_WRITE": "0" }
    }
  }
}
```

All tools act on the **currently selected context**. Run the bridge standalone with `npm run mcp`.

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `KUBECONFIG` | Path to kubeconfig | `~/.kube/config` |
| `LLM_BASE_URL` | OpenAI-compatible endpoint for the AI assistant | — |
| `LLM_API_KEY` | API key for the assistant (also settable in Preferences → AI) | — |
| `LLM_MODEL` | Model the assistant requests | — |
| `MCP_ALLOW_WRITE` | Enable MCP write/destructive tools | `0` (read-only) |
| `MCP_API_BASE` | API base URL the stdio MCP bridge targets | `http://127.0.0.1:3001` |
| `HOST` | Interface the backend binds | `127.0.0.1` (Docker sets `0.0.0.0`) |
| `ALLOWED_ORIGINS` | Extra browser origins allowed to call `/api` and `/mcp` (comma-separated) | — |

## Security

> [!IMPORTANT]
> The API and the `/ws/exec` shell carry your kubeconfig's full read/write access with **no per-request auth**, so the backend is locked to the local machine.

- **Loopback by default** — binds `127.0.0.1`; set `HOST=0.0.0.0` only to expose it deliberately (the Docker image does this so its published port works).
- **Same-origin only** — a page on another origin can't drive the API or the exec WebSocket. Non-browser MCP clients are unaffected.
- **When exposing it**, publish to loopback and/or put an authenticating proxy in front, and add proxy origins via `ALLOWED_ORIGINS`.

## Architecture

- **Backend** (`server.js`) — Express + `@kubernetes/client-node`; REST API, a `/ws/exec` WebSocket for shells, short-TTL caches, and `kubectl`/`helm` fallbacks. In production it also serves the built UI.
- **Frontend** (`client/`) — React + Vite; same-origin `/api` + `/ws/exec`, xterm.js terminal, ⌘K palette, token-driven theming.
- **Cloud** (`aws-eks.js`, `azure-aks.js`, `gke.js` and the `*-token.js` helpers) — CLI-free EKS/AKS/GKE discovery, kubeconfig merge, and native runtime auth via bundled token helpers.
- **Security** (`trivy-scan.js`) — reads Trivy Operator reports or runs a bundled Trivy binary.
- **Desktop** (`electron/`) — Electron shell that runs the backend as a utility process and self-updates via `electron-updater`. Released macOS builds are **Developer ID–signed and notarized** by the [`Build & Release`](.github/workflows/release.yml) workflow (`after-pack.cjs` ad-hoc-signs local dev builds); all three OSes are published on a `v*.*.*` tag.

## Troubleshooting

- **"No kubeconfig loaded"** — ensure `~/.kube/config` exists or set `KUBECONFIG`.
- **Metrics show `—`** — the cluster needs **metrics-server** installed.
- **Costs show no provider** — follow the OpenCost Collector install command in Costs, or connect an existing OpenCost/Kubecost Service. The recommended Collector setup needs a default StorageClass for its initial 1 GiB, 30-day history volume (increase it for larger clusters); the kube identity needs permission to list Services and proxy requests to the cost provider Service.
- **Helm view empty** — releases are read from the cluster's Helm release Secrets, so your kube identity needs permission to list Secrets.
- **Can't install charts** — installing and upgrading run your local `helm` (v3), which must be on your `PATH` and able to reach the cluster. Chart search works without it.
- **Terminal won't open** — the target container needs a shell; distroless images won't work.
- **Costs load slowly or show no idle cost** — idle cost is fetched best-effort; on a large or busy OpenCost it's skipped so allocations still load quickly.
- **App doesn't update itself** — self-update needs a released, signed build running from Applications; local builds show a link to the Releases page instead.
- **"All namespaces" is slow the first time** — it fetches every namespace (cached afterward); pick one for faster loads.
