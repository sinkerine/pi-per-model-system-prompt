import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import perModelSystemPrompt from "../../extensions/per-model-system-prompt.js";
import { ReloadableConfigStore } from "../../src/config.js";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeTempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-prompt-cmd-"));
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function createHarness() {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

  const mockPi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(
      name: string,
      opts: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, opts);
    },
  } as unknown as ExtensionAPI;

  return { mockPi, commands, handlers };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("/model-prompt command & lifecycle (AC7, AC8)", () => {
  test("AC8: /model-prompt [status|reload] reports model, configPath, rule id/patterns/mode, warnings, and forces reload even with unchanged stat", async () => {
    const dir = makeTempAgentDir();
    const configPath = join(dir, "model-prompts.json");
    const initialJson = JSON.stringify({
      rules: [
        {
          id: "alpha-rule",
          match: "fix*/al*",
          prompt: "ALPHA_AAAA",
          mode: "section",
        },
        {
          id: "broken-sib",
          match: "fix*/al*",
          file: "./missing.md",
        },
      ],
    });
    writeFileSync(configPath, initialJson, "utf8");
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(configPath, fixedTime, fixedTime);

    const { mockPi, commands } = createHarness();
    perModelSystemPrompt(mockPi);

    const cmd = commands.get("model-prompt");
    expect(cmd).toBeDefined();

    const notifications: Array<{ msg: string; level: string }> = [];
    const mockCtx = {
      hasUI: true,
      model: { provider: "fixture", id: "alpha" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;

    await cmd?.handler("", mockCtx);
    await cmd?.handler("status", mockCtx);
    expect(notifications).toHaveLength(2);
    for (const entry of notifications) {
      expect(entry.msg).toContain("fixture/alpha");
      expect(entry.msg).toContain(configPath);
      expect(entry.msg).toContain("alpha-rule");
      expect(entry.msg).toContain("fix*/al*");
      expect(entry.msg).toContain("section");
      expect(entry.msg).toContain("Warnings (1):");
      expect(entry.msg).toContain("broken-sib");
    }

    // Rewrite with exact same byte length and restore mtime so stat signature is identical
    const equalSizeJson = JSON.stringify({
      rules: [
        {
          id: "betax-rule",
          match: "fix*/al*",
          prompt: "ALPHA_BBBB",
          mode: "section",
        },
        {
          id: "broken-sib",
          match: "fix*/al*",
          file: "./missing.md",
        },
      ],
    });
    expect(Buffer.byteLength(equalSizeJson)).toBe(
      Buffer.byteLength(initialJson),
    );
    writeFileSync(configPath, equalSizeJson, "utf8");
    utimesSync(configPath, fixedTime, fixedTime);

    // Plain status uses stat cache -> still shows alpha-rule
    await cmd?.handler("status", mockCtx);
    expect(notifications[2]?.msg).toContain("alpha-rule");
    expect(notifications[2]?.msg).not.toContain("betax-rule");

    // Explicit reload bypasses stat cache -> shows betax-rule
    await cmd?.handler("reload", mockCtx);
    expect(notifications[3]?.msg).toContain("betax-rule");
    expect(notifications[3]?.msg).not.toContain("alpha-rule");
  });

  test("lifecycle: zero factory I/O, session_start & model_select warnings, dedup, hasUI=false suppression, and idempotent session_shutdown", async () => {
    const dir = makeTempAgentDir();
    const configPath = join(dir, "model-prompts.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [
          {
            id: "alpha-missing",
            match: "fixture/alpha",
            file: "./alpha-missing.md",
          },
          {
            id: "beta-missing",
            match: "fixture/beta",
            file: "./beta-missing.md",
          },
        ],
      }),
      "utf8",
    );

    const loadSpy = vi.spyOn(ReloadableConfigStore.prototype, "load");
    const { mockPi, handlers } = createHarness();
    perModelSystemPrompt(mockPi);

    // Factory must do zero store load / I/O
    expect(loadSpy).not.toHaveBeenCalled();

    const notifications: Array<{ msg: string; level: string }> = [];
    const ctxAlpha = {
      hasUI: true,
      model: { provider: "fixture", id: "alpha" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;

    const sessionStart = handlers.get("session_start")?.[0];
    const modelSelect = handlers.get("model_select")?.[0];
    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    const sessionShutdown = handlers.get("session_shutdown")?.[0];

    expect(sessionStart).toBeDefined();
    expect(modelSelect).toBeDefined();
    expect(beforeAgentStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();

    // session_start emits warning before any prompt
    sessionStart?.({ type: "session_start", reason: "startup" }, ctxAlpha);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.msg).toContain("alpha-missing");
    expect(notifications[0]?.level).toBe("warning");

    // Repeated unchanged evaluation does NOT re-notify
    sessionStart?.({ type: "session_start", reason: "startup" }, ctxAlpha);
    expect(notifications).toHaveLength(1);

    // model_select uses event.model (distinct from ctx.model = alpha)
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "beta" },
        source: "set",
      },
      ctxAlpha,
    );
    expect(notifications).toHaveLength(2);
    expect(notifications[1]?.msg).toContain("beta-missing");

    // Source change resets dedup so warning can re-emit
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [
          {
            id: "alpha-missing",
            match: "fixture/alpha",
            file: "./alpha-missing.md",
          },
          { id: "extra", match: "other/*", prompt: "ok" },
        ],
      }),
      "utf8",
    );
    const future = new Date(Date.now() + 2000);
    utimesSync(configPath, future, future);

    sessionStart?.({ type: "session_start", reason: "reload" }, ctxAlpha);
    expect(notifications).toHaveLength(3);
    expect(notifications[2]?.msg).toContain("alpha-missing");

    // session_shutdown is idempotent and resets state so next session_start can re-emit
    sessionShutdown?.({ type: "session_shutdown" }, ctxAlpha);
    sessionShutdown?.({ type: "session_shutdown" }, ctxAlpha);

    sessionStart?.({ type: "session_start", reason: "startup" }, ctxAlpha);
    expect(notifications).toHaveLength(4);
    expect(notifications[3]?.msg).toContain("alpha-missing");

    // hasUI = false never calls notify
    const headlessNotify = vi.fn();
    const headlessCtx = {
      hasUI: false,
      model: { provider: "fixture", id: "alpha" },
      ui: { notify: headlessNotify },
    } as unknown as ExtensionCommandContext;
    sessionShutdown?.({ type: "session_shutdown" }, headlessCtx);
    sessionStart?.({ type: "session_start", reason: "startup" }, headlessCtx);
    expect(headlessNotify).not.toHaveBeenCalled();
  });

  test("session_shutdown clears store cache so equal-stat rewrite is read on next session_start", async () => {
    const dir = makeTempAgentDir();
    const configPath = join(dir, "model-prompts.json");
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    const jsonA = JSON.stringify({
      rules: [{ id: "rule-a", match: "fixture/alpha", prompt: "ALPHA_AAAA" }],
    });
    const jsonB = JSON.stringify({
      rules: [{ id: "rule-b", match: "fixture/alpha", prompt: "ALPHA_BBBB" }],
    });
    expect(Buffer.byteLength(jsonB)).toBe(Buffer.byteLength(jsonA));

    writeFileSync(configPath, jsonA, "utf8");
    utimesSync(configPath, fixedTime, fixedTime);

    const { mockPi, commands, handlers } = createHarness();
    perModelSystemPrompt(mockPi);

    const notifications: Array<{ msg: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      model: { provider: "fixture", id: "alpha" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;

    const sessionStart = handlers.get("session_start")?.[0];
    const sessionShutdown = handlers.get("session_shutdown")?.[0];
    const cmd = commands.get("model-prompt");

    sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
    await cmd?.handler("status", ctx);
    expect(notifications[0]?.msg).toContain("rule-a");

    // Equal-size rewrite with identical mtime -> without shutdown clear, cache stays stale
    writeFileSync(configPath, jsonB, "utf8");
    utimesSync(configPath, fixedTime, fixedTime);

    sessionShutdown?.({ type: "session_shutdown" }, ctx);
    sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
    await cmd?.handler("status", ctx);
    expect(notifications[1]?.msg).toContain("rule-b");
    expect(notifications[1]?.msg).not.toContain("rule-a");
  });

  test("warning dedup across model switch: Alpha -> Beta -> Alpha does not re-emit unchanged warnings, but source change resets dedup", () => {
    const dir = makeTempAgentDir();
    const configPath = join(dir, "model-prompts.json");
    const betaFile = join(dir, "beta.md");
    const alphaFile = join(dir, "alpha-missing.md");
    writeFileSync(betaFile, "BETA_OK", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [
          {
            id: "alpha-bad-sec",
            match: "fixture/alpha",
            prompt: "BAD",
            section: "tools",
          },
          {
            id: "alpha-missing",
            match: "fixture/alpha",
            file: "./alpha-missing.md",
          },
          {
            id: "beta-ok",
            match: "fixture/beta",
            file: "./beta.md",
          },
        ],
      }),
      "utf8",
    );

    const { mockPi, handlers } = createHarness();
    perModelSystemPrompt(mockPi);

    const notifications: Array<{ msg: string; level: string }> = [];
    const ctxAlpha = {
      hasUI: true,
      model: { provider: "fixture", id: "alpha" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;
    const ctxBeta = {
      hasUI: true,
      model: { provider: "fixture", id: "beta" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;

    const sessionStart = handlers.get("session_start")?.[0];
    const modelSelect = handlers.get("model_select")?.[0];

    // 1) Alpha on startup -> reserved-rule warning + alpha-missing warning (2 total)
    sessionStart?.({ type: "session_start", reason: "startup" }, ctxAlpha);
    expect(notifications).toHaveLength(2);

    // 2) Switch to Beta -> no new warnings (2 total)
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "beta" },
        source: "set",
      },
      ctxBeta,
    );
    expect(notifications).toHaveLength(2);

    // 3) Switch back to Alpha with unchanged sources -> must NOT re-emit (still 2 total)
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "alpha" },
        source: "set",
      },
      ctxAlpha,
    );
    expect(notifications).toHaveLength(2);

    // 4) Change a source (create alpha-missing.md then delete it again) -> dedup resets, warnings re-emit
    writeFileSync(alphaFile, "APPEARED", "utf8");
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "alpha" },
        source: "set",
      },
      ctxAlpha,
    );
    // Config warning re-emits after source change
    expect(notifications.length).toBeGreaterThan(2);

    const countBeforeDelete = notifications.length;
    rmSync(alphaFile);
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "alpha" },
        source: "set",
      },
      ctxAlpha,
    );
    expect(notifications.length).toBeGreaterThan(countBeforeDelete);
    expect(
      notifications
        .slice(countBeforeDelete)
        .some((n) => n.msg.includes("alpha-missing")),
    ).toBe(true);
  });

  test("transient referenced-file read recovery on Beta does not reset Alpha's unchanged missing-ref warning dedup", () => {
    const dir = makeTempAgentDir();
    const configPath = join(dir, "model-prompts.json");
    const betaFile = join(dir, "beta.md");
    writeFileSync(betaFile, "BETA_RECOVERED", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [
          {
            id: "alpha-missing",
            match: "fixture/alpha",
            file: "./alpha-missing.md",
          },
          {
            id: "beta-eacces",
            match: "fixture/beta",
            file: "./beta.md",
          },
        ],
      }),
      "utf8",
    );

    let failBetaOnce = true;
    const store = new ReloadableConfigStore(dir, {
      readFile: (p) => {
        if (p === betaFile && failBetaOnce) {
          failBetaOnce = false;
          const err = new Error("EACCES: beta denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return readFileSync(p, "utf8");
      },
    });

    const { mockPi, handlers } = createHarness();
    perModelSystemPrompt(mockPi, { store });

    const notifications: Array<{ msg: string; level: string }> = [];
    const ctxAlpha = {
      hasUI: true,
      model: { provider: "fixture", id: "alpha" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;
    const ctxBeta = {
      hasUI: true,
      model: { provider: "fixture", id: "beta" },
      ui: {
        notify(msg: string, level: string) {
          notifications.push({ msg, level });
        },
      },
    } as unknown as ExtensionCommandContext;

    const sessionStart = handlers.get("session_start")?.[0];
    const modelSelect = handlers.get("model_select")?.[0];
    const beforeAgentStart = handlers.get("before_agent_start")?.[0];

    // 1) Alpha on startup -> alpha-missing warning (1)
    sessionStart?.({ type: "session_start", reason: "startup" }, ctxAlpha);
    expect(
      notifications.filter((n) => n.msg.includes("alpha-missing")),
    ).toHaveLength(1);

    // 2) Switch to Beta -> EACCES on first read -> beta-eacces warning (1)
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "beta" },
        source: "set",
      },
      ctxBeta,
    );
    expect(
      notifications.filter((n) => n.msg.includes("beta-eacces")),
    ).toHaveLength(1);

    // 3) Evaluate Beta again with identical stat -> recovers and applies BETA_RECOVERED
    const betaEvent = {
      type: "before_agent_start",
      messageType: "user",
      prompt: "hi",
      systemPromptOptions: {
        selectedTools: ["read", "bash"],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {} as Record<string, string>,
        cwd: dir,
        contextFiles: [],
        skills: [],
      },
      systemPrompt: "Base",
    };
    beforeAgentStart?.(betaEvent, ctxBeta);
    expect(betaEvent.systemPromptOptions.sections.model_instructions).toBe(
      "BETA_RECOVERED",
    );

    // 4) Switch back to Alpha -> alpha-missing warning must STILL be emitted only once
    modelSelect?.(
      {
        type: "model_select",
        model: { provider: "fixture", id: "alpha" },
        source: "set",
      },
      ctxAlpha,
    );
    expect(
      notifications.filter((n) => n.msg.includes("alpha-missing")),
    ).toHaveLength(1);
    expect(
      notifications.filter((n) => n.msg.includes("beta-eacces")),
    ).toHaveLength(1);
  });
});
