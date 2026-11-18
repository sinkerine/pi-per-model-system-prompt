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

export interface ModelPromptRule {
  id: string;
  enabled: boolean;
  match: string[];
  prompt?: string;
  file?: string;
  mode: InjectionMode;
  section?: string;
  override: boolean;
}

export interface ModelPromptsConfig {
  enabled: boolean;
  sectionName: string;
  rules: ModelPromptRule[];
}

export interface ResolvedMatch {
  id: string;
  match: string[];
  mode: InjectionMode;
  sectionTag: string;
  content: string;
  source: string;
}

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
