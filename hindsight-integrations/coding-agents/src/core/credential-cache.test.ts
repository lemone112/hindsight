import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, type RawConfig } from "./config";
import { buildHookOutput, runHook } from "./hook";
import { HindsightClient } from "./hindsight";
import { RuntimeCore } from "./runtime";
import { diag } from "./diag";
import { runSessionStartHook } from "./session-start";
import { memoryScopeFingerprint, sessionCacheFile, writeSessionCache } from "./session-cache";
import { HOOK_HARNESSES } from "../harness/hook-lifecycle";

let stdin = "";
let rawConfig: RawConfig;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (path: unknown, ...args: unknown[]) =>
    path === 0 ? stdin : (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...args) };
});
vi.mock("./config", async (original) => {
  const config = await original<typeof import("./config")>();
  return { ...config, loadConfig: () => config.resolveConfig(rawConfig) };
});
vi.mock("./skill-sync", () => ({ syncCompanionSkill: vi.fn() }));
vi.mock("./auto-update", () => ({ maybeAutoUpdate: vi.fn() }));
vi.mock("./daemon", () => ({ ensureDaemon: vi.fn(), DAEMON_WAIT_SESSION_START_MS: 0 }));
vi.mock("./git", async (original) => ({
  ...await original<typeof import("./git")>(), hasGitHistory: () => true,
}));
vi.mock("./seed", async (original) => ({
  ...await original<typeof import("./seed")>(), startBackgroundSeed: vi.fn(),
}));
vi.mock("./diag", async (original) => ({
  ...await original<typeof import("./diag")>(), diag: vi.fn(),
}));

const A = "synthetic-key-a";
const B = "synthetic-key-b";
const FACT_A = "SYNTHETIC_FACT_A: accepted GET retries were two.";
const FACT_B = "SYNTHETIC_FACT_B: accepted GET retries were three.";
let root: string;
let session: string;
let desired: string | undefined;
let accepted: string | undefined;
let calls: { url: string; identity: string | undefined }[];
let onFetch: ((url: string, identity: string | undefined) => Promise<Response | undefined> | undefined) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "hs-credential-cache-"));
  session = root.split(/[\\/]/).pop()!;
  rawConfig = { serverMode: "self-hosted", apiUrl: "http://synthetic.invalid", apiToken: A,
    bankId: "test-bank", autoSeed: false, autoUpdate: false, autoInject: "pages", pageRefreshEveryTurns: 0 };
  desired = accepted = A;
  calls = [];
  onFetch = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    const identity = auth?.replace(/^Bearer /, "");
    calls.push({ url: String(url), identity });
    const response = await onFetch?.(String(url), identity);
    if (response) return response;
    if (identity !== accepted) return new Response("{}", { status: 401 });
    const fact = identity === A ? FACT_A : FACT_B;
    return Response.json(String(url).includes("/search?")
      ? { results: [{ id: "p", name: "Decision", snippet: fact, score: 1 }] }
      : { roots: [{ id: "p", name: "Decision", kind: "page" }] });
  }));
});
afterEach(() => {
  vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  for (const suffix of [".json", ".root"])
    rmSync(sessionCacheFile("claude-code", session).replace(/\.json$/, suffix), { force: true });
  for (const suffix of [".json", ".root", ".pending"])
    rmSync(sessionCacheFile("grok-build", session).replace(/\.json$/, suffix), { force: true });
});
function client() {
  return new HindsightClient({ apiUrl: resolveConfig(rawConfig).apiUrl, apiToken: A,
    bank: "test-bank", tokenProvider: () => desired });
}
const cache = () => sessionCacheFile("claude-code", session);
const prompt = (c: HindsightClient) => buildHookOutput({ harness: "claude-code", prompt: "Read accepted facts",
  cfg: resolveConfig(rawConfig), client: c, cacheFile: cache() });
async function compact(c: HindsightClient) {
  stdin = JSON.stringify({ cwd: root, session_id: session, source: "compact" });
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runSessionStartHook(HOOK_HARNESSES["claude-code"].sessionStart, () => c);
  const raw = write.mock.calls.map(([value]) => String(value)).join("");
  write.mockRestore();return JSON.parse(raw);
}
const context = (out: any): string => out.hookSpecificOutput?.additionalContext ?? "";
async function grok(event: Record<string, unknown>) {
  stdin = JSON.stringify({ cwd: root, sessionId: session, ...event });
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runHook(HOOK_HARNESSES["grok-build"].prompt);
  const raw = write.mock.calls.map(([value]) => String(value)).join("");
  write.mockRestore();return raw ? JSON.parse(raw) : {};
}

describe("effective credential cache", () => {
  it("invalidates cached A after the actual client's 401 refresh to B with cfg still A", async () => {
    const c = client();expect((await prompt(c)).context).toContain(FACT_A);
    desired = accepted = B;
    await c.req("GET", c.bankUrl("/probe"));
    expect(c.apiToken).toBe(B);expect(rawConfig.apiToken).toBe(A);
    expect(calls.slice(-2).map(call => call.identity)).toEqual([A, B]);
    const out = await prompt(c);
    expect(out.context).toContain(FACT_B);
    expect(out.context).not.toContain(FACT_A);
  });
  it("preserves the guard and factual replay with a stable effective credential", async () => {
    const c = client();await prompt(c);
    const searches = calls.filter(call => call.url.includes("/search?")).length;
    expect((await prompt(c)).context).not.toContain(FACT_A);
    expect(calls.filter(call => call.url.includes("/search?")).length).toBe(searches);
    expect(context(await compact(c))).toContain(FACT_A);
  });
  it("preserves a stable factual cache across actual client reconstruction", async () => {
    await prompt(client());const searches = calls.filter(call => call.url.includes("/search?")).length;
    const restarted = client();
    expect((await prompt(restarted)).context).not.toContain(FACT_A);
    expect(calls.filter(call => call.url.includes("/search?")).length).toBe(searches);
    expect(context(await compact(restarted))).toContain(FACT_A);
  });
  it("treats an effective anonymous client as anonymous even while cfg still has A", async () => {
    await prompt(client());desired = accepted = undefined;
    const anonymous = new HindsightClient({ apiUrl: resolveConfig(rawConfig).apiUrl, bank: "test-bank" });
    expect(anonymous.apiToken).toBeUndefined();
    const out = await prompt(anonymous);
    expect(out.context).toContain(FACT_B);expect(out.context).not.toContain(FACT_A);
  });
  it("rejects a retrieval that refreshed the actual credential during its await", async () => {
    const c = client();desired = accepted = B;
    const out = await prompt(c);
    expect(c.apiToken).toBe(B);
    expect(out.context).toBeUndefined();
    expect(out.notice).toContain("scope changed");
    const stored = JSON.parse(readFileSync(cache(), "utf8"));
    expect(stored.reflectAnswer).toBeUndefined();expect(stored.reflectAttempts).toBeUndefined();
    expect(stored.pages).toBeUndefined();
    expect((await prompt(c)).context).toContain(FACT_B);
  });
  it("does not restore A when SessionStart listPages refreshes the client to B", async () => {
    const c = client();await prompt(c);desired = accepted = B;
    const out = await compact(c);
    expect(c.apiToken).toBe(B);
    expect(context(out)).not.toContain(FACT_A);
    expect(out.systemMessage).toContain("scope changed");
  });
  it("discards an A response if another actual request changes the client to B while it is pending", async () => {
    const c = client();let started!: () => void;let release!: () => void;
    const pending = new Promise<void>(r => release = r);
    const reached = new Promise<void>(r => started = r);
    onFetch = async (url, identity) => {
      if (!url.includes("/search?")) return undefined;
      expect(identity).toBe(A);started();await pending;
      return Response.json({ results: [{ id: "p", name: "Decision A", snippet: FACT_A }] });
    };
    const work = prompt(c);await reached;
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe"));release();
    const out = await work;
    expect(out.context).toBeUndefined();expect(out.notice).toContain("scope changed");
    expect(JSON.parse(readFileSync(cache(), "utf8")).reflectAnswer).toBeUndefined();
  });
  it("rejects actual 401 ABA refresh during an await even when the final token is A", async () => {
    const c = client();let started!: () => void;let release!: () => void;
    const pending = new Promise<void>(r => release = r);
    const reached = new Promise<void>(r => started = r);
    onFetch = async (url) => {
      if (!url.includes("/search?")) return undefined;
      started();await pending;
      return Response.json({ results: [{ id: "p", name: "Decision A", snippet: FACT_A }] });
    };
    const work = prompt(c);await reached;
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe-b"));
    desired = accepted = A;await c.req("GET", c.bankUrl("/probe-a"));release();
    expect(c.apiToken).toBe(A);
    const out = await work;
    expect(out.context).toBeUndefined();expect(out.notice).toContain("scope changed");
    expect(JSON.parse(readFileSync(cache(), "utf8")).reflectAttempts).toBeUndefined();
    onFetch = undefined;expect((await prompt(c)).context).toContain(FACT_A);
  });
  it("does not transfer a cold decision after actual credential refresh", async () => {
    rawConfig = { ...rawConfig, autoSeed: true, codebaseSurvey: false };
    const c = client();c.listDocumentIds = vi.fn(async () => new Set<string>());c.hasDocuments = vi.fn(async () => false);
    const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.seedIfCold(root);
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe"));
    await runtime.onPrompt(session, "Read accepted facts");
    expect(runtime.getInjection(session)).toContain(FACT_B);
  });
  it("does not transfer a cold decision after actual ABA refresh", async () => {
    rawConfig = { ...rawConfig, autoSeed: true, codebaseSurvey: false };
    const c = client();c.listDocumentIds = vi.fn(async () => new Set<string>());c.hasDocuments = vi.fn(async () => false);
    const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.seedIfCold(root);
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe-b"));
    desired = accepted = A;await c.req("GET", c.bankUrl("/probe-a"));
    await runtime.onPrompt(session, "Read accepted facts");
    expect(runtime.getInjection(session)).toContain(FACT_A);
  });
  it("preserves a stable cold decision for exactly the first prompt", async () => {
    rawConfig = { ...rawConfig, autoSeed: true, codebaseSurvey: false };
    const c = client();c.listDocumentIds = vi.fn(async () => new Set<string>());c.hasDocuments = vi.fn(async () => false);
    const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.seedIfCold(root);await runtime.onPrompt(session, "Read accepted facts");
    expect(runtime.getInjection(session)).not.toContain(FACT_A);
    await runtime.onPrompt(session, "Read accepted facts again");
    expect(runtime.getInjection(session)).toContain(FACT_A);
  });
  it("refuses pending runtime delivery after actual ABA refresh", async () => {
    const c = client();const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.onPrompt(session, "Read accepted facts");
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe-b"));
    desired = accepted = A;await c.req("GET", c.bankUrl("/probe-a"));
    expect(runtime.getInjection(session)).toBeUndefined();
  });
  it("restores the exact same-scope answer after compact and client reconstruction without retrieval", async () => {
    const c = client();const cfg = resolveConfig(rawConfig);
    const runtime = new RuntimeCore(c, "test-bank", cfg, "claude-code", root);
    await runtime.onPrompt(session, "Read accepted facts");
    const original = runtime.getInjection(session)!;
    expect(runtime.getContextMemory(session, [original])).toBeUndefined();
    const before = calls.length;
    const restored = runtime.getContextMemory(session, ["incomplete summary"]);
    expect(restored).toContain(FACT_A);
    expect(restored).toContain("no new memory query");
    expect(runtime.getContextMemory(session, [restored!])).toBeUndefined();
    const restarted = new RuntimeCore(client(), "test-bank", cfg, "claude-code", root);
    expect(restarted.getContextMemory(session, ["incomplete summary"])).toContain(FACT_A);
    expect(calls).toHaveLength(before);
  });
  it("does not restore another bank, endpoint or effective credential's answer", async () => {
    const c = client();const cfg = resolveConfig(rawConfig);
    const runtime = new RuntimeCore(c, "test-bank", cfg, "claude-code", root);
    await runtime.onPrompt(session, "Read accepted facts");
    for (const opts of [{ apiUrl: c.apiUrl, bank: "other-bank" }, { apiUrl: "http://other.invalid", bank: c.bank }]) {
      const foreign = new HindsightClient({ ...opts, apiToken: A });
      expect(new RuntimeCore(foreign, opts.bank, cfg, "claude-code", root).getContextMemory(session, [])).toBeUndefined();
    }
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe"));
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    expect(new RuntimeCore(c, "test-bank", cfg, "claude-code", root).getContextMemory(session, [])).toBeUndefined();
    await runtime.onPrompt(session, "Read accepted facts again");
    expect(runtime.getContextMemory(session, [])).toContain(FACT_B);
  });
  it("refuses late ABA context delivery even after the pending prompt block was removed", async () => {
    const c = client();const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.onPrompt(session, "Read accepted facts");
    desired = accepted = B;await c.req("GET", c.bankUrl("/probe-b"));
    desired = accepted = A;await c.req("GET", c.bankUrl("/probe-a"));
    expect(runtime.getInjection(session)).toBeUndefined();
    expect(runtime.getContextMemory(session, ["incomplete summary"])).toBeUndefined();
  });
  it("keeps unchanged-key 401 denied after public 200 and recovers on accepted own-bank access", async () => {
    const c = client();const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.onPrompt(session, "Read accepted facts");
    accepted = B;await expect(c.req("GET", c.bankUrl("/probe"))).rejects.toThrow(/401/);
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    onFetch = (url) => url.endsWith("/health") || url.endsWith("/version") || url.endsWith("/mcp")
      ? Promise.resolve(Response.json({ public: true })) : undefined;
    for (const suffix of ["/health", "/version", "/mcp"]) await c.req("GET", c.apiUrl + suffix);
    expect(c.credentialRejected).toBe(true);
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    accepted = A;await c.req("GET", c.bankUrl("/probe-recovered"));
    expect(c.credentialRejected).toBe(false);
    expect(runtime.getContextMemory(session, [])).toContain(FACT_A);
  });
  it("blocks pending prompt delivery after same-key search 200 then roster 401 and permits protected recovery", async () => {
    const c = client();const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    onFetch = (url) => url.endsWith("/knowledge-base/tree")
      ? Promise.resolve(new Response("{}", { status: 401 })) : undefined;
    await runtime.onPrompt(session, "Read accepted facts");
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/default/banks/test-bank/knowledge-base/search", "/v1/default/banks/test-bank/knowledge-base/tree",
    ]);
    expect(c.credentialRevision).toBe(0);
    expect(c.credentialRejected).toBe(true);
    expect(runtime.getInjection(session)).toBeUndefined();
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    onFetch = (url) => url.endsWith("/health") || url.endsWith("/version") || url.endsWith("/mcp")
      ? Promise.resolve(Response.json({ public: true })) : undefined;
    for (const suffix of ["/health", "/version", "/mcp"]) await c.req("GET", c.apiUrl + suffix);
    expect(c.credentialRejected).toBe(true);
    expect(runtime.getInjection(session)).toBeUndefined();
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    onFetch = undefined;await c.req("GET", c.bankUrl("/knowledge-base/tree"));
    expect(c.credentialRejected).toBe(false);
    const beforeDelivery = calls.length;
    expect(runtime.getInjection(session)).toContain(FACT_A);
    expect(runtime.getContextMemory(session, [])).toContain(FACT_A);
    expect(calls).toHaveLength(beforeDelivery);
  });
  it("a delayed old success cannot clear a later known own-bank rejection", async () => {
    const c = client();const runtime = new RuntimeCore(c, "test-bank", resolveConfig(rawConfig), "claude-code", root);
    await runtime.onPrompt(session, "Read accepted facts");
    let started!: () => void, release!: () => void;
    const reached = new Promise<void>(r => started = r), pending = new Promise<void>(r => release = r);
    onFetch = async (url) => {
      if (!url.endsWith("/slow-success")) return undefined;
      started();await pending;return Response.json({ accepted: true });
    };
    const old = c.req("GET", c.bankUrl("/slow-success"));await reached;
    accepted = B;await expect(c.req("GET", c.bankUrl("/denied"))).rejects.toThrow(/401/);
    release();await old;
    expect(c.credentialRejected).toBe(true);
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
  });
  it("does not restore disabled, unresolved, empty, legacy or malformed context cache", async () => {
    const c = client();const cfg = resolveConfig(rawConfig);
    const runtime = new RuntimeCore(c, "test-bank", cfg, "claude-code", root);
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    await runtime.onPrompt(session, "Read accepted facts");
    for (const value of [undefined, "", "   "]) {
      writeSessionCache(cache(), { memoryScope: memoryScopeFingerprint(cfg, c.bank, c.apiUrl, c), reflectAnswer: value });
      expect(runtime.getContextMemory(session, [])).toBeUndefined();
    }
    writeSessionCache(cache(), { reflectAnswer: FACT_A });
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    writeSessionCache(cache(), { memoryScope: memoryScopeFingerprint(cfg, c.bank, c.apiUrl, c), reflectAnswer: 42 } as never);
    expect(runtime.getContextMemory(session, [])).toBeUndefined();
    writeSessionCache(cache(), { memoryScope: memoryScopeFingerprint(cfg, c.bank, c.apiUrl, c), reflectAnswer: FACT_A });
    expect(new RuntimeCore(c, "test-bank", resolveConfig({ ...rawConfig, autoInject: "none" }), "claude-code", root).getContextMemory(session, [])).toBeUndefined();
    vi.stubEnv("HINDSIGHT_DISABLE_HOOKS", "1");expect(runtime.getContextMemory(session, [])).toBeUndefined();
  });
  it("does not record a reflect answer as delivered if the later roster await changes credential", async () => {
    rawConfig = { ...rawConfig, autoInject: "reflect" };
    const c = client();c.reflect = vi.fn(async () => FACT_A);
    desired = accepted = B;
    const out = await prompt(c);
    expect(out.context).toBeUndefined();expect(out.notice).toContain("scope changed");
    expect(vi.mocked(diag).mock.calls.some(([, event, detail]) =>
      event === "reflect_ok" || JSON.stringify(detail).includes(FACT_A))).toBe(false);
  });
  it("does not deliver pending A through the supported Grok tool hook after cfg changes to B", async () => {
    await grok({ prompt: "Read accepted facts", hook_event_name: "UserPromptSubmit" });
    rawConfig.apiToken = B;desired = accepted = B;
    const before = calls.length;
    expect(context(await grok({ hook_event_name: "PostToolUse" }))).not.toContain(FACT_A);
    expect(calls.length).toBe(before);
    expect(vi.mocked(diag).mock.calls.some(([, event]) => event === "pending_context_invalidated")).toBe(true);
  });
  it("delivers same-scope pending Grok context exactly once without memory GET", async () => {
    await grok({ prompt: "Read accepted facts", hook_event_name: "UserPromptSubmit" });
    const before = calls.length;
    expect(context(await grok({ hook_event_name: "PostToolUse" }))).toContain(FACT_A);
    expect(context(await grok({ hook_event_name: "PostToolUse" }))).not.toContain(FACT_A);
    expect(calls.length).toBe(before);
  });
});
