# Local question bridge

The browser saves questions on the canvas server. This process leases one question at a time, asks your configured local coding agent, and sends its answer back. It opens no listening port. The connection to the canvas server must use HTTPS.

Questions belong to a canvas, so a normal canvas link works without a live pairing. Live pairing still supports camera control, selection, `show`, and `fork`.

## Configure it

Install the repository's pinned tools with Mise and its dependencies with Bun, as described in the root README. Keep the config, write token, and answer journal outside your repository.

Create a private `bridge.json`:

```json
{
  "server": "https://canvas.example.com",
  "canvasId": "abcdefghijklmnopqrstuv",
  "repository": "/absolute/path/to/checkout",
  "repositoryOrigin": "https://git.example.com/group/project.git",
  "command": [
    "/absolute/path/to/bun",
    "/absolute/path/to/pr-lens/packages/canvas-local/agent/codex.ts",
    "/absolute/path/to/codex"
  ],
  "stateFile": "/absolute/private/path/canvas-answers.json",
  "timeoutMs": 60000,
  "pollMs": 2000
}
```

Use the exact value from `git remote get-url origin` for `repositoryOrigin`. The checkout must be clean and at the question's published head commit. A question about an older revision needs a checkout at that revision. The bridge refuses a different origin, head, or dirty checkout, and checks again before returning an answer.

For a server running `AUTH_MODE=none`, add `"authMode": "none"` to this config.
Do not supply canvas or GitLab tokens; the bridge sends no authentication headers.
The server must be reachable only through your trusted network.

For a protected server, supply credentials through your secret manager or shell environment:

- `PR_LENS_CANVAS_WRITE_TOKEN`: this canvas's write token. The bridge needs no global publisher token.
- `PR_LENS_GITLAB_TOKEN`: a GitLab token with `read_api` scope when the server uses GitLab project access checks. The account needs Reporter access or higher to the bound project.

Then run:

```bash
bun /absolute/path/to/pr-lens/packages/canvas-local/agent/runner.ts \
  --config /absolute/private/path/bridge.json
```

The Codex adapter uses your existing Codex sign-in. It runs `gpt-6.1-sol` with `xhigh` reasoning, a read-only sandbox, and an ephemeral session. It requests a structured answer and returns the final JSON without CLI logs. Its options follow the [official Codex command reference](https://learn.chatgpt.com/docs/developer-commands#codex-exec).

The bridge strips `PR_LENS_` credentials from the coding agent's environment. Question text is passed as JSON data through stdin; it never becomes an executable, argument, working directory, or shell command. Keep the configured coding agent's own tools and permissions appropriate for reading this checkout.

## Use another agent

Set `command` to an absolute executable path and fixed arguments. The bridge runs it directly with no shell, in the configured checkout. It receives one JSON prompt through stdin containing the question, the saved canvas document and revision, the reader's camera and selection context, and the exact base/head diff.

Write one JSON `LiveCommand` of kind `answer` to stdout. The question must match the input exactly. The contract is in [the schema](../../schema/src/live.ts); the bridge validates it before publishing. Write diagnostics to stderr. The bridge discards those diagnostics because they may contain source text or credentials.

Answers are journaled before acknowledgement. If the bridge loses its connection or restarts, it sends the saved answer again without invoking the local agent twice. The journal contains question answers and must stay private. Use a separate journal for each canvas and only one bridge process per config.

The server renews active leases, retries expired jobs, and caps retryable failures. The bridge caps stdout at 1 MB and command runtime at 90 seconds. A head mismatch, timeout, or invalid answer appears as a failed question in the browser. Keep the bridge running while readers ask questions; the server stores pending questions while it is offline.

## Check it

```bash
bun test packages/canvas-local/agent
bun run --filter @coldtea/pr-lens-canvas-local typecheck
```

The tests use fake local executables. They do not start a paid coding-agent session.
