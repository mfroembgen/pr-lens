#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCanvasServer } from "./server.js";

const { values } = parseArgs({ options: {
  port: { type: "string", default: process.env.PORT ?? "8080" },
  host: { type: "string", default: process.env.HOST ?? "0.0.0.0" },
  dir: { type: "string", default: join(homedir(), ".pr-lens", "local-canvas") },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
const configuredOrigin = process.env.PUBLIC_ORIGIN;
if (configuredOrigin !== undefined) {
  const url = new URL(configuredOrigin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("PUBLIC_ORIGIN must be an HTTP or HTTPS origin");
}
const web = process.env.WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "web");
const server = await createCanvasServer({
  dir: values.dir, web,
  ...(process.env.DATABASE_PATH === undefined ? {} : { dbPath: process.env.DATABASE_PATH }),
  ...(configuredOrigin === undefined ? {} : { publicOrigin: configuredOrigin }),
  ...(process.env.GITLAB_ORIGIN === undefined ? {} : { gitlabOrigin: process.env.GITLAB_ORIGIN }),
  ...(process.env.ACCOUNT_TOKEN === undefined ? {} : { accountToken: process.env.ACCOUNT_TOKEN }),
});
server.on("error", (error: NodeJS.ErrnoException) => {
  process.stderr.write(error.code === "EADDRINUSE" ? `Port ${port} is taken; choose another port\n` : "The canvas server could not start\n");
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  server.close();
  server.closeIdleConnections();
});
server.listen(port, values.host, () => {
  process.stdout.write(`PR Lens canvas listening on ${configuredOrigin ?? `http://localhost:${port}`}\n`);
});
