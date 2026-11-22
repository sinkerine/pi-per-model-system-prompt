export type InjectionMode =
  | "section"
  | "append"
  | "guidelines"
  | "prepend"
  | "replace";

export interface ModelRef {
  provider: string;
  id: string;
}

interface RuleBase {
  id: string;
  enabled: boolean;
  match: string[];
  override: boolean;
}

export type ModelPromptRule = RuleBase &
  (
    | { mode: InjectionMode; prompt?: string; file?: string; section?: string }
    | { mode: "substitute"; find: string; replacement: string }
  );

export interface ModelPromptsConfig {
  enabled: boolean;
  sectionName: string;
  rules: ModelPromptRule[];
}

interface ResolvedMatchBase {
  id: string;
  match: string[];
  source: string;
  content: string;
}

export type ResolvedMatch = ResolvedMatchBase &
  (
    | { mode: InjectionMode; sectionTag: string }
    | { mode: "substitute"; find: string }
  );

export interface FileResolveResult {
  content?: string;
  error?: string;
  notRegularFile?: boolean;
  statSig: string;
}

export type FileResolver = (absPath: string) => FileResolveResult;

export interface ConfigLoadResult {
  configPath: string;
  config: ModelPromptsConfig;
  warnings: string[];
  /** Config stat signature captured BEFORE reading model-prompts.json. */
  signature: string;
  resolveFile?: FileResolver;
}
