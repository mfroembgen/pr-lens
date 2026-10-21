# Self-hosted canvas

The Bun server and React/Vite viewer speak the PR Lens canvas protocol. SQLite stores canvases, immutable revisions, source diffs, questions, live sessions and encrypted sign-ins.

See the [self-hosting guide](../../docs/self-hosting.md) for installation, access checks, publication and recovery. The [local agent bridge](agent/README.md) answers questions over outbound HTTPS.

The server reads `PUBLIC_ORIGIN`, `PUBLISH_TOKEN`, `DATABASE_PATH`, `GITLAB_ORIGIN`, `HOST` and `PORT`. See [the chart](../../charts/pr-lens) for container deployment.
