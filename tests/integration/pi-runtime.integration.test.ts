import { unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { extractSystemText, httpStub } from "../support/http-stub.js";
import { PiFixture, until } from "../support/pi-rpc.js";

test("AC1: matching global rule beats decoy <cwd>/.pi/model-prompts.json, and deleting global config removes prompt silently", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    await pi.writeWorkFile(
      ".pi/model-prompts.json",
      JSON.stringify({
        rules: [
          {
            id: "decoy-local",
            match: "fixture/alpha",
            prompt: "DECOY_LOCAL_PROMPT_MUST_NOT_LOAD",
          },
        ],
      }),
    );
    await pi.writeModelPrompts({
      rules: [
        {
          id: "global-alpha",
          match: "fixture/alpha",
          prompt: "GLOBAL_ALPHA_ONLY",
        },
      ],
    });
    await pi.start();

    await pi.prompt("turn 1 with global + decoy");
    expect(stub.captures).toHaveLength(1);
    const cap1 = stub.captures[0];
    if (!cap1) throw new Error("Expected capture[0]");
    expect(cap1.body.model).toBe("alpha");
    const sys1 = extractSystemText(cap1);
    expect(sys1).toContain(
      "<model_instructions>\nGLOBAL_ALPHA_ONLY\n</model_instructions>",
    );
    expect(sys1).not.toContain("DECOY_LOCAL_PROMPT_MUST_NOT_LOAD");

    // Delete global config mid-session -> next prompt has neither marker and no warning
    const warnCountBeforeDelete = pi.records.filter(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        r.notifyType === "warning",
    ).length;
    unlinkSync(join(pi.directory, "model-prompts.json"));

    await pi.prompt("turn 2 after deleting global config");
    expect(stub.captures).toHaveLength(2);
    const cap2 = stub.captures[1];
    if (!cap2) throw new Error("Expected capture[1]");
    const sys2 = extractSystemText(cap2);
    expect(sys2).not.toContain("<model_instructions>");
    expect(sys2).not.toContain("GLOBAL_ALPHA_ONLY");
    expect(sys2).not.toContain("DECOY_LOCAL_PROMPT_MUST_NOT_LOAD");

    const warnCountAfterDelete = pi.records.filter(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        r.notifyType === "warning",
    ).length;
    expect(warnCountAfterDelete).toBe(warnCountBeforeDelete);
    expect(pi.nonJsonStdout).toEqual([]);
    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC2+AC3+AC4+AC6: A->B->unmatched C via set_model with external file, wildcard over slash ID, exact concat order + override", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    await pi.writeAgentFile("prompts/beta.md", "BETA_FILE_OVERRIDE_TOKEN");
    await pi.writeModelPrompts({
      rules: [
        {
          id: "fixture-wild",
          match: "fixture/*",
          prompt: "FIXTURE_SHARED_TOKEN",
        },
        {
          id: "alpha-specific",
          match: "fixture/alpha",
          prompt: "ALPHA_SPECIFIC_TOKEN",
        },
        {
          id: "beta-override",
          match: "fixture/group/beta",
          file: "./prompts/beta.md",
          override: true,
        },
      ],
    });
    await pi.start();

    // Turn 1: fixture/alpha -> concatenates fixture-wild + alpha-specific in exact order
    await pi.prompt("turn 1 on alpha");
    expect(stub.captures).toHaveLength(1);
    const cap1 = stub.captures[0];
    if (!cap1) throw new Error("Expected capture[0]");
    expect(cap1.body.model).toBe("alpha");
    const sys1 = extractSystemText(cap1);
    expect(sys1).toContain(
      "<model_instructions>\nFIXTURE_SHARED_TOKEN\n\nALPHA_SPECIFIC_TOKEN\n</model_instructions>",
    );
    expect(sys1).not.toContain("BETA_FILE_OVERRIDE_TOKEN");

    // Turn 2: set_model -> fixture/group/beta -> override discards fixture-wild
    await pi.setModel("fixture", "group/beta");
    await pi.prompt("turn 2 on beta");
    expect(stub.captures).toHaveLength(2);
    const cap2 = stub.captures[1];
    if (!cap2) throw new Error("Expected capture[1]");
    expect(cap2.body.model).toBe("group/beta");
    const sys2 = extractSystemText(cap2);
    expect(sys2).toContain(
      "<model_instructions>\nBETA_FILE_OVERRIDE_TOKEN\n</model_instructions>",
    );
    expect(sys2).not.toContain("FIXTURE_SHARED_TOKEN");
    expect(sys2).not.toContain("ALPHA_SPECIFIC_TOKEN");

    // Turn 3: set_model -> other/gamma (unmatched) -> no <model_instructions>
    await pi.setModel("other", "gamma");
    await pi.prompt("turn 3 on gamma");
    expect(stub.captures).toHaveLength(3);
    const cap3 = stub.captures[2];
    if (!cap3) throw new Error("Expected capture[2]");
    expect(cap3.body.model).toBe("gamma");
    const sys3 = extractSystemText(cap3);
    expect(sys3).not.toContain("<model_instructions>");
    expect(sys3).not.toContain("BETA_FILE_OVERRIDE_TOKEN");

    expect(pi.nonJsonStdout).toEqual([]);
    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC6: cycle_model updates injected prompt on next turn", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    await pi.writeModelPrompts({
      rules: [
        { id: "a", match: "fixture/alpha", prompt: "CYCLE_ALPHA" },
        { id: "b", match: "fixture/group/beta", prompt: "CYCLE_BETA" },
      ],
    });
    await pi.start();

    await pi.prompt("first");
    const cycleCap1 = stub.captures[0];
    if (!cycleCap1) throw new Error("Expected capture[0]");
    expect(cycleCap1.body.model).toBe("alpha");
    expect(extractSystemText(cycleCap1)).toContain("CYCLE_ALPHA");

    await pi.cycleModel();
    await pi.prompt("second");
    expect(stub.captures).toHaveLength(2);
    const cycleCap2 = stub.captures[1];
    if (!cycleCap2) throw new Error("Expected capture[1]");
    expect(cycleCap2.body.model).toBe("group/beta");
    const sys2 = extractSystemText(cycleCap2);
    expect(sys2).toContain("CYCLE_BETA");
    expect(sys2).not.toContain("CYCLE_ALPHA");

    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC6: print mode (-p) injects matching rule for selected model", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    await pi.writeModelPrompts({
      rules: [
        {
          id: "beta-print",
          match: "fixture/group/beta",
          prompt: "PRINT_MODE_BETA_TOKEN",
        },
      ],
    });
    const result = await pi.runPrint("hello print", "fixture", "group/beta");
    expect(result.exitCode).toBe(0);
    expect(stub.captures).toHaveLength(1);
    const printCap = stub.captures[0];
    if (!printCap) throw new Error("Expected capture[0]");
    expect(printCap.body.model).toBe("group/beta");
    expect(extractSystemText(printCap)).toContain("PRINT_MODE_BETA_TOKEN");
    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC6: supportsMidConvoSystemMessages:true emits Updated and Removed system prompt section patches", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({
    baseUrl: stub.baseUrl,
    defaultProvider: "midconvo",
    defaultModel: "one",
  });
  let passed = false;
  try {
    await pi.writeModelPrompts({
      rules: [
        { id: "m1", match: "midconvo/one", prompt: "MIDCONVO_ONE_TOKEN" },
        { id: "m2", match: "midconvo/two", prompt: "MIDCONVO_TWO_TOKEN" },
      ],
    });
    await pi.start();

    await pi.prompt("turn 1");
    const midCap1 = stub.captures[0];
    if (!midCap1) throw new Error("Expected capture[0]");
    expect(midCap1.body.model).toBe("one");
    expect(extractSystemText(midCap1)).toContain("MIDCONVO_ONE_TOKEN");

    // Switch to midconvo/two -> Updated system prompt section "model_instructions"
    await pi.setModel("midconvo", "two");
    await pi.prompt("turn 2");
    expect(stub.captures).toHaveLength(2);
    const cap2 = stub.captures[1];
    if (!cap2) throw new Error("Expected capture[1]");
    expect(cap2.body.model).toBe("two");
    const systemMsgs2 = cap2.body.messages.filter((m) => m.role === "system");
    expect(systemMsgs2.length).toBeGreaterThanOrEqual(2);
    const lastSys2 = String(systemMsgs2[systemMsgs2.length - 1]?.content);
    expect(lastSys2).toContain(
      'Updated system prompt section "model_instructions":',
    );
    expect(lastSys2).toContain("MIDCONVO_TWO_TOKEN");

    // Switch to unmatched midconvo/three -> Removed system prompt section "model_instructions".
    await pi.setModel("midconvo", "three");
    await pi.prompt("turn 3");
    expect(stub.captures).toHaveLength(3);
    const cap3 = stub.captures[2];
    if (!cap3) throw new Error("Expected capture[2]");
    expect(cap3.body.model).toBe("three");
    const systemMsgs3 = cap3.body.messages.filter((m) => m.role === "system");
    const lastSys3 = String(systemMsgs3[systemMsgs3.length - 1]?.content);
    expect(lastSys3).toContain(
      'Removed system prompt section "model_instructions".',
    );

    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC5: wire payloads for top-level sectionName, rule section override, and all 5 modes", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    await pi.writeModelPrompts({
      sectionName: "top_custom",
      rules: [
        {
          id: "sec-default",
          match: "fixture/alpha",
          prompt: "MODE_TOP_SECTION_TEXT",
          mode: "section",
        },
        {
          id: "sec-override",
          match: "fixture/alpha",
          prompt: "MODE_RULE_SECTION_TEXT",
          mode: "section",
          section: "rule_custom",
        },
        {
          id: "app",
          match: "fixture/alpha",
          prompt: "MODE_APPEND_TEXT",
          mode: "append",
        },
        {
          id: "gui",
          match: "fixture/alpha",
          prompt: "- MODE_GUIDELINE_ITEM",
          mode: "guidelines",
        },
        {
          id: "pre",
          match: "fixture/alpha",
          prompt: "MODE_PREPEND_HEADER",
          mode: "prepend",
        },
        {
          id: "rep",
          match: "fixture/group/beta",
          prompt: "MODE_REPLACE_ALL",
          mode: "replace",
        },
      ],
    });
    await pi.start();

    await pi.prompt("test modes 1-4");
    const cap1 = stub.captures[0];
    if (!cap1) throw new Error("Expected capture[0]");
    expect(cap1.body.model).toBe("alpha");
    const sys1 = extractSystemText(cap1);
    expect(sys1.startsWith("MODE_PREPEND_HEADER")).toBe(true);
    expect(sys1).toContain("<tools>");
    expect(sys1).toContain("<cwd>");
    expect(sys1).toContain(
      "<top_custom>\nMODE_TOP_SECTION_TEXT\n</top_custom>",
    );
    expect(sys1).toContain(
      "<rule_custom>\nMODE_RULE_SECTION_TEXT\n</rule_custom>",
    );
    expect(sys1).toContain("<addendum>\nMODE_APPEND_TEXT\n</addendum>");
    const rulesMatch = sys1.match(/<rules>([\s\S]*?)<\/rules>/);
    expect(rulesMatch?.[1]).toContain("- MODE_GUIDELINE_ITEM");
    expect(rulesMatch?.[1]).not.toContain("- - MODE_GUIDELINE_ITEM");

    // replace mode on fixture/group/beta
    await pi.setModel("fixture", "group/beta");
    await pi.prompt("test replace mode");
    const cap2 = stub.captures[1];
    if (!cap2) throw new Error("Expected capture[1]");
    expect(cap2.body.model).toBe("group/beta");
    const sys2 = extractSystemText(cap2);
    expect(sys2).toBe("MODE_REPLACE_ALL");

    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC7: live .md and JSON edits, invalid sibling tolerance, deduplicated malformed-JSON warnings, and clean stdout/stderr", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    const mdPath = await pi.writeAgentFile("prompts/live.md", "LIVE_V1");
    await pi.writeModelPrompts({
      rules: [
        { id: "live", match: "fixture/alpha", file: "./prompts/live.md" },
      ],
    });
    await pi.start();

    await pi.prompt("turn 1");
    const liveCap1 = stub.captures[0];
    if (!liveCap1) throw new Error("Expected capture[0]");
    expect(extractSystemText(liveCap1)).toContain("LIVE_V1");

    // Edit referenced .md file mid-session without /reload
    await pi.writeAgentFile("prompts/live.md", "LIVE_V2_UPDATED");
    const future = new Date(Date.now() + 2000);
    utimesSync(mdPath, future, future);

    await pi.prompt("turn 2");
    const liveCap2 = stub.captures[1];
    if (!liveCap2) throw new Error("Expected capture[1]");
    const sys2 = extractSystemText(liveCap2);
    expect(sys2).toContain("LIVE_V2_UPDATED");
    expect(sys2).not.toContain("LIVE_V1");

    // Edit model-prompts.json with reserved-section invalid rule beside valid sibling
    const beforeReserved = pi.records.length;
    await pi.writeModelPrompts({
      rules: [
        {
          id: "bad-reserved",
          match: "fixture/alpha",
          prompt: "BAD_RESERVED",
          section: "tools",
        },
        { id: "live2", match: "fixture/alpha", prompt: "JSON_V3" },
      ],
    });
    const future2 = new Date(Date.now() + 4000);
    utimesSync(join(pi.directory, "model-prompts.json"), future2, future2);

    await pi.prompt("turn 3");
    const liveCap3 = stub.captures[2];
    if (!liveCap3) throw new Error("Expected capture[2]");
    const sys3 = extractSystemText(liveCap3);
    expect(sys3).toContain("JSON_V3");
    expect(sys3).not.toContain("BAD_RESERVED");
    const reservedWarn = pi.records
      .slice(beforeReserved)
      .find(
        (r) =>
          r.type === "extension_ui_request" &&
          r.method === "notify" &&
          r.notifyType === "warning" &&
          String(r.message).includes("bad-reserved"),
      );
    expect(reservedWarn).toBeDefined();

    // Missing referenced file beside working sibling across 2 unchanged turns ->
    // working sibling injected on both turns, exactly ONE missing-file warning, clean streams
    const warnCountBeforeMissing = pi.records.filter(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        r.notifyType === "warning",
    ).length;
    await pi.writeModelPrompts({
      rules: [
        {
          id: "missing-ref",
          match: "fixture/alpha",
          file: "./does-not-exist.md",
        },
        {
          id: "working-sib",
          match: "fixture/alpha",
          prompt: "WORKING_SIBLING_TOKEN",
        },
      ],
    });
    const futureMissing = new Date(Date.now() + 5000);
    utimesSync(
      join(pi.directory, "model-prompts.json"),
      futureMissing,
      futureMissing,
    );

    await pi.prompt("turn 3b missing file 1");
    await pi.prompt("turn 3c missing file 2");
    expect(stub.captures).toHaveLength(5);
    const missingCap1 = stub.captures[3];
    const missingCap2 = stub.captures[4];
    if (!missingCap1 || !missingCap2) {
      throw new Error("Expected captures 3 and 4");
    }
    expect(extractSystemText(missingCap1)).toContain("WORKING_SIBLING_TOKEN");
    expect(extractSystemText(missingCap2)).toContain("WORKING_SIBLING_TOKEN");
    const missingWarnings = pi.records.filter(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        r.notifyType === "warning",
    );
    expect(missingWarnings.length).toBe(warnCountBeforeMissing + 1);
    expect(
      String(missingWarnings[missingWarnings.length - 1]?.message),
    ).toContain("missing-ref");

    // Write malformed JSON mid-session -> exactly ONE warning across 2 unchanged turns,
    // old prompt WORKING_SIBLING_TOKEN is NOT injected, both turns produce provider requests, stdout/stderr clean
    const warnCountBeforeMalformed = missingWarnings.length;

    await pi.writeModelPrompts("{ broken json !!!");
    const future3 = new Date(Date.now() + 6000);
    utimesSync(join(pi.directory, "model-prompts.json"), future3, future3);

    await pi.prompt("turn 4 malformed 1");
    await pi.prompt("turn 5 malformed 2");
    expect(stub.captures).toHaveLength(7);

    const liveCap6 = stub.captures[5];
    const liveCap7 = stub.captures[6];
    if (!liveCap6 || !liveCap7) throw new Error("Expected captures 5 and 6");
    const sys6 = extractSystemText(liveCap6);
    const sys7 = extractSystemText(liveCap7);
    expect(sys6).not.toContain("WORKING_SIBLING_TOKEN");
    expect(sys7).not.toContain("WORKING_SIBLING_TOKEN");

    const malformedWarnings = pi.records.filter(
      (r) =>
        r.type === "extension_ui_request" &&
        r.method === "notify" &&
        r.notifyType === "warning",
    );
    expect(malformedWarnings.length).toBe(warnCountBeforeMalformed + 1);
    expect(
      String(malformedWarnings[malformedWarnings.length - 1]?.message),
    ).toContain("Failed to parse");
    expect(pi.nonJsonStdout).toEqual([]);
    expect(pi.stderr).toBe("");

    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});

test("AC8: /model-prompt [status|reload] emits model, configPath, match patterns, mode, warnings, and forces reload on unchanged stat", async () => {
  const stub = await httpStub();
  const pi = await PiFixture.create({ baseUrl: stub.baseUrl });
  let passed = false;
  try {
    const configPath = join(pi.directory, "model-prompts.json");
    const initialJson = JSON.stringify({
      rules: [
        {
          id: "alpha-rule",
          match: "fix*/al*",
          prompt: "STATUS_AAAA",
          mode: "section",
        },
        {
          id: "broken-sib",
          match: "fix*/al*",
          file: "./missing.md",
        },
      ],
    });
    await pi.writeModelPrompts(initialJson);
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(configPath, fixedTime, fixedTime);
    await pi.start();

    const beforeStatus = pi.records.length;
    await pi.rpc("prompt", { message: "/model-prompt status" });
    const statusNotify = await until(
      () =>
        pi.records
          .slice(beforeStatus)
          .find(
            (r) => r.type === "extension_ui_request" && r.method === "notify",
          ),
      "/model-prompt status notify",
    );
    const statusMsg = String(statusNotify.message);
    expect(statusMsg).toContain("fixture/alpha");
    expect(statusMsg).toContain(configPath);
    expect(statusMsg).toContain("alpha-rule");
    expect(statusMsg).toContain("fix*/al*");
    expect(statusMsg).toContain("section");
    expect(statusMsg).toContain("Warnings (1):");
    expect(statusMsg).toContain("broken-sib");

    // Rewrite with equal byte length and restore original mtime -> stat unchanged
    const equalSizeJson = JSON.stringify({
      rules: [
        {
          id: "betax-rule",
          match: "fix*/al*",
          prompt: "STATUS_BBBB",
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
    await pi.writeModelPrompts(equalSizeJson);
    utimesSync(configPath, fixedTime, fixedTime);

    // Default /model-prompt uses cached stat -> still shows alpha-rule
    const beforeCached = pi.records.length;
    await pi.rpc("prompt", { message: "/model-prompt" });
    const cachedNotify = await until(
      () =>
        pi.records
          .slice(beforeCached)
          .find(
            (r) => r.type === "extension_ui_request" && r.method === "notify",
          ),
      "/model-prompt cached notify",
    );
    expect(String(cachedNotify.message)).toContain("alpha-rule");
    expect(String(cachedNotify.message)).not.toContain("betax-rule");

    // /model-prompt reload bypasses stat cache -> shows betax-rule
    const beforeReload = pi.records.length;
    await pi.rpc("prompt", { message: "/model-prompt reload" });
    const reloadNotify = await until(
      () =>
        pi.records
          .slice(beforeReload)
          .find(
            (r) => r.type === "extension_ui_request" && r.method === "notify",
          ),
      "/model-prompt reload notify",
    );
    expect(String(reloadNotify.message)).toContain("betax-rule");
    expect(String(reloadNotify.message)).not.toContain("alpha-rule");

    // Slash commands must not send provider HTTP requests
    expect(stub.captures).toHaveLength(0);

    passed = true;
  } finally {
    await pi.close(passed);
    await stub.close();
  }
});
