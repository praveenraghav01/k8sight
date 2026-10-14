# Kubernetes Manager: Marketing Website

A single-page, self-contained landing site to showcase the product publicly and
offer the macOS app and Docker image as downloads.

```
website/
├── index.html                                  # the whole site (inline CSS + JS)
└── assets/
    ├── icon.svg                                # app logo (from build/icon.svg)
    └── screenshot-dashboard.png                # dashboard screenshot
```

## Preview locally

```bash
npx serve website        # then open the printed URL
# or
python3 -m http.server 4321 -d website
```

## What's on the page

- **Hero** with the two primary CTAs: *Download for macOS* and *Run with Docker*.
- **Feature grid** covering the dashboard, workloads, shell, topology, logs,
  port-forwarding, CRDs/Helm, detail drawer and themes.
- **AI assistant** band (read-only Claude assistant).
- **Download section**:
  - macOS → **GitHub releases**
    (`https://github.com/praveenraghav01/k8sight/releases/latest`).
  - Docker commands using the image **`praveenraghav/k8s-manager-ui`**
    (copy-to-clipboard buttons).

## Updating

- **macOS release**: the download buttons point to the repo's
  `/releases/latest`. Publish the `.dmg` as a GitHub Release asset; no site
  change is needed. Update the version badge in `index.html` if you want it shown.
- **Docker image**: the pull/run commands reference
  `praveenraghav/k8s-manager-ui:latest`. Change the tag in `index.html` if needed.

## Hosting

It's fully static, so any static host works (GitHub Pages, Netlify, Cloudflare
Pages, S3 + CloudFront, nginx).
