import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, type RawConfig } from "./config";
import { buildHookOutput } from "./hook";
import { runSessionStartHook } from "./session-start";
import { sessionCacheFile } from "./session-cache";
import { memoryScopeFingerprint } from "./session-cache";
import { HOOK_HARNESSES } from "../harness/hook-lifecycle";
import { HindsightClient, type ClientOpts } from "./hindsight";

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

const FACT = "SYNTHETIC_ACCEPTED_GET_RETRIES_71A9: at most two retries.";
let root: string;
let session: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hs-compact-"));
  session = root.split(/[\\/]/).pop()!;
  rawConfig = { serverMode: "self-hosted", apiUrl: "http://127.0.0.1:8888", apiToken: "synthetic-agent-key",
    bankId: "configured-bank", autoSeed: false, autoUpdate: false, autoInject: "reflect",
    banks: { "configured-bank": { bank: "actual-bank" } } };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  for (const harness of ["claude-code", "codex"])
    for (const suffix of [".json", ".root"])
      rmSync(sessionCacheFile(harness, session).replace(/\.json$/, suffix), { force: true });
});

const promptClient = (bank = "actual-bank") => ({ bank,
  apiUrl: new HindsightClient({ apiUrl: resolveConfig(rawConfig).apiUrl, bank }).apiUrl,
  reflect: vi.fn(async () => FACT),
  listPages: vi.fn(async () => ({ items: [{ id: "p1", name: "Decision" }] })),
  searchKnowledgePages: vi.fn(async () => []), recallObservations: vi.fn(async () => []) });
async function firstPrompt(harness = "claude-code") {
  const cfg = resolveConfig(rawConfig);
  const client = promptClient();
  const out = await buildHookOutput({ harness, prompt: "Apply the accepted retry decision", cfg, client,
    cacheFile: sessionCacheFile(harness, session) });
  expect(out.context).toContain(FACT);
  return client;
}
async function compact(harness: "claude-code" | "codex" = "claude-code", source = "compact") {
  stdin = JSON.stringify({ cwd: root, session_id: session, source });
  const client = { listDocumentIds: vi.fn(async () => new Set<string>()),
    listPages: vi.fn(async () => ({ items: [{ id: "p2", name: "New roster" }] })) };
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const makeClient = vi.fn((opts: ClientOpts) => ({ ...client, apiUrl: new HindsightClient(opts).apiUrl }));
  await runSessionStartHook(HOOK_HARNESSES[harness].sessionStart, makeClient);
  const stdout = write.mock.calls.map(([value]) => String(value)).join("");
  write.mockRestore();
  return { out: stdout ? JSON.parse(stdout) : {}, client, makeClient };
}
const context = (out: any): string => out.hookSpecificOutput?.additionalContext ?? "";

describe("native compact cached memory", () => {
  it.each(["claude-code", "codex"] as const)("%s restores factual context before a prompt, with no retrieval", async (harness) => {
    await firstPrompt(harness);
    const { out, client, makeClient } = await compact(harness);
    expect(context(out)).toContain(FACT);
    expect(context(out)).toContain("<hindsight_memory>");
    expect(context(out)).toContain("record of the PAST");
    expect(context(out)).toContain("1 knowledge page covers");
    expect(client.listPages).toHaveBeenCalledTimes(1);
    expect(client.listDocumentIds).not.toHaveBeenCalled();
    expect(makeClient.mock.calls[0][0].bank).toBe("actual-bank");
  });
  it("preserves exact native source and does not replay on ordinary resume", async () => {
    await firstPrompt();
    const spec = HOOK_HARNESSES["claude-code"].sessionStart;
    expect(spec.parse({ source: "compact" })).toMatchObject({ source: "compact" });
    expect(context((await compact("claude-code", "resume")).out)).not.toContain(FACT);
  });
  it.each(["apiToken", "apiUrl", "daemonProfile", "recallOptions", "observationScopes"] as const)("invalidates retrieval guard when %s changes", async (field) => {
    if (field === "daemonProfile") rawConfig.serverMode = "daemon";
    await firstPrompt();
    rawConfig = { ...rawConfig, [field]: field === "recallOptions" ? { tags: ["another-scope"] } :
      field === "observationScopes" ? "per_source" : "changed-synthetic-value" };
    const cfg = resolveConfig(rawConfig);
    const client = promptClient();
    await buildHookOutput({ harness: "claude-code", prompt: "Continue", cfg, client,
      cacheFile: sessionCacheFile("claude-code", session) });
    expect(client.reflect).toHaveBeenCalledTimes(1);
  });
  it("does not restore another credential's cache and permits the next prompt to retrieve", async () => {
    await firstPrompt();
    rawConfig.apiToken = "synthetic-other-agent-key";
    const { out } = await compact();
    expect(context(out)).not.toContain(FACT);
    expect(out.systemMessage).toContain("memory not restored");
    const client = promptClient();
    await buildHookOutput({ harness: "claude-code", prompt: "Continue", cfg: resolveConfig(rawConfig), client,
      cacheFile: sessionCacheFile("claude-code", session) });
    expect(client.reflect).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "{", "null", JSON.stringify({ reflectAnswer: FACT }),
    JSON.stringify({ reflectAnswer: 42 }), JSON.stringify({ reflectAnswer: "" })])("reports unavailable cache without claiming restoration: %s", async (body) => {
    const file = sessionCacheFile("claude-code", session);
    if (body !== undefined) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, body); }
    const { out } = await compact();
    expect(context(out)).not.toContain(FACT);
    expect(out.systemMessage).toContain("memory not restored");
  });
  it.each([{ disabled: true }, { optInOnly: true }, { banks: { "configured-bank": { disabled: true } } }])("keeps the configured gates closed: %j", async (gate) => {
    await firstPrompt();
    rawConfig = { ...rawConfig, ...gate };
    const { out, makeClient } = await compact();
    expect(out).toEqual({});
    expect(makeClient).not.toHaveBeenCalled();
  });
  it("does not keep credentials in the cache", async () => {
    await firstPrompt();
    const raw = readFileSync(sessionCacheFile("claude-code", session), "utf8");
    expect(raw).not.toContain("synthetic-agent-key");
  });
  it.each(["", "   ", undefined])("reports an empty or unresolved same-scope cache: %s", async (answer) => {
    await firstPrompt();
    const file = sessionCacheFile("claude-code", session);
    const cached = JSON.parse(readFileSync(file, "utf8"));
    cached.reflectAnswer = answer;
    writeFileSync(file, JSON.stringify(cached));
    const { out } = await compact();
    expect(context(out)).not.toContain(FACT);
    expect(out.systemMessage).toContain(answer === undefined ? "unresolved" : "empty");
  });
  it("keeps tool-only mode free of cached factual injection", async () => {
    await firstPrompt();
    rawConfig.autoInject = "none";
    const { out } = await compact();
    expect(context(out)).not.toContain(FACT);
    expect(out.systemMessage).toContain("auto_inject_off");
  });
  it("rejects another resolved bank, then allows a prompt in that bank", async () => {
    await firstPrompt();
    rawConfig.banks = { "configured-bank": { bank: "other-bank" } };
    const { out } = await compact();
    expect(context(out)).not.toContain(FACT);
    expect(out.systemMessage).toContain("scope_mismatch");
    const client = promptClient("other-bank");
    await buildHookOutput({ harness: "claude-code", prompt: "Continue", cfg: resolveConfig(rawConfig), client,
      cacheFile: sessionCacheFile("claude-code", session) });
    expect(client.reflect).toHaveBeenCalledTimes(1);
  });
  it("rejects endpoints whose actual client targets differ by a trailing slash", async () => {
    rawConfig.apiUrl = "http://127.0.0.1:8888/team/";
    await firstPrompt();
    const old = new HindsightClient({ apiUrl: rawConfig.apiUrl, bank: "actual-bank" });
    rawConfig.apiUrl += "/";
    const current = new HindsightClient({ apiUrl: rawConfig.apiUrl, bank: "actual-bank" });
    expect(current.bankUrl("/reflect")).not.toBe(old.bankUrl("/reflect"));
    const { out } = await compact();
    expect(context(out)).not.toContain(FACT);
    expect(out.systemMessage).toContain("scope_mismatch");
    const client = promptClient();
    await buildHookOutput({ harness: "claude-code", prompt: "Continue", cfg: resolveConfig(rawConfig), client,
      cacheFile: sessionCacheFile("claude-code", session) });
    expect(client.reflect).toHaveBeenCalledTimes(1);
  });
  it("preserves cache for equivalent actual client targets", async () => {
    rawConfig.apiUrl = "http://127.0.0.1:8888/team/";
    await firstPrompt();
    const old = new HindsightClient({ apiUrl: rawConfig.apiUrl, bank: "actual-bank" });
    rawConfig.apiUrl = "http://127.0.0.1:8888/team";
    const current = new HindsightClient({ apiUrl: rawConfig.apiUrl, bank: "actual-bank" });
    expect(current.bankUrl("/reflect")).toBe(old.bankUrl("/reflect"));
    expect(context((await compact()).out)).toContain(FACT);
    const client = promptClient();
    await buildHookOutput({ harness: "claude-code", prompt: "Continue", cfg: resolveConfig(rawConfig), client,
      cacheFile: sessionCacheFile("claude-code", session) });
    expect(client.reflect).not.toHaveBeenCalled();
  });
  it("never lets an unbound legacy cold marker suppress a changed warm bank", async () => {
    const file = sessionCacheFile("claude-code", session);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ deferInitialReflect: true }));
    rawConfig.banks = { "configured-bank": { bank: "other-bank" } };
    const { out } = await compact();
    expect(out.systemMessage).toContain("legacy");
    const client = promptClient("other-bank");
    const first = await buildHookOutput({ harness: "claude-code", prompt: "Read this warm bank",
      cfg: resolveConfig(rawConfig), client, cacheFile: file });
    expect(client.reflect).toHaveBeenCalledTimes(1);
    expect(first.context).toContain(FACT);
  });
  it("honors a current scoped cold marker once, then retrieves", async () => {
    const file = sessionCacheFile("claude-code", session);
    mkdirSync(join(file, ".."), { recursive: true });
    const cfg = resolveConfig(rawConfig);
    const client = promptClient();
    writeFileSync(file, JSON.stringify({ deferInitialReflect: true,
      memoryScope: memoryScopeFingerprint(cfg, client.bank, client.apiUrl) }));
    const first = await buildHookOutput({ harness: "claude-code", prompt: "Cold bank", cfg, client, cacheFile: file });
    expect(client.reflect).not.toHaveBeenCalled();
    expect(first.context).not.toContain(FACT);
    await buildHookOutput({ harness: "claude-code", prompt: "Bank ready", cfg, client, cacheFile: file });
    expect(client.reflect).toHaveBeenCalledTimes(1);
  });
  it("drops a scoped cold marker when the effective bank changes", async () => {
    const file = sessionCacheFile("claude-code", session);
    mkdirSync(join(file, ".."), { recursive: true });
    const cfg = resolveConfig(rawConfig);
    const old = promptClient();
    writeFileSync(file, JSON.stringify({ deferInitialReflect: true,
      memoryScope: memoryScopeFingerprint(cfg, old.bank, old.apiUrl) }));
    const current = promptClient("other-bank");
    await buildHookOutput({ harness: "claude-code", prompt: "Another warm bank", cfg,
      client: current, cacheFile: file });
    expect(current.reflect).toHaveBeenCalledTimes(1);
  });
});
