import type { ModelRef } from "./types.js";

const REGEXP_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

export function compileModelPattern(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(REGEXP_SPECIAL_CHARS, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesModel(
  patterns: readonly string[],
  model: ModelRef | undefined,
): boolean {
  if (!model) return false;
  const fullId = `${model.provider}/${model.id}`;
  const bareId = model.id;

  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim();
    if (!trimmed) continue;
    const regex = compileModelPattern(trimmed);
    if (regex.test(fullId) || regex.test(bareId)) {
      return true;
    }
  }
  return false;
}
