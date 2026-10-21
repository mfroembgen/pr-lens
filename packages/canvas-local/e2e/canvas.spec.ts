import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { z } from "zod";
import minimal from "../../schema/examples/minimal.graph.json" with { type: "json" };
import payloadExample from "../../schema/examples/payload.graph.json" with { type: "json" };
import { GraphDoc } from "@coldtea/pr-lens-schema";

const publishing = "ab".repeat(32);
const baseCommit = "1".repeat(40);
const headCommit = "2".repeat(40);
let origin = "";
let directory = "";
let port = 0;
let child: ChildProcess | undefined;

const start = async () => {
  const environment = { ...process.env };
  delete environment.GITLAB_ORIGIN;
  delete environment.ACCOUNT_TOKEN;
  child = spawn("bun", ["dist/bin.js"], {
    cwd: process.cwd(),
    env: { ...environment, HOST: "127.0.0.1", PORT: String(port), PUBLIC_ORIGIN: origin,
      DATABASE_PATH: join(directory, "canvas.sqlite"), PUBLISH_TOKEN: publishing },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stdout?.resume();
  child.stderr?.on("data", (data: Buffer) => { diagnostic += data.toString(); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture exited: ${diagnostic}`);
    const response = await fetch(`${origin}/healthz`).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture did not start: ${diagnostic}`);
};
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pr-lens-browser-"));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  port = address.port;
  reserve.close();
  origin = `http://127.0.0.1:${port}`;
  await start();
});
test.afterAll(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

const document = (title: string, head = headCommit) => ({
  ...minimal, title,
  provenance: { ...minimal.provenance, base: { sha: baseCommit }, head: { sha: head } },
  walkthrough: { steps: [
    { id: "receive", heading: "Receive the health request", body: "The readiness endpoint receives the request.", focus: { kind: "all" } },
    { id: "respond", heading: "Return the readiness response", body: "The endpoint returns a readiness response.", focus: { kind: "all" } },
  ] },
});
const diff = (head = headCommit) => ({ baseCommit, headCommit: head,
  unifiedDiff: "diff --git a/src/routes/health.ts b/src/routes/health.ts\n--- a/src/routes/health.ts\n+++ b/src/routes/health.ts\n@@ -1 +1 @@\n-return false;\n+return true;\n" });
const mint = async (request: APIRequestContext) => {
  const response = await request.post(`${origin}/api/canvas`, { headers: { "X-PR-Lens-Publish-Token": publishing } });
  expect(response.status()).toBe(201);
  return z.object({ id: z.string(), writeToken: z.string() }).parse(await response.json());
};
const publish = async (request: APIRequestContext, canvas: { id: string; writeToken: string }, title: string, rev: number, head = headCommit) => {
  const headers = { authorization: `Bearer ${canvas.writeToken}`, "X-PR-Lens-Publish-Token": publishing, "if-match": String(rev) };
  expect((await request.put(`${origin}/api/canvas/${canvas.id}`, { headers, data: document(title, head) })).status()).toBe(200);
  expect((await request.put(`${origin}/api/canvas/${canvas.id}/diff`, { headers, data: diff(head) })).status()).toBe(200);
};

test("permalink supports walkthrough, source diff, questions, answers and crash recovery", async ({ page, request }) => {
  const canvas = await mint(request);
  await publish(request, canvas, "Readiness workflow", 0);
  await page.goto(`${origin}/c/${canvas.id}?rev=1`);
  await expect(page.locator(".title strong")).toHaveText("Readiness workflow");
  await page.getByRole("button", { name: "Walkthrough", exact: false }).click();
  await expect(page.getByText("Receive the health request", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: false }).click();
  await expect(page.getByText("Return the readiness response", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const zoom = await page.locator(".zoom").innerText();
  await page.getByTitle("Zoom in (+)").click();
  await expect(page.locator(".zoom")).not.toHaveText(zoom);
  await page.getByRole("button", { name: "Source diff", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Changed file" })).toHaveValue("src/routes/health.ts");
  await expect(page.locator(".diff-code")).toContainText("+return true;");
  await page.getByRole("button", { name: "Questions", exact: true }).click();
  const question = "Why does this endpoint return true?";
  await page.getByLabel("Question about this canvas").fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Waiting for your agent", { exact: true })).toBeVisible();
  const leased = await request.post(`${origin}/api/canvas/${canvas.id}/questions/lease`, { headers: { authorization: `Bearer ${canvas.writeToken}` }, data: {} });
  expect(leased.status()).toBe(200);
  const job = z.object({ question: z.object({ id: z.string(), lease: z.string() }) }).parse(await leased.json()).question;
  const ack = await request.post(`${origin}/api/canvas/${canvas.id}/questions/${job.id}/ack`, {
    headers: { authorization: `Bearer ${canvas.writeToken}` },
    data: { lease: job.lease, result: { kind: "answer", question, steps: [{ heading: "Readiness stays stable", focus: { kind: "all" }, paragraphs: [{ parts: [{ text: "The endpoint reports readiness to its caller." }] }] }] } },
  });
  expect(ack.status()).toBe(200);
  await page.getByRole("button", { name: "Open answer" }).click();
  await expect(page.getByText("Readiness stays stable", { exact: true })).toBeVisible();

  await stop();
  await start();
  await page.reload();
  await expect(page.locator(".title strong")).toHaveText("Readiness workflow");
  await page.getByRole("button", { name: "Questions", exact: true }).click();
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open answer" }).click();
  await expect(page.getByText("Readiness stays stable", { exact: true })).toBeVisible();

  await publish(request, canvas, "Newer readiness workflow", 1, "3".repeat(40));
  await page.reload();
  await expect(page.locator(".title strong")).toHaveText("Readiness workflow");
  await page.getByRole("button", { name: "Source diff", exact: true }).click();
  await expect(page.locator(".commits")).toContainText(headCommit);
  await page.goto(`${origin}/c/${canvas.id}`);
  await expect(page.locator(".title strong")).toHaveText("Newer readiness workflow");
  if (process.env.PR_LENS_TEST_SCREENSHOT) await page.screenshot({ path: process.env.PR_LENS_TEST_SCREENSHOT });
});

test("paired live commands open real payload details", async ({ page, request }) => {
  const canvas = await mint(request);
  const graph = GraphDoc.parse(payloadExample);
  const headers = { authorization: `Bearer ${canvas.writeToken}`, "X-PR-Lens-Publish-Token": publishing, "if-match": "0" };
  expect((await request.put(`${origin}/api/canvas/${canvas.id}`, { headers, data: graph })).status()).toBe(200);
  const live = z.object({ session: z.string(), url: z.string() }).parse(await (await request.post(`${origin}/api/canvas/${canvas.id}/live`, { headers: { authorization: `Bearer ${canvas.writeToken}` } })).json());
  await page.goto(live.url);
  await expect(page.locator(".title strong")).toHaveText(graph.title);
  const message = graph.flows.flatMap((flow) => flow.messages.map((item) => ({ flow: flow.id, message: item }))).find((item) => item.message.payload?.request !== undefined);
  if (!message) throw new Error("Payload fixture has no request");
  const response = await request.post(`${origin}/api/canvas/${canvas.id}/live/${live.session}`, {
    headers: { authorization: `Bearer ${canvas.writeToken}` },
    data: { kind: "show", focus: { kind: "all" }, open: { message: `${message.flow}/${message.message.id}` } },
  });
  expect(response.status()).toBe(200);
  await expect(page.locator(".payload h3")).toHaveText(message.message.label);
  await expect(page.locator(".payload").getByRole("button", { name: "Request", exact: true })).toBeVisible();
  await expect(page.locator(".payload .type")).toHaveText(message.message.payload?.request?.type ?? "");
});

test("device approval requires comparing the terminal code", async ({ page }) => {
  const user = { id: 123, name: "Example User", username: "example" };
  let approved = false;
  await page.route("**/api/access", (route) => route.fulfill({ json: { auth: "gitlab", gitlabOrigin: "https://gitlab.example.com", publisherRequired: true, accounts: true } }));
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user } }));
  await page.route("**/api/device?*", (route) => route.fulfill({ json: { user_code: "ABCD-EFGH", name: "Example laptop", client: "pr-lens-cli/0.13.2", status: "pending", expiresAt: Date.now() + 600000 } }));
  await page.route("**/api/device/approve", async (route) => { approved = true; await route.fulfill({ json: { ok: true } }); });
  await page.goto(`${origin}/device?user_code=ABCD-EFGH`);
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve machine", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "The code matches my terminal" }).check();
  await page.getByRole("button", { name: "Approve machine", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Machine approved");
  expect(approved).toBe(true);
});
