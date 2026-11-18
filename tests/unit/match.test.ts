import { describe, expect, test } from "vitest";
import { compileModelPattern, matchesModel } from "../../src/match.js";

describe("match.ts (AC3)", () => {
  test("matches exact provider/id and bare id case-insensitively", () => {
    expect(
      matchesModel(["anthropic/claude-sonnet-4-5"], {
        provider: "Anthropic",
        id: "Claude-Sonnet-4-5",
      }),
    ).toBe(true);
    expect(
      matchesModel(["claude-sonnet-4-5"], {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      }),
    ).toBe(true);
    expect(
      matchesModel(["openai/gpt-5"], {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      }),
    ).toBe(false);
  });

  test("wildcard * matches across / for gateway model IDs", () => {
    expect(
      matchesModel(["magpie/*"], {
        provider: "magpie",
        id: "group/gemini",
      }),
    ).toBe(true);
    expect(
      matchesModel(["openrouter/*"], {
        provider: "openrouter",
        id: "moonshotai/kimi-k2.7-code",
      }),
    ).toBe(true);
    expect(
      matchesModel(["group/*"], {
        provider: "magpie",
        id: "group/gemini",
      }),
    ).toBe(true);
  });

  test("wildcard ? matches a single character", () => {
    expect(
      matchesModel(["gpt-4.?"], {
        provider: "openai",
        id: "gpt-4.1",
      }),
    ).toBe(true);
    expect(
      matchesModel(["gpt-4.?"], {
        provider: "openai",
        id: "gpt-4.10",
      }),
    ).toBe(false);
  });

  test("colon : is matched literally without stripping suffixes", () => {
    expect(
      matchesModel(["ollama/qwen3:*"], {
        provider: "ollama",
        id: "qwen3:32b",
      }),
    ).toBe(true);
    expect(
      matchesModel(["ollama/qwen3"], {
        provider: "ollama",
        id: "qwen3:32b",
      }),
    ).toBe(false);
  });

  test("supports pattern arrays as logical OR and escapes regex metacharacters", () => {
    expect(
      matchesModel(["openai/*", "*claude*"], {
        provider: "anthropic",
        id: "claude-opus-4",
      }),
    ).toBe(true);
    expect(compileModelPattern("gpt-4.1+mini").test("gpt-4.1+mini")).toBe(true);
    expect(compileModelPattern("gpt-4.1+mini").test("gpt-4x1mini")).toBe(false);
  });

  test("returns false for undefined model or empty patterns", () => {
    expect(matchesModel(["*"], undefined)).toBe(false);
    expect(matchesModel(["  ", ""], { provider: "a", id: "b" })).toBe(false);
  });
});
