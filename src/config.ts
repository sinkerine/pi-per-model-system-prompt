import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ConfigLoadResult,
  FileResolveResult,
  FileResolver,
  InjectionMode,
  ModelPromptRule,
  ModelPromptsConfig,
} from "./types.js";

const DEFAULT_SECTION_NAME = "model_instructions";
const SECTION_TAG_REGEX = /^[a-z][a-z0-9_-]*$/;
const RESERVED_SECTION_NAMES = new Set([
  "preamble",
  "tools",
  "rules",
  "docs",
  "addendum",
  "project_context",
  "skills",
  "cwd",
]);

const VALID_MODES = new Set<InjectionMode>([
  "section",
  "append",
  "guidelines",
  "prepend",
  "replace",
]);

const KNOWN_TOP_KEYS = new Set(["enabled", "sectionName", "rules"]);
const KNOWN_RULE_KEYS = new Set([
  "id",
  "enabled",
  "match",
  "prompt",
  "file",
  "mode",
  "section",
  "override",
]);

function emptyConfig(): ModelPromptsConfig {
  return {
    enabled: true,
    sectionName: DEFAULT_SECTION_NAME,
    rules: [],
  };
}

export function isValidSectionTag(tag: string): boolean {
  return SECTION_TAG_REGEX.test(tag) && !RESERVED_SECTION_NAMES.has(tag);
}

export function resolveConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "model-prompts.json");
}

export function resolveRuleFilePath(
  fileSpec: string,
  configDir: string,
): string {
  const trimmed = fileSpec.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(configDir, trimmed);
}

export function parseModelPromptsConfig(
  raw: unknown,
  warnings: string[] = [],
): ModelPromptsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("model-prompts.json must be a JSON object");
    return emptyConfig();
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      warnings.push(`Unknown top-level key "${key}" in model-prompts.json`);
    }
  }

  let enabled = true;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === "boolean") {
      enabled = obj.enabled;
    } else {
      warnings.push(
        'Top-level "enabled" must be a boolean; disabling all injection',
      );
      enabled = false;
    }
  }

  let sectionName = DEFAULT_SECTION_NAME;
  if (obj.sectionName !== undefined) {
    if (
      typeof obj.sectionName === "string" &&
      obj.sectionName.trim().length > 0
    ) {
      const candidate = obj.sectionName.trim();
      if (isValidSectionTag(candidate)) {
        sectionName = candidate;
      } else {
        warnings.push(
          `Invalid or reserved top-level sectionName "${candidate}"; falling back to "${DEFAULT_SECTION_NAME}"`,
        );
      }
    } else {
      warnings.push(
        `Top-level "sectionName" must be a non-empty string; falling back to "${DEFAULT_SECTION_NAME}"`,
      );
    }
  }

  const rules: ModelPromptRule[] = [];
  if (obj.rules !== undefined && !Array.isArray(obj.rules)) {
    warnings.push('Top-level "rules" must be an array');
  } else if (Array.isArray(obj.rules)) {
    for (let i = 0; i < obj.rules.length; i++) {
      const item = obj.rules[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        warnings.push(`rule[${i}] must be an object`);
        continue;
      }
      const r = item as Record<string, unknown>;
      let id = `rule[${i}]`;
      if (r.id !== undefined) {
        if (typeof r.id !== "string") {
          warnings.push(`rule[${i}]: "id" must be a string`);
        } else if (r.id.trim().length > 0) {
          id = r.id.trim();
        } else {
          warnings.push(`rule[${i}]: "id" must be a non-empty string`);
        }
      }

      for (const key of Object.keys(r)) {
        if (!KNOWN_RULE_KEYS.has(key)) {
          warnings.push(`${id}: unknown rule key "${key}"`);
        }
      }

      if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
        warnings.push(`${id}: "enabled" must be a boolean`);
        continue;
      }
      const ruleEnabled = r.enabled ?? true;

      let match: string[] = [];
      if (typeof r.match === "string") {
        const t = r.match.trim();
        if (!t) {
          warnings.push(`${id}: missing or empty match pattern`);
          continue;
        }
        match = [t];
      } else if (Array.isArray(r.match)) {
        if (r.match.length === 0) {
          warnings.push(`${id}: missing or empty match pattern`);
          continue;
        }
        let invalidEntry = false;
        const collected: string[] = [];
        for (const p of r.match) {
          if (typeof p !== "string" || p.trim().length === 0) {
            invalidEntry = true;
            break;
          }
          collected.push(p.trim());
        }
        if (invalidEntry) {
          warnings.push(
            `${id}: "match" array must contain only non-empty strings`,
          );
          continue;
        }
        match = collected;
      } else {
        warnings.push(
          `${id}: "match" must be a non-empty string or array of non-empty strings`,
        );
        continue;
      }

      const hasPromptKey = r.prompt !== undefined;
      const hasFileKey = r.file !== undefined;
      if (hasPromptKey === hasFileKey) {
        warnings.push(`${id}: must specify exactly one of "prompt" or "file"`);
        continue;
      }
      if (hasPromptKey && typeof r.prompt !== "string") {
        warnings.push(`${id}: "prompt" must be a string`);
        continue;
      }
      if (hasFileKey && typeof r.file !== "string") {
        warnings.push(`${id}: "file" must be a string`);
        continue;
      }

      let mode: InjectionMode = "section";
      if (r.mode !== undefined) {
        if (typeof r.mode !== "string") {
          warnings.push(`${id}: "mode" must be a string`);
          continue;
        }
        if (!VALID_MODES.has(r.mode as InjectionMode)) {
          warnings.push(`${id}: invalid mode "${r.mode}"`);
          continue;
        }
        mode = r.mode as InjectionMode;
      }

      if (r.override !== undefined && typeof r.override !== "boolean") {
        warnings.push(`${id}: "override" must be a boolean`);
        continue;
      }

      let section: string | undefined;
      if (r.section !== undefined) {
        if (typeof r.section !== "string" || r.section.trim().length === 0) {
          warnings.push(`${id}: "section" must be a non-empty string`);
          continue;
        }
        const candidate = r.section.trim();
        if (!isValidSectionTag(candidate)) {
          warnings.push(
            `${id}: invalid or reserved section name "${candidate}"`,
          );
          continue;
        }
        section = candidate;
      }

      rules.push({
        id,
        enabled: ruleEnabled,
        match,
        prompt: hasPromptKey ? (r.prompt as string) : undefined,
        file: hasFileKey ? (r.file as string) : undefined,
        mode,
        section,
        override: r.override === true,
      });
    }
  }

  return { enabled, sectionName, rules };
}

interface StatLike {
  isFile(): boolean;
  mtimeMs: number;
  size: number;
}

interface FileStatInfo {
  exists: boolean;
  isFile: boolean;
  isMissing: boolean;
  mtimeMs: number;
  size: number;
  sig: string;
  error?: string;
}

function statFileInfo(
  filePath: string,
  statFn: (p: string) => StatLike = statSync,
): FileStatInfo {
  try {
    const st = statFn(filePath);
    if (!st.isFile()) {
      return {
        exists: true,
        isFile: false,
        isMissing: false,
        mtimeMs: st.mtimeMs,
        size: st.size,
        sig: "notfile",
      };
    }
    return {
      exists: true,
      isFile: true,
      isMissing: false,
      mtimeMs: st.mtimeMs,
      size: st.size,
      sig: `${st.mtimeMs}:${st.size}`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const isMissing = code === "ENOENT" || code === "ENOTDIR";
    return {
      exists: false,
      isFile: false,
      isMissing,
      mtimeMs: -1,
      size: -1,
      sig: isMissing ? "missing" : `error:${code ?? "IO"}`,
      error: message,
    };
  }
}

export function resolveRuleContent(
  rule: ModelPromptRule,
  configPath: string,
  warnings: string[],
  resolveFile?: FileResolver,
  activeFileSigs?: Map<string, string>,
): string | undefined {
  if (rule.prompt !== undefined) {
    const trimmed = rule.prompt.replace(/^\uFEFF/, "").trim();
    if (!trimmed) {
      warnings.push(`${rule.id}: inline prompt is empty`);
      return undefined;
    }
    return trimmed;
  }

  if (rule.file !== undefined) {
    const targetPath = resolveRuleFilePath(rule.file, dirname(configPath));
    if (resolveFile) {
      const res = resolveFile(targetPath);
      if (activeFileSigs) {
        activeFileSigs.set(targetPath, res.statSig);
      }
      if (res.notRegularFile) {
        warnings.push(
          `${rule.id}: referenced path is not a regular file (${targetPath})`,
        );
        return undefined;
      }
      if (res.error !== undefined) {
        warnings.push(
          `${rule.id}: failed to read file (${targetPath}): ${res.error}`,
        );
        return undefined;
      }
      if (!res.content) {
        warnings.push(`${rule.id}: referenced file is empty (${targetPath})`);
        return undefined;
      }
      return res.content;
    }

    const st = statFileInfo(targetPath);
    if (!st.exists) {
      warnings.push(
        `${rule.id}: failed to read file (${targetPath}): ${st.error ?? "ENOENT"}`,
      );
      return undefined;
    }
    if (!st.isFile) {
      warnings.push(
        `${rule.id}: referenced path is not a regular file (${targetPath})`,
      );
      return undefined;
    }
    try {
      const content = readFileSync(targetPath, "utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      if (!content) {
        warnings.push(`${rule.id}: referenced file is empty (${targetPath})`);
        return undefined;
      }
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(
        `${rule.id}: failed to read file (${targetPath}): ${message}`,
      );
      return undefined;
    }
  }

  return undefined;
}

export interface ConfigStoreOptions {
  readFile?: (filePath: string) => string;
  stat?: (filePath: string) => StatLike;
}

interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

export class ReloadableConfigStore {
  private cachedConfigStat: string | null = null;
  private cachedConfigResult: ConfigLoadResult | null = null;
  private readonly fileCache = new Map<string, CachedFileEntry>();
  private readonly readFile: (filePath: string) => string;
  private readonly stat: (filePath: string) => StatLike;
  private readonly resolveFile: FileResolver;

  constructor(
    private readonly agentDir?: string,
    options?: ConfigStoreOptions,
  ) {
    this.readFile =
      options?.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
    this.stat = options?.stat ?? ((filePath) => statSync(filePath));
    this.resolveFile = this.makeResolver();
  }

  getConfigPath(): string {
    return resolveConfigPath(this.agentDir ?? getAgentDir());
  }

  private makeResolver(): FileResolver {
    return (absPath: string): FileResolveResult => {
      const st = statFileInfo(absPath, this.stat);
      if (!st.exists) {
        this.fileCache.delete(absPath);
        return { error: st.error ?? "ENOENT", statSig: st.sig };
      }
      if (!st.isFile) {
        this.fileCache.delete(absPath);
        return { notRegularFile: true, statSig: st.sig };
      }

      const cached = this.fileCache.get(absPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return { content: cached.content, statSig: st.sig };
      }

      try {
        const content = this.readFile(absPath)
          .replace(/^\uFEFF/, "")
          .trim();
        this.fileCache.set(absPath, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          content,
        });
        return { content, statSig: st.sig };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message, statSig: st.sig };
      }
    };
  }

  load(force = false): ConfigLoadResult {
    const configPath = this.getConfigPath();
    const configStat = statFileInfo(configPath, this.stat);

    if (
      !force &&
      this.cachedConfigResult &&
      this.cachedConfigStat === configStat.sig
    ) {
      return this.cachedConfigResult;
    }

    if (force) {
      this.fileCache.clear();
    }

    const warnings: string[] = [];
    let config = emptyConfig();
    let cacheable = true;

    if (!configStat.exists) {
      if (!configStat.isMissing) {
        warnings.push(
          `Failed to stat ${configPath}: ${configStat.error ?? "unknown error"}`,
        );
        cacheable = false;
      }
    } else if (!configStat.isFile) {
      warnings.push(`Config path is not a regular file: ${configPath}`);
    } else {
      let rawText: string | undefined;
      try {
        rawText = this.readFile(configPath).replace(/^\uFEFF/, "");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to read ${configPath}: ${message}`);
        cacheable = false;
      }

      if (rawText !== undefined) {
        try {
          const parsed = JSON.parse(rawText) as unknown;
          config = parseModelPromptsConfig(parsed, warnings);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Failed to parse ${configPath}: ${message}`);
          config = emptyConfig();
        }
      }
    }

    const result: ConfigLoadResult = {
      configPath,
      config,
      warnings,
      signature: cacheable ? configStat.sig : `uncached:${configStat.sig}`,
      resolveFile: this.resolveFile,
    };

    if (cacheable) {
      this.cachedConfigStat = configStat.sig;
      this.cachedConfigResult = result;
    } else {
      this.cachedConfigStat = null;
      this.cachedConfigResult = null;
    }

    return result;
  }

  clear(): void {
    this.cachedConfigStat = null;
    this.cachedConfigResult = null;
    this.fileCache.clear();
  }
}
