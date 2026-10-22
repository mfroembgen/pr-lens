# Self-hosted canvas

This fork runs the interactive canvas on your infrastructure. It keeps the upstream graph schema, renderer and CLI protocol. The server uses Bun and SQLite; Vite builds the React viewer; tsrs compiles and checks TypeScript.

The viewer supports pan and zoom, light and dark themes, walkthroughs, payload inspection, source diffs, and live highlighting and temporary sketches. Diagrams are authored locally and published through the canvas API.

## Install with Helm

Image: `ghcr.io/mfroembgen/pr-lens:v0.1.10`. Chart: `oci://ghcr.io/mfroembgen/charts/pr-lens`, version `0.1.10`.

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
  --version 0.1.10 --namespace pr-lens --create-namespace --values values.yaml
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

Download `pr-lens-cli-<os>-<arch>.tar.gz` from the [v0.1.10 release](https://github.com/mfroembgen/pr-lens/releases/tag/v0.1.10), choosing `macos` or `linux` and `arm64` or `x64`. Verify it against `SHA256SUMS`, extract it, and put `pr-lens` on your path. The executable includes its runtime, renderer, schema, and agent manual; Bun and Node are not required. Linux builds use glibc. Git is required for commands that inspect or publish repository changes. Run `pr-lens skill` to load the authoring instructions.

`publish` targets a self-hosted server with `authMode: none`. The agent chooses GitLab MCP or `glab` for GitLab operations; it uses a fallback when its selected transport lacks an operation such as attachment upload. Keep GitLab credentials with that transport.

Before publishing, read the authenticated GitLab identity and MR, confirm the project is private and `enforce_auth_checks_on_uploads` is `true`, and record its description, exact `diff_refs.base_sha`, and head SHA. Review that committed diff locally and author a graph with matching repository, base, and head provenance. Keep generated files in an ignored directory.

```sh
pr-lens publish .pr-lens/graph.json \
  --api https://lens.example.com \
  --mr https://gitlab.example.com/group/project/-/merge_requests/42 \
  --project-id 123 --repo /path/to/checkout \
  --base <full-mr-merge-base-sha> --head <full-mr-head-sha> \
  --out /path/to/checkout/.pr-lens/publication
```

For an existing publication, recover its canvas from the marked MR preview or local `publication.json`, inspect the remote graph and revision, and pass `--canvas <id> --rev <revision>`. Resolve conflicting state before publishing. A missing local receipt is not a reason to replace an existing MR canvas.

The CLI verifies local HEAD and graph provenance, renders a dark SVG, and publishes the graph with its committed unified diff and 40 lines of context. It checks the diff at the pinned revision before writing a receipt with `status: "published"`. The receipt's `preview` is the SVG path and `viewer` is the interactive URL. On a partial failure, the receipt keeps the canvas ID and last known revision; inspect the remote state before retrying an interrupted write or revision conflict.

After publication succeeds, upload `preview` as a GitLab project attachment and save the full upload response as JSON. Reread the MR before changing its description: the head and base must still match, and the managed PR Lens block must equal the block captured at the start. Preserve the latest manual description text in `current-description.md`.

```sh
pr-lens publish description \
  --publication .pr-lens/publication/publication.json \
  --upload .pr-lens/upload.json \
  --description .pr-lens/current-description.md \
  --out .pr-lens/updated-description.md
```

Write the resulting description through the chosen GitLab transport and verify the description and commit SHAs by readback. The formatter maintains one marked block at the end, preserving manual text. Its SVG links to the pinned interactive revision. GitLab has no atomic conditional description update, so coordinate concurrent writers.

### Source-diff API

Custom clients push a graph through `PUT /api/canvas/{id}` with `If-Match` set to the inspected revision. Use the successful graph response's new `rev` as `If-Match` on `PUT /api/canvas/{id}/diff`, with `{baseCommit, headCommit, unifiedDiff}`. The server attaches the diff only to that revision and returns its `rev`; a stale revision returns HTTP 409. Commits must match the graph provenance. Fetch `/api/canvas/{id}/diff?rev={revision}` to verify the stored diff.

In protected mode, graph and diff writes require the canvas write bearer token and `X-PR-Lens-Publish-Token`; GitLab deployments also require `X-PR-Lens-GitLab-Token`. In `none` mode omit authentication headers. Use `/c/{id}?rev={revision}` for a reviewed commit; `/c/{id}` follows the latest push. A new graph revision has no diff until its matching upload succeeds. See [the canvas protocol](canvas-api.md) for other operations.

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

Tagging `v0.1.10` verifies and publishes an amd64/arm64 image, a matching OCI chart, and standalone CLI binaries for macOS and Linux on ARM64 and x64. Each CLI archive is extracted and checked on its native platform without Bun or Node on its path. Application release CI is separate from local diagram generation and MR updates.

The initial viewer was adapted from [the MIT community canvas](https://github.com/jasonkneen/pr-lens-with-canvas/tree/8394968c473d2699fbde6ab33f246d9b5aff6441/packages/canvas-local). Copyright and license notices are retained. This is an independent implementation of the public protocol; the upstream hosted application is maintained separately.
