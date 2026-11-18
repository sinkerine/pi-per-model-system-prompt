import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { applyModelPrompts, resolveModelPrompts } from "../../src/apply.js";
import { parseModelPromptsConfig } from "../../src/config.js";
import type { ModelPromptsConfig } from "../../src/types.js";

function makeEvent(): BeforeAgentStartEvent {
  const systemPromptOptions = {
    selectedTools: ["read", "bash"],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: ["Be concise"],
    appendSystemPrompt: "",
    sections: {} as Record<string, string>,
    cwd: "/tmp/work",
    contextFiles: [],
    skills: [],
  };

  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hello",
    systemPromptOptions,
    get systemPrompt() {
      const parts = [
        "Base prompt.",
        `<rules>\n${systemPromptOptions.promptGuidelines.map((g) => `- ${g}`).join("\n")}\n</rules>`,
      ];
      if (systemPromptOptions.appendSystemPrompt) {
        parts.push(
          `<addendum>\n${systemPromptOptions.appendSystemPrompt}\n</addendum>`,
        );
      }
      for (const [tag, body] of Object.entries(systemPromptOptions.sections)) {
        parts.push(`<${tag}>\n${body}\n</${tag}>`);
      }
      return parts.join("\n\n");
    },
  };
}

describe("apply.ts (AC4, AC5, AC6)", () => {
  test("concatenates matching rules in order and respects override: true", () => {
    const config: ModelPromptsConfig = {
      enabled: true,
      sectionName: "model_instructions",
      rules: [
        {
          id: "base",
          enabled: true,
          match: ["fixture/*"],
          prompt: "BASE_RULE",
          mode: "section",
          override: false,
        },
        {
          id: "override-rule",
          enabled: true,
          match: ["fixture/beta"],
          prompt: "OVERRIDE_RULE",
          mode: "section",
          override: true,
        },
        {
          id: "after-override",
          enabled: true,
          match: ["fixture/beta"],
          prompt: "AFTER_RULE",
          mode: "section",
          override: false,
        },
      ],
    };

    const alphaMatches = resolveModelPrompts(
      config,
      "/tmp/model-prompts.json",
      { provider: "fixture", id: "alpha" },
      [],
    );
    expect(alphaMatches.map((m) => m.content)).toEqual(["BASE_RULE"]);

    const betaMatches = resolveModelPrompts(
      config,
      "/tmp/model-prompts.json",
      { provider: "fixture", id: "beta" },
      [],
    );
    expect(betaMatches.map((m) => m.content)).toEqual([
      "OVERRIDE_RULE",
      "AFTER_RULE",
    ]);
  });

  test("failed rule with override: true does NOT clear earlier matched rules", () => {
    const warnings: string[] = [];
    const config: ModelPromptsConfig = {
      enabled: true,
      sectionName: "model_instructions",
      rules: [
        {
          id: "base",
          enabled: true,
          match: ["fixture/*"],
          prompt: "BASE_KEEP",
          mode: "section",
          override: false,
        },
        {
          id: "broken-override",
          enabled: true,
          match: ["fixture/alpha"],
          file: "./does-not-exist.md",
          mode: "section",
          override: true,
        },
      ],
    };

    const matches = resolveModelPrompts(
      config,
      "/tmp/model-prompts.json",
      { provider: "fixture", id: "alpha" },
      warnings,
    );
    expect(matches.map((m) => m.content)).toEqual(["BASE_KEEP"]);
    expect(warnings).toHaveLength(1);
  });

  test("respects top-level and rule-level enabled: false through parsed JSON config", () => {
    const disabledTop = parseModelPromptsConfig(
      JSON.parse(
        JSON.stringify({
          enabled: false,
          rules: [{ id: "r1", match: "*", prompt: "SHOULD_NOT_RUN" }],
        }),
      ),
    );
    expect(
      resolveModelPrompts(
        disabledTop,
        "/tmp/model-prompts.json",
        { provider: "fixture", id: "alpha" },
        [],
      ),
    ).toEqual([]);

    const disabledRule = parseModelPromptsConfig(
      JSON.parse(
        JSON.stringify({
          enabled: true,
          rules: [
            { id: "r1", enabled: false, match: "*", prompt: "DISABLED" },
            { id: "r2", enabled: true, match: "*", prompt: "ENABLED_SIBLING" },
          ],
        }),
      ),
    );
    expect(
      resolveModelPrompts(
        disabledRule,
        "/tmp/model-prompts.json",
        { provider: "fixture", id: "alpha" },
        [],
      ).map((m) => m.content),
    ).toEqual(["ENABLED_SIBLING"]);
  });

  test("applies section, append, and guidelines modes without clobbering existing values", () => {
    const event = makeEvent();
    event.systemPromptOptions.appendSystemPrompt = "EXISTING_ADDENDUM";
    event.systemPromptOptions.sections.model_instructions = "EXISTING_SECTION";

    const result = applyModelPrompts(event, [
      {
        id: "s1",
        match: ["*"],
        mode: "section",
        sectionTag: "model_instructions",
        content: "SEC_BODY",
        source: "inline",
      },
      {
        id: "a1",
        match: ["*"],
        mode: "append",
        sectionTag: "model_instructions",
        content: "APPEND_BODY",
        source: "inline",
      },
      {
        id: "g1",
        match: ["*"],
        mode: "guidelines",
        sectionTag: "model_instructions",
        content: "- First bullet\n* Second bullet\n\nThird bullet",
        source: "inline",
      },
    ]);

    expect(result).toBeUndefined();
    expect(event.systemPromptOptions.sections.model_instructions).toBe(
      "EXISTING_SECTION\n\nSEC_BODY",
    );
    expect(event.systemPromptOptions.appendSystemPrompt).toBe(
      "EXISTING_ADDENDUM\n\nAPPEND_BODY",
    );
    expect(event.systemPromptOptions.promptGuidelines).toEqual([
      "Be concise",
      "First bullet",
      "Second bullet",
      "Third bullet",
    ]);
  });

  test("applies prepend mode preserving structured mutations", () => {
    const event = makeEvent();
    const result = applyModelPrompts(event, [
      {
        id: "p1",
        match: ["*"],
        mode: "prepend",
        sectionTag: "model_instructions",
        content: "PREPEND_HEADER",
        source: "inline",
      },
      {
        id: "s1",
        match: ["*"],
        mode: "section",
        sectionTag: "model_instructions",
        content: "SEC_BODY",
        source: "inline",
      },
    ]);

    expect(result?.systemPrompt).toContain("PREPEND_HEADER\n\nBase prompt.");
    expect(result?.systemPrompt).toContain(
      "<model_instructions>\nSEC_BODY\n</model_instructions>",
    );
  });

  test("applies replace mode deterministically without mutating systemPromptOptions", () => {
    const event = makeEvent();
    const result = applyModelPrompts(event, [
      {
        id: "p1",
        match: ["*"],
        mode: "prepend",
        sectionTag: "model_instructions",
        content: "PREPEND_TOP",
        source: "inline",
      },
      {
        id: "rep",
        match: ["*"],
        mode: "replace",
        sectionTag: "model_instructions",
        content: "REPLACED_BASE",
        source: "inline",
      },
      {
        id: "g1",
        match: ["*"],
        mode: "guidelines",
        sectionTag: "model_instructions",
        content: "- Guide line",
        source: "inline",
      },
      {
        id: "a1",
        match: ["*"],
        mode: "append",
        sectionTag: "model_instructions",
        content: "APPEND_END",
        source: "inline",
      },
      {
        id: "s1",
        match: ["*"],
        mode: "section",
        sectionTag: "custom_tag",
        content: "CUSTOM_SEC",
        source: "inline",
      },
    ]);

    expect(event.systemPromptOptions.sections).toEqual({});
    expect(event.systemPromptOptions.appendSystemPrompt).toBe("");
    expect(event.systemPromptOptions.promptGuidelines).toEqual(["Be concise"]);
    expect(result?.systemPrompt).toBe(
      [
        "PREPEND_TOP",
        "REPLACED_BASE",
        "<rules>\n- Guide line\n</rules>",
        "APPEND_END",
        "<custom_tag>\nCUSTOM_SEC\n</custom_tag>",
      ].join("\n\n"),
    );
  });

  test("sequential fresh events isolate Model A -> Model B -> unmatched Model C", () => {
    const config: ModelPromptsConfig = {
      enabled: true,
      sectionName: "model_instructions",
      rules: [
        {
          id: "a",
          enabled: true,
          match: ["fixture/alpha"],
          prompt: "ONLY_A",
          mode: "section",
          override: false,
        },
        {
          id: "b",
          enabled: true,
          match: ["fixture/beta"],
          prompt: "ONLY_B",
          mode: "section",
          override: false,
        },
      ],
    };

    const eventA = makeEvent();
    applyModelPrompts(
      eventA,
      resolveModelPrompts(
        config,
        "/tmp/model-prompts.json",
        { provider: "fixture", id: "alpha" },
        [],
      ),
    );
    expect(eventA.systemPromptOptions.sections.model_instructions).toBe(
      "ONLY_A",
    );

    const eventB = makeEvent();
    applyModelPrompts(
      eventB,
      resolveModelPrompts(
        config,
        "/tmp/model-prompts.json",
        { provider: "fixture", id: "beta" },
        [],
      ),
    );
    expect(eventB.systemPromptOptions.sections.model_instructions).toBe(
      "ONLY_B",
    );

    const eventC = makeEvent();
    const resC = applyModelPrompts(
      eventC,
      resolveModelPrompts(
        config,
        "/tmp/model-prompts.json",
        { provider: "other", id: "gamma" },
        [],
      ),
    );
    expect(resC).toBeUndefined();
    expect(
      eventC.systemPromptOptions.sections.model_instructions,
    ).toBeUndefined();
  });
});
