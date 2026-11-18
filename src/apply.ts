import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { resolveRuleContent } from "./config.js";
import { matchesModel } from "./match.js";
import type {
  FileResolver,
  ModelPromptsConfig,
  ModelRef,
  ResolvedMatch,
} from "./types.js";

export function resolveModelPrompts(
  config: ModelPromptsConfig,
  configPath: string,
  model: ModelRef | undefined,
  warnings: string[],
  resolveFile?: FileResolver,
  activeFileSigs?: Map<string, string>,
): ResolvedMatch[] {
  if (!config.enabled || !model) {
    return [];
  }

  const activeMatches: ResolvedMatch[] = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (!matchesModel(rule.match, model)) continue;

    const content = resolveRuleContent(
      rule,
      configPath,
      warnings,
      resolveFile,
      activeFileSigs,
    );
    if (!content) continue;

    if (rule.override) {
      activeMatches.length = 0;
    }

    activeMatches.push({
      id: rule.id,
      match: rule.match,
      mode: rule.mode,
      sectionTag: rule.section ?? config.sectionName,
      content,
      source: rule.file ? `file:${rule.file}` : "inline",
    });
  }

  return activeMatches;
}

function normalizeGuidelineLines(content: string): string[] {
  const lines: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(/^[-*]\s+/, "").trim();
    if (stripped) lines.push(stripped);
  }
  return lines;
}

export function applyModelPrompts(
  event: BeforeAgentStartEvent,
  matches: readonly ResolvedMatch[],
): BeforeAgentStartEventResult | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  const hasReplace = matches.some((m) => m.mode === "replace");

  if (hasReplace) {
    const prepends: string[] = [];
    const replaces: string[] = [];
    const guidelines: string[] = [];
    const appends: string[] = [];
    const sectionsByTag = new Map<string, string[]>();

    for (const match of matches) {
      switch (match.mode) {
        case "prepend":
          prepends.push(match.content);
          break;
        case "replace":
          replaces.push(match.content);
          break;
        case "guidelines":
          guidelines.push(...normalizeGuidelineLines(match.content));
          break;
        case "append":
          appends.push(match.content);
          break;
        case "section": {
          const list = sectionsByTag.get(match.sectionTag) ?? [];
          list.push(match.content);
          sectionsByTag.set(match.sectionTag, list);
          break;
        }
      }
    }

    const blocks: string[] = [];
    if (prepends.length > 0) blocks.push(prepends.join("\n\n"));
    if (replaces.length > 0) blocks.push(replaces.join("\n\n"));
    if (guidelines.length > 0) {
      blocks.push(
        `<rules>\n${guidelines.map((line) => `- ${line}`).join("\n")}\n</rules>`,
      );
    }
    if (appends.length > 0) blocks.push(appends.join("\n\n"));
    for (const [tag, fragments] of sectionsByTag) {
      blocks.push(`<${tag}>\n${fragments.join("\n\n")}\n</${tag}>`);
    }

    return { systemPrompt: blocks.join("\n\n") };
  }

  const guidelines: string[] = [];
  const appends: string[] = [];
  const sectionsByTag = new Map<string, string[]>();
  const prepends: string[] = [];

  for (const match of matches) {
    switch (match.mode) {
      case "guidelines":
        guidelines.push(...normalizeGuidelineLines(match.content));
        break;
      case "append":
        appends.push(match.content);
        break;
      case "section": {
        const list = sectionsByTag.get(match.sectionTag) ?? [];
        list.push(match.content);
        sectionsByTag.set(match.sectionTag, list);
        break;
      }
      case "prepend":
        prepends.push(match.content);
        break;
    }
  }

  if (guidelines.length > 0) {
    event.systemPromptOptions.promptGuidelines.push(...guidelines);
  }

  if (appends.length > 0) {
    const joinedAppend = appends.join("\n\n");
    const existingAppend = event.systemPromptOptions.appendSystemPrompt;
    event.systemPromptOptions.appendSystemPrompt = existingAppend
      ? `${existingAppend}\n\n${joinedAppend}`
      : joinedAppend;
  }

  for (const [tag, fragments] of sectionsByTag) {
    const joined = fragments.join("\n\n");
    const existing = event.systemPromptOptions.sections[tag];
    event.systemPromptOptions.sections[tag] = existing
      ? `${existing}\n\n${joined}`
      : joined;
  }

  if (prepends.length > 0) {
    return {
      systemPrompt: `${prepends.join("\n\n")}\n\n${event.systemPrompt}`,
    };
  }

  return undefined;
}
