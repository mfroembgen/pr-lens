import { afterEach, expect, test, vi } from "vitest";
import { mintCanvas } from "../src/canvas/api.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const stubServer = () => {
  const send = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json({
    id: "abcdefghijklmnopqrstuv", writeToken: "abcdefghijklmnopqrstuv", rev: 0,
    viewUrl: "https://lens.example.com/c/abcdefghijklmnopqrstuv",
    editUrl: "https://lens.example.com/c/abcdefghijklmnopqrstuv#w=abcdefghijklmnopqrstuv",
    embedUrl: "https://lens.example.com/c/abcdefghijklmnopqrstuv.svg",
  }, { status: 201 }));
  vi.stubGlobal("fetch", send);
  return send;
};

test("self-hosted credentials are scoped to the configured HTTPS origin", async () => {
  const send = stubServer();
  vi.stubEnv("PR_LENS_API_URL", "https://lens.example.com");
  vi.stubEnv("PR_LENS_PUBLISH_TOKEN", "ab".repeat(32));
  vi.stubEnv("PR_LENS_GITLAB_TOKEN", "private-test-token");
  vi.stubEnv("PR_LENS_GITLAB_PROJECT_ID", "123");
  await mintCanvas("https://lens.example.com", undefined, undefined);
  const headers = new Headers(send.mock.calls[0]?.[1]?.headers);
  expect(headers.get("x-pr-lens-publish-token")).toBe("ab".repeat(32));
  expect(headers.get("x-pr-lens-gitlab-token")).toBe("private-test-token");
  expect(headers.get("x-pr-lens-gitlab-project-id")).toBe("123");
  expect(send.mock.calls[0]?.[1]?.redirect).toBe("manual");
});

test("credentials never reach a different API origin", async () => {
  const send = stubServer();
  vi.stubEnv("PR_LENS_API_URL", "https://lens.example.com");
  vi.stubEnv("PR_LENS_PUBLISH_TOKEN", "ab".repeat(32));
  await expect(mintCanvas("https://different.example.com", undefined, undefined)).rejects.toMatchObject({ code: "CANVAS_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled();
});

test("credentials reject plaintext non-local endpoints and malformed publishing tokens", async () => {
  const send = stubServer();
  vi.stubEnv("PR_LENS_API_URL", "http://lens.example.com");
  vi.stubEnv("PR_LENS_PUBLISH_TOKEN", "ab".repeat(32));
  await expect(mintCanvas("http://lens.example.com", undefined, undefined)).rejects.toMatchObject({ code: "CANVAS_UNAVAILABLE" });
  vi.stubEnv("PR_LENS_API_URL", "https://lens.example.com");
  vi.stubEnv("PR_LENS_PUBLISH_TOKEN", "invalid");
  await expect(mintCanvas("https://lens.example.com", undefined, undefined)).rejects.toMatchObject({ code: "CANVAS_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled();
});
