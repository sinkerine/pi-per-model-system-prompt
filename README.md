# pi-per-model-system-prompt

Per-model system prompt injection for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

`pi-per-model-system-prompt` reads global per-model prompt rules from `<agentDir>/model-prompts.json` (`~/.pi/agent/model-prompts.json` by default, honoring `PI_CODING_AGENT_DIR`), matches rules against the active model (`provider/id` and bare `id`), and dynamically updates or removes the injected instructions whenever you switch models mid-session or edit your prompt files on disk.

## Installation

### Via `pi install`

```bash
pi install npm:@sinkerine/pi-per-model-system-prompt
```

### Via `settings.json`

Add the package or extension path to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@sinkerine/pi-per-model-system-prompt"]
}
```

### Ad-hoc via `-e`

```bash
pi -e /path/to/pi-per-model-system-prompt/extensions/per-model-system-prompt.ts
```

## Configuration (`<agentDir>/model-prompts.json`)

Only the global `<agentDir>/model-prompts.json` is read (project-local `<cwd>/.pi/model-prompts.json` files are ignored). Missing `model-prompts.json` is a silent no-op.

```json
{
  "enabled": true,
  "sectionName": "model_instructions",
  "rules": [
    {
      "id": "magpie-shared",
      "match": "magpie/*",
      "prompt": "Follow gateway formatting conventions.",
      "mode": "section"
    },
    {
      "id": "magpie-claude-layered",
      "match": ["magpie/group/*claude*", "*claude*"],
      "prompt": "Keep explanations concise.",
      "mode": "append"
    },
    {
      "id": "magpie-gemini-override",
      "match": "magpie/group/gemini*",
      "file": "./prompts/gemini.md",
      "mode": "section",
      "override": true
    },
    {
      "id": "ollama-qwen-rules",
      "match": "ollama/qwen3:*",
      "prompt": "- Always verify file paths before editing\n- Keep shell commands minimal",
      "mode": "guidelines"
    },
    {
      "id": "local-prepend",
      "match": "lmstudio/*",
      "prompt": "CRITICAL: Respond in JSON only.",
      "mode": "prepend"
    },
    {
      "id": "minimal-replace",
      "match": "custom/bare-model",
      "prompt": "You are a minimal domain assistant.",
      "mode": "replace"
    }
  ]
}
```

In the example above, `magpie/group/claude-sonnet` receives both `magpie-shared` (`<model_instructions>`) and `magpie-claude-layered` (`<addendum>`), whereas `magpie/group/gemini` sets `"override": true`, discarding `magpie-shared` and using only `./prompts/gemini.md`.

### Top-level Fields

- `enabled` (`boolean`, optional, default `true`): disables all injection when `false`.
- `sectionName` (`string`, optional, default `"model_instructions"`): default XML tag name for `"section"` mode. Must match `/^[a-z][a-z0-9_-]*$/` and must not be a reserved Pi section name (`preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`).
- `rules` (`array`, optional, default `[]`): ordered list of rule objects evaluated from index `0` to `N-1`.

### Rule Fields

- `id` (`string`, optional): human-readable label for `/model-prompt` and warnings (defaults to `rule[<index>]`).
- `enabled` (`boolean`, optional, default `true`): skips the rule when `false`.
- `match` (`string | string[]`, required): case-insensitive exact or wildcard (`*`, `?`) pattern(s) tested against both `${model.provider}/${model.id}` and `${model.id}`.
  - `*` matches across `/`, so `"magpie/*"` matches `magpie/group/gemini`.
  - `:` is matched literally, so `"ollama/qwen3:*"` matches `ollama/qwen3:32b`.
- Content source (specify **exactly one** for modes other than `"substitute"`):
  - `prompt` (`string`): inline instruction text.
  - `file` (`string`): UTF-8 Markdown/text file path (`~/` expands to home directory; relative paths resolve from `<agentDir>`).
- `mode` (`"section" | "append" | "guidelines" | "prepend" | "replace" | "substitute"`, optional, default `"section"`):
  - `"section"` (default): injects into Pi's structured `sections[tag]` (`<model_instructions>...</model_instructions>` or custom `section`), preserving Pi's native section diffing and prompt caching.
  - `"append"`: appends to `appendSystemPrompt` (`<addendum>`).
  - `"guidelines"`: appends normalized bullet items to `promptGuidelines` (`<rules>`).
  - `"prepend"`: prepends text before the rendered system prompt while keeping structured sections intact.
  - `"replace"`: replaces the base system prompt for the turn while deterministically rendering any accompanying `prepend`, `guidelines`, `append`, or `section` matches.
  - `"substitute"`: applies literal, case-sensitive text edits to the rendered system prompt after the other matched modes. Substitutions run in rule order and replace all occurrences. If the text is absent, the rule leaves the prompt unchanged.
- `find` (non-empty string) and `replacement` (string, may be empty to delete text): both required for `"substitute"`. Do not set `prompt`, `file`, or `section` on a substitution rule.
- `section` (`string`, optional): custom XML tag override for `"section"` mode (same tag validation rules as `sectionName`).
- `override` (`boolean`, optional, default `false`): when `true` and this rule resolves successfully, discards all earlier matched rules' contributions before adding this rule.

### Literal Substitution Example

```json
{
  "rules": [
    {
      "match": "magpie/group/gemini",
      "mode": "substitute",
      "find": "non-LLM models such as classifiers and image models",
      "replacement": "non-LLM models including classifiers and image models"
    }
  ]
}
```

When a substitution changes the text, Pi sends the resulting full system prompt for that turn rather than using its native section-diff path. The rule does not change the available tools.

## Mid-Session Model Switching & Live Reload

- Switching models mid-session (`/model`, `Ctrl+P`, RPC `set_model` / `cycle_model`, or `pi.setModel()`) updates the injected instructions on the very next prompt, and removes them cleanly when switching to an unmatched model.
- Editing `model-prompts.json` or any referenced `.md` file on disk is detected automatically via `mtimeMs`/`size` stat checks on the next turn without requiring `/reload`.
- Malformed JSON, invalid rule fields, or missing referenced files never crash a turn; deduplicated warnings are shown via `ctx.ui.notify(..., "warning")` when a UI is attached.

## Slash Command

- `/model-prompt` (or `/model-prompt status`): displays the active model (`provider/id`), config path, matched rules/modes, and any active warnings.
- `/model-prompt reload`: forces cache invalidation, re-reads `<agentDir>/model-prompts.json` and referenced files from disk, and displays the updated status.

## License

MIT
