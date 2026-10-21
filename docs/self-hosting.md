# Self-hosted canvas

This fork runs the interactive canvas on your infrastructure. It keeps the upstream graph schema, renderer and CLI protocol. The server uses Bun and SQLite; Vite builds the React viewer; tsrs compiles and checks TypeScript.

The viewer supports pan and zoom, light and dark themes, walkthroughs, payload inspection, source diffs, and live highlighting and temporary sketches. Diagrams are authored locally and published through the canvas API.

## Install with Helm

Image: `ghcr.io/mfroembgen/pr-lens:v0.1.6`. Chart: `oci://ghcr.io/mfroembgen/charts/pr-lens`, version `0.1.6`.

For the default protected mode, create a Secret through your existing secret manager. Its `token` key must contain 64 random hexadecimal characters. Keep the same value across restarts: the server derives its credential-encryption key from it.

```yaml
publicOrigin: https://lens.example.com
gitlabOrigin: https://gitlab.example.com
existingSecret: pr-lens
persistence:
  enabled: true
  storageClassName: your-block-storage-class
  size: 1Gi
ingress:
  enabled: true
  className: your-private-ingress-class
  host: lens.example.com
```

```sh
helm upgrade --install pr-lens oci://ghcr.io/mfroembgen/charts/pr-lens \
  --version 0.1.6 --namespace pr-lens --create-namespace --values values.yaml
```

The chart runs one nonroot replica with a read-only root filesystem, writable `/tmp`, and a retained PVC. `Recreate` prevents two pods competing for the database. A restart briefly interrupts connections; clients reconnect and saved state remains available.

Volume retention is not a backup. Use storage snapshots or a consistent SQLite backup stored separately. Keep the database and WAL together. Changing the publishing credential invalidates encrypted sign-ins; diagrams remain stored.

## Access

For a VPN-only installation, set `authMode: none` in Helm values, or
`AUTH_MODE=none` when running the server directly. No publishing Secret or GitLab
sign-in is needed. Anyone who can reach the server can read, change, or delete
canvases. Keep this mode behind a trusted private ingress.
Existing diagrams, revisions and diffs remain available when
switching modes. The default `protected` mode retains the checks below.

With `GITLAB_ORIGIN` configured, readers sign in using a GitLab token with `read_api` access. The browser sends it once over HTTPS. The server encrypts it in SQLite and issues an HttpOnly cookie lasting eight hours. It checks GitLab project membership before returning canvases, SVGs, diffs or answers. Private repository access requires Reporter or higher.

Canvases are bound to their project and merge request when created. A later push cannot move them. Publication requires the deployment publishing credential and the canvas write token. Keep credentials out of URLs and MR notes.

In protected mode without `GITLAB_ORIGIN`, a canvas ID is a read capability. Configure GitLab access checks for private GitLab changes; network privacy alone does not provide project permissions.

The CLI browser device flow works through `pr-lens auth login --api https://lens.example.com`. Compare the terminal code with the browser page before approval. Device codes last ten minutes. CLI account tokens last 30 days. Use `/settings` to revoke a linked machine. Device-code requests are limited to 20 per hour per socket address; behind a shared proxy that limit is shared.

## Publish locally

Generate and validate a graph with the existing PR Lens skill. Render its SVG locally, push the graph, attach its exact-commit unified diff, then post the protected preview attachment and interactive link to the MR. These operations use HTTPS APIs and need no MR pipeline.

The fork's CLI accepts:

| Variable | Purpose |
| --- | --- |
| `PR_LENS_API_URL` | Canonical server origin |
| `PR_LENS_PUBLISH_TOKEN` | Deployment publishing credential |
| `PR_LENS_GITLAB_TOKEN` | Publisher's GitLab API credential |
| `PR_LENS_GITLAB_PROJECT_ID` | Project bound to the canvas |

Credentials are sent only to that API origin. The server also accepts `X-PR-Lens-GitLab-Merge-Request-Iid` on creation. See [the canvas protocol](canvas-api.md).

Push a graph through `PUT /api/canvas/{id}` using its write bearer token and `If-Match` revision. Attach source context through `PUT /api/canvas/{id}/diff` with `{baseCommit, headCommit, unifiedDiff}`. The commits must match the graph provenance. In protected mode both writes require `X-PR-Lens-Publish-Token`; GitLab deployments also require `X-PR-Lens-GitLab-Token`. In `none` mode omit all authentication headers; `If-Match` and source validation still apply.

Use `/c/{id}?rev={revision}` in MR notes to retain the reviewed commit. `/c/{id}` follows the latest push. SVG image paths include the stored revision. A new push has no diff until its matching diff upload succeeds.

## Live interaction

Live pairing supports `canvas open`, `answer`, `show`, `fork` and `look` for a
locally controlled presentation. Sessions expire after two inactive hours.
Published revisions remain until the canvas is deleted.

## Development and releases

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run verify
mise exec -- bun run test:browser
```

The workspace pins Bun, tsrs and build tools. Existing upstream assertions remain in place. Added tests cover authorization, SQLite recovery, device grants, immutable revisions and live commands. Browser tests use the real server.

Tagging `v0.1.6` verifies and publishes an amd64/arm64 image and matching OCI chart. Application release CI is separate from local diagram generation and MR updates.

The initial viewer was adapted from [the MIT community canvas](https://github.com/jasonkneen/pr-lens-with-canvas/tree/8394968c473d2699fbde6ab33f246d9b5aff6441/packages/canvas-local). Copyright and license notices are retained. This is an independent implementation of the public protocol; the upstream hosted application is maintained separately.
