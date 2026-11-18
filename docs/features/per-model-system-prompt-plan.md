# Feature Plan — Per-Model System Prompt Injection (`pi-per-model-system-prompt`)

- **Feature slug**: `per-model-system-prompt`
- **Repository**: `/home/sinkerine/dev/pi-per-model-system-prompt`
- **Worktree**: `/home/sinkerine/.paseo/worktrees/1hbn9ggs/feat-per-model-system-prompt`
- **Branch / Base**: `feat/per-model-system-prompt` based on `main` @ `090ac8e`
- **Paseo workspace**: `wks_8fae82240d006375`
- **Target runtime**: `@earendil-works/pi-coding-agent` `1.5.2` (Node `>=22.19.0`)
- **Plan revision**: `r1` (`2026-11-18T11:40:00-08:00 PST`, `America/Los_Angeles`)

---

## 1. Problem & Goal

Different LLM families and model variants routed through Pi (e.g., Anthropic Claude, OpenAI GPT, Gemini, local Ollama models, or gateway models such as `magpie/group/gemini`) benefit from model-specific system-prompt instructions (formatting rules, reasoning conventions, tool-use habits, verbosity constraints) that should apply **only** when that model is active. Pi's built-in `SYSTEM.md` and `APPEND_SYSTEM.md` apply uniformly across every model in a session and do not adapt when a user switches models mid-session (`/model`, `Ctrl+P`, RPC `set_model` / `cycle_model`, or `pi.setModel()`).

`pi-per-model-system-prompt` is a standalone Pi coding-agent extension package that reads per-model prompt rules from the user's global Pi agent configuration directory (`<agentDir>/model-prompts.json`), matches rules against the currently active model (`provider/id` and bare `id`), and injects the resolved system-prompt instructions before each agent run — updating or removing them cleanly whenever the active model changes mid-session or the configuration changes on disk.

---

## 2. Scope & Exclusions

### In scope
1. Standalone TypeScript Pi extension package (`pi-per-model-system-prompt`) loadable via `pi -e`, `~/.pi/agent/extensions`, or `settings.json` `packages` / `extensions` with zero runtime npm dependencies.
2. Global JSON configuration at `join(getAgentDir(), "model-prompts.json")` (respecting `PI_CODING_AGENT_DIR`), supporting inline `"prompt"` strings and `"file"` references (UTF-8 Markdown/text files).
3. Case-insensitive exact and wildcard (`*`, `?`) matching against both `${model.provider}/${model.id}` and `${model.id}`, where `*` matches across `/` so gateway model IDs such as `magpie/group/gemini` match `"magpie/*"`.
4. Ordered multi-rule composition: matching rules concatenate in declaration order unless a matching rule sets `"override": true`, which discards earlier matched rules' contributions.
5. Structured system-prompt section injection by default (`mode: "section"` -> `<model_instructions>...</model_instructions>` via `event.systemPromptOptions.sections`), plus optional per-rule modes: `"append"`, `"guidelines"`, `"prepend"`, and `"replace"`.
6. Dynamic mid-session updates across model switches (`/model`, `Ctrl+P`, RPC `set_model` / `cycle_model`, `pi.setModel()`) and live on-disk edits to `model-prompts.json` or referenced prompt files without requiring `/reload`.
7. Graceful handling of missing config (silent no-op), malformed JSON / invalid rules, and missing referenced files (deduplicated UI warning when `ctx.hasUI` is true, never writing to `stdout` or crashing a turn).
8. Lightweight `/model-prompt` slash command (`status` default + `reload` subcommand) to inspect the active model's matched rules and reload configuration on demand.
9. Unit tests, real-Pi integration tests with a local loopback HTTP capturing fixture and disposable `PI_CODING_AGENT_DIR`, `README.md`, and root `AGENTS.md` recording checks and the user-approved explicit E2E exemption.

### Out of scope / exclusions
- **Project-local configuration** (`<cwd>/.pi/model-prompts.json`): explicitly excluded per user design decision. Only the global `<agentDir>/model-prompts.json` is read, preventing untrusted or local repositories from injecting or overriding per-model system prompts.
- **Interactive TUI rule editor / CRUD commands**: users edit `model-prompts.json` and referenced `.md` files directly with their editor.
- **Custom LLM tools (`pi.registerTool`)**: system-prompt injection is transparent infrastructure and must not add tool declarations or token overhead to the model's tool list.
- **Thinking-level or tool-set switching**: handled by Pi's built-in `/scoped-models` or presets; this extension strictly owns per-model system-prompt injection.
- **qex E2E suite**: explicitly exempted for this repository by user decision during design; full wire-level verification is covered by deterministic Vitest real-Pi integration tests against a local loopback HTTP stub.

---

## 3. Behavior & Design Decisions

### 3.1 Configuration Location & Schema (`<agentDir>/model-prompts.json`)
- Resolved via `join(getAgentDir(), "model-prompts.json")` using `getAgentDir()` from `@earendil-works/pi-coding-agent` (honors `PI_CODING_AGENT_DIR` with `~` expansion, defaulting to `~/.pi/agent/model-prompts.json`).
- Canonical JSON schema:
  ```json
  {
    "enabled": true,
    "sectionName": "model_instructions",
    "rules": [
      {
        "id": "anthropic-base",
        "match": ["anthropic/*", "*claude*"],
        "prompt": "Prefer concise answers and structured reasoning.",
        "mode": "section",
        "section": "model_instructions",
        "override": false,
        "enabled": true
      },
      {
        "id": "gemini-guide",
        "match": "magpie/group/gemini*",
        "file": "./prompts/gemini.md",
        "mode": "append"
      }
    ]
  }
  ```
- Field rules:
  - Top-level `enabled` (`boolean`, optional, default `true`): when `false`, disables all injection.
  - Top-level `sectionName` (`string`, optional, default `"model_instructions"`): default XML tag name for `"section"` mode. Must match Pi's section tag regex `/^[a-z][a-z0-9_-]*$/` and must **not** be one of Pi's reserved built-in section keys (`preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`).
  - `rules` (`array`, optional, default `[]`): evaluated in array order (`0 .. N-1`).
  - Per-rule fields:
    - `id` (`string`, optional): human-readable label for `/model-prompt` output and warning messages (defaults to `rule[<index>]`).
    - `enabled` (`boolean`, optional, default `true`): skips the rule when `false`.
    - `match` (`string | string[]`, required): non-empty trimmed pattern string or non-empty array of non-empty trimmed pattern strings (logical OR within a single rule).
    - Content source — **exactly one** of:
      - `prompt` (`string`): inline text (BOM-stripped; trimmed of leading/trailing blank lines or whitespace; empty/whitespace-only string produces a warning and skips the rule).
      - `file` (`string`): UTF-8 file path. Leading `~` / `~/` expands to `os.homedir()`; relative paths resolve against `dirname(configPath)` (`getAgentDir()`). Providing both `prompt` and `file`, or neither, invalidates that rule with a warning while keeping other valid rules.
    - `mode` (`"section" | "append" | "guidelines" | "prepend" | "replace"`, optional, default `"section"`).
    - `section` (`string`, optional): custom XML section tag override when `mode === "section"`; validated with the same tag rules as `sectionName` (warn and ignore rule if `section` is invalid or reserved).
    - `override` (`boolean`, optional, default `false`): when `true` and this rule matches **and** resolves valid non-empty content, discards all earlier matched rules' contributions before adding this rule.
  - Unknown top-level or rule keys produce a non-fatal validation warning rather than crashing.

### 3.2 Model Pattern Matching
- Active model is read from `ctx.model` (`{ provider: string, id: string }`). When `ctx.model` is `undefined`, no rules match.
- Candidate strings for matching (case-insensitive):
  1. Full canonical identifier: `${model.provider}/${model.id}` (e.g., `anthropic/claude-sonnet-4-5`, `magpie/group/gemini`).
  2. Bare model ID: `${model.id}` (e.g., `claude-sonnet-4-5`, `group/gemini`).
- Glob semantics (implemented as a pure zero-dependency compiler):
  - Escape all RegExp metacharacters except `*` and `?`, then compile `*` -> `.*` and `?` -> `.`, anchored `^...$` with `/i` flag.
  - `*` intentionally matches across `/` so patterns like `"magpie/*"` match `"magpie/group/gemini"` and `"openrouter/*"` match `"openrouter/moonshotai/kimi-k2.7-code"`.
  - `:` is matched literally (no `:thinkingLevel` suffix stripping) so colon-tagged model IDs such as `ollama/qwen3:32b` or `qwen3:*` match predictably.
- A rule matches if **any** pattern in its `match` list matches either `${model.provider}/${model.id}` or `${model.id}`.

### 3.3 Multi-Rule Composition & Injection Modes
- Given `ctx.model`, iterate valid enabled rules in declaration order:
  1. Test `matchesModel(rule.match, ctx.model)`. If `false`, continue.
  2. Resolve rule text (`rule.prompt` or UTF-8 contents of `rule.file`). If the referenced file is missing/unreadable or trims to empty, record a warning and skip this rule (**do not** trigger `override` clearing from a failed/empty rule).
  3. If `rule.override === true`, clear the accumulated `activeMatches` array.
  4. Append the resolved match `{ id, mode, sectionTag, content, source }` to `activeMatches`.
- Applying `activeMatches` in `before_agent_start(event, ctx)`:
  - If `activeMatches.length === 0`, return `undefined` without mutating `event.systemPromptOptions`. Because Pi normalizes a fresh `systemPromptOptions` copy from `_baseSystemPromptOptions` on every run, any `<model_instructions>` (or other custom section) injected on an earlier run with a different model is automatically absent and diffed out (`null` section patch / collapsed system prompt).
  - **When no match uses `mode: "replace"`**:
    1. `"guidelines"` matches: split each fragment by `\r?\n`, trim each line, strip an optional leading `- ` or `* ` bullet marker (since Pi's `buildSystemPromptSections` prepends `- ` to every `promptGuidelines` entry), drop empty lines, and push onto `event.systemPromptOptions.promptGuidelines`.
    2. `"append"` matches: join fragments with `"\n\n"` and append to `event.systemPromptOptions.appendSystemPrompt` (using `"\n\n"` if `appendSystemPrompt` is already non-empty).
    3. `"section"` matches: group fragments by `sectionTag` (preserving first-seen tag order), join each group with `"\n\n"`, and assign to `event.systemPromptOptions.sections[tag]` (appending with `"\n\n"` if an earlier extension already populated `sections[tag]`).
    4. If `"prepend"` matches exist: join `"prepend"` fragments with `"\n\n"` and return `{ systemPrompt: `${joinedPrepend}\n\n${event.systemPrompt}` }` (note: `event.systemPrompt` is a live getter in Pi 1.5.2 that already includes the structured mutations from steps 1–3).
    5. Otherwise (only `"section"`, `"append"`, and/or `"guidelines"`): return `undefined` so `forceSystemPrompt` stays unset and Pi's native structured section diffing and prompt-cache behavior remain intact.
  - **When one or more matches in `activeMatches` use `mode: "replace"`**:
    - Construct `systemPrompt` deterministically without mutating `event.systemPromptOptions`:
      - Optional `"prepend"` block (`\n\n`-joined)
      - `"replace"` block (`\n\n`-joined, forming the replaced base prompt)
      - Optional `"guidelines"` block rendered as `<rules>\n- ...\n</rules>`
      - Optional `"append"` block (`\n\n`-joined)
      - Optional `"section"` blocks rendered as `<tag>\n...\n</tag>`
      - Join non-empty blocks with `"\n\n"` and return `{ systemPrompt }`.

### 3.4 Reloading, Caching & Warning Discipline
- **No factory I/O**: the default extension factory only wires handlers and `/model-prompt`; it never touches disk, starts watchers/timers, or logs.
- **Stat-based live reload**: a lightweight cache stores `{ configMtimeMs, configSize, fileStats: Map<path, { mtimeMs, size }>, parsed }`. On `session_start`, `model_select`, `before_agent_start`, and `/model-prompt`, `statSync` checks `model-prompts.json` and any referenced `file` paths; if unchanged, the cached parse/contents are reused without re-parsing; if changed, created, or deleted, reload immediately.
- **Deduplicated warnings**: track `reportedWarnings: Set<string>` keyed by warning text; clear/reset when the underlying file stat signature changes or `/model-prompt reload` runs. Emit warnings only via `if (ctx.hasUI) ctx.ui.notify(msg, "warning")`. Never call `console.log` / `console.warn` / `console.error` (protects TUI rendering and RPC JSONL `stdout`).

### 3.5 Wire-Level Behavior Across Provider Compat Settings
- In Pi 1.5.2 (`@earendil-works/pi-ai`), `resolveTranscript` collapses mid-conversation section patches into `messages[0]` when `model.compat?.supportsMidConvoSystemMessages` is `false` (default for custom `models.json` providers, Gemini, etc.), and emits an in-place `Updated system prompt section "<tag>"` / `Removed system prompt section "<tag>"` message when `supportsMidConvoSystemMessages` is `true`.
- In both cases, `ctx.getSystemPrompt()` and `getCurrentSystemPrompt(transcript)` reflect **only** the current model's active prompt state, and for standard `supportsMidConvoSystemMessages: false` providers the wire `messages[0]` system prompt on Turn 2 (Model B) contains B's fragment and **not** A's fragment. Tests will assert both standard collapsed wire payloads and `supportsMidConvoSystemMessages: true` delta patches.

---

## 4. Protected State & Side-Effect Boundaries

1. **Never touch live user state in tests**: no test or script may read or modify `~/.pi`, `~/.config`, live `auth.json`, `models.json`, `settings.json`, or any running Paseo daemon.
2. **Complete test isolation**: all integration tests strip inherited `PI_*` environment variables (preserving only `PI_BINARY` if explicitly passed), point `PI_CODING_AGENT_DIR` and `--session-dir` to disposable directories under `${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/<run>/`, pass `--no-extensions --no-skills --no-prompt-templates -e <worktree>/extensions/per-model-system-prompt.ts`, and talk exclusively to an ephemeral `127.0.0.1:0` in-process Node HTTP server.
3. **Global-only config boundary**: project directories (`<cwd>/.pi/...`) are never read for model-prompt configuration.
4. **Clean stdout/stderr**: extension code never writes to `process.stdout` or `process.stderr`.

---

## 5. Acceptance Criteria & Documentation Requirements

### Functional Acceptance Criteria
- **AC1 — Global config loading & `PI_CODING_AGENT_DIR` isolation**: Loads `<agentDir>/model-prompts.json` via `getAgentDir()` (respecting `PI_CODING_AGENT_DIR`). Does not load `<cwd>/.pi/model-prompts.json` even if present in a trusted project. Missing `<agentDir>/model-prompts.json` is a silent no-op.
- **AC2 — Inline `prompt` and relative/tilde/absolute `file` resolution**: Supports rules with inline `"prompt"` strings and rules with `"file"` paths (UTF-8, BOM-stripped, resolved relative to `<agentDir>` or `~/`). Rejects rules specifying both or neither with a warning while keeping sibling valid rules.
- **AC3 — Case-insensitive exact & wildcard matching across `/` and `:`**: Matches single or array `"match"` patterns case-insensitively against `${model.provider}/${model.id}` and `${model.id}`, with `*` matching across `/` (e.g. `"magpie/*"` matches `magpie/group/gemini`) and `:` treated literally (e.g. `"ollama/qwen3:*"` matches `ollama/qwen3:32b`).
- **AC4 — Ordered multi-rule concatenation & `override: true`**: Concatenates all matching enabled rules in declaration order (`\n\n`), and when a matching rule with valid non-empty content sets `"override": true`, discards earlier matched rules' contributions while allowing subsequent matching rules to append after it. Top-level `"enabled": false` or rule `"enabled": false` disables injection as expected.
- **AC5 — Default structured `<model_instructions>` section & all optional modes**:
  - Default `mode: "section"` injects into `event.systemPromptOptions.sections[sectionTag]` (default `<model_instructions>...</model_instructions>`, or custom valid `sectionName` / `rule.section`, rejecting reserved Pi section names with a warning) without setting `forceSystemPrompt`.
  - `mode: "append"` appends to `event.systemPromptOptions.appendSystemPrompt` (`<addendum>`).
  - `mode: "guidelines"` appends normalized bullet items (without duplicate `- ` prefixes) to `event.systemPromptOptions.promptGuidelines` (`<rules>`).
  - `mode: "prepend"` prepends text ahead of the rendered system prompt while preserving Pi's structured prompt sections (`<tools>`, `<rules>`, `<cwd>`, etc.).
  - `mode: "replace"` replaces the base prompt for that run.
- **AC6 — Mid-session model switch updates & cleans up prompt**: In a real Pi RPC session starting on Model A, switching via `set_model` / `cycle_model` to Model B updates the outgoing provider HTTP request on the next prompt to carry Model B's instructions (and not Model A's active instructions); switching to an unmatched Model C removes all model-specific instructions cleanly. Works identically in `-p` print mode for single-shot runs.
- **AC7 — Live on-disk config/file reload & malformed-config resilience**: Modifying `model-prompts.json` or a referenced prompt `.md` file mid-session updates the injected prompt on the very next prompt without `/reload`. Malformed JSON, invalid rule fields, reserved section names, or missing referenced files never throw unhandled errors or block prompts, emit deduplicated `ctx.ui.notify(..., "warning")` notices when `ctx.hasUI` is true, and emit nothing on `stdout`/`stderr`.
- **AC8 — `/model-prompt` command**: `/model-prompt` (and `/model-prompt status`) notifies the user with the active model (`provider/id`), config path, matched rule IDs/patterns/modes, and any warnings; `/model-prompt reload` forces cache invalidation and re-reads config from disk.

### Required Documentation (`D1..D2`)
- **D1 — `README.md`**: Documents installation (`pi install`, `settings.json`, `-e`), `<agentDir>/model-prompts.json` schema with examples (inline prompts, `.md` file refs, gateway `/` wildcards, multi-rule layering + `override: true`, all 5 modes), mid-session model switching & live reload behavior, and `/model-prompt` usage.
- **D2 — Root `AGENTS.md`**: Documents architecture (`extensions/` adapter + pure `src/` modules), exact check commands (`npm ci`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm pack --dry-run`, load smoke check), NixOS Biome handling, scratch-dir isolation (`${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/<run>/`), build lock usage, and the **explicit E2E exemption** approved by the user during design.

---

## 6. Real Entry Paths, Lifecycle Transitions & Implementing Surfaces

### Real Entry Paths
1. **Pi extension loader (`extensions/per-model-system-prompt.ts`)**: loaded by `pi` via `-e`, `~/.pi/agent/extensions`, or `package.json` `"pi.extensions"` manifest in `"tui"`, `"rpc"`, `"print"`, and `"json"` modes.
2. **Agent prompt run (`before_agent_start`)**: triggered by interactive prompt, RPC `prompt`, `-p` print-mode prompt, `pi.sendUserMessage()`, or `pi.sendMessage(..., { triggerTurn: true })`.
3. **Model selection (`session_start` + `model_select`)**: initial/restored model on `session_start` (`startup | reload | new | resume | fork`) and mid-session switches via `/model`, `Ctrl+P`, RPC `set_model` / `cycle_model`, or `pi.setModel()`.
4. **Slash command (`/model-prompt`)**: invoked via interactive prompt or RPC `prompt` (`"/model-prompt"`, `"/model-prompt status"`, `"/model-prompt reload"`).

### State & Lifecycle Transitions
| Transition | Trigger | Expected State / Output Change |
| --- | --- | --- |
| Cold load (factory) | `pi` loads extension | Registers hooks & `/model-prompt`; zero disk I/O, timers, or side effects |
| Session start | `session_start` (`startup`, `reload`, `new`, `resume`, `fork`) | Stat-checks & loads `<agentDir>/model-prompts.json`; notifies new warnings once if `ctx.hasUI` |
| Model switch | `model_select` (`set`, `cycle`) | Refreshes stat-cached config; updates active match summary for `event.model` |
| Run start (matched model) | `before_agent_start` with matching `ctx.model` | Mutates `event.systemPromptOptions` (or returns `{ systemPrompt }` for `prepend`/`replace`) with resolved rules |
| Run start (switched A -> B) | `model_select(B)` then `before_agent_start` | Fresh `systemPromptOptions` receives B's rules only; A's section is diffed/collapsed out |
| Run start (switched -> unmatched C) | `model_select(C)` then `before_agent_start` | Handler returns `undefined` with no mutations; prior `<model_instructions>` removed via `null` diff / collapse |
| Live config edit on disk | User edits `model-prompts.json` or referenced `.md` file | Next `before_agent_start` or `/model-prompt` detects `mtimeMs`/`size` change, reloads, resets warning dedup for changed source |
| Missing / deleted config | File absent (`ENOENT`) | Treated as empty config (`rules: []`), no warning |
| Malformed config / missing `file` | Invalid JSON, bad schema, or unreadable `file` | Never throws; skips invalid config/rule; emits deduplicated warning via `ctx.ui.notify` when `ctx.hasUI` |
| Session shutdown | `session_shutdown` | Clears in-memory session warning/cache state idempotently |

### Implementing Surfaces
```text
pi-per-model-system-prompt/
├── AGENTS.md                                 # D2: repo instructions, check commands, scratch policy, E2E exemption
├── README.md                                 # D1: user documentation & config reference
├── LICENSE                                   # MIT license
├── .gitignore                                # node_modules/, *.tgz, .biome-bin/, coverage/
├── biome.json                                # Biome 2.6.6 config (matching pi-btw)
├── package.json                              # pi-package manifest, peerDeps, devDeps, scripts
├── tsconfig.json                             # Strict NodeNext TypeScript config (noEmit)
├── vitest.config.ts                          # Serial/deterministic Vitest defaults
├── extensions/
│   └── per-model-system-prompt.ts            # Thin Pi ExtensionAPI adapter (events, stat cache, /model-prompt)
├── src/
│   ├── types.ts                              # Config, Rule, InjectionMode, ResolvedMatch, Diagnostics types
│   ├── match.ts                              # Case-insensitive wildcard/exact matcher (provider/id + bare id)
│   ├── config.ts                             # Schema validation, file resolution, stat-keyedReloadableConfigStore
│   └── apply.ts                              # Rule evaluation (concat + override) & BuildSystemPromptOptions applier
└── tests/
    ├── support/
    │   ├── http-stub.ts                      # Loopback 127.0.0.1:0 OpenAI/Anthropic SSE capturing HTTP stub
    │   └── pi-rpc.ts                         # Disposable PI_CODING_AGENT_DIR + scratch helper for RPC & print runs
    ├── unit/
    │   ├── match.test.ts                     # Exact, wildcard, slash-in-id, colon-in-id, array match tests
    │   ├── config.test.ts                    # JSON validation, file refs, ~ expansion, stat reload, error cases
    │   └── apply.test.ts                     # Concat, override, disabled flags, all 5 modes, reserved tags
    └── integration/
        └── pi-runtime.integration.test.ts    # Real `pi` 1.5.2 RPC + print mode against capturing HTTP stub
```

---

## 7. Criterion → Test & Evidence Map

| Criterion | Unit Tests (`tests/unit/*`) | Real-Pi Integration (`tests/integration/pi-runtime.integration.test.ts`) | Package / Doc Checks |
| --- | --- | --- | --- |
| **AC1** (Global `<agentDir>/model-prompts.json`, ignore `<cwd>/.pi`, missing silent) | `config.test.ts`: missing file no-op, custom `agentDir` resolution | RPC run with disposable `PI_CODING_AGENT_DIR` + decoy `<cwd>/.pi/model-prompts.json` proves decoy is ignored | — |
| **AC2** (Inline `prompt` & `file` refs, mutual exclusion) | `config.test.ts`: inline, relative file, `~/` file, BOM strip, both/neither warnings | RPC run loading external `./prompts/beta.md` from `<agentDir>` | — |
| **AC3** (Case-insensitive wildcard/exact across `/` and `:`) | `match.test.ts`: `provider/id`, bare `id`, `magpie/*` -> `magpie/group/gemini`, `ollama/qwen3:*` -> `ollama/qwen3:32b`, `match: [...]` | RPC run matching `fixture/group/beta` via wildcard & slash model ID | — |
| **AC4** (Concatenation in order + `override: true` + `enabled`) | `apply.test.ts`: multi-rule concat, `override: true` clearing prior matches, failed rule not clearing, `enabled: false` | RPC run where `fixture/*` + `fixture/alpha` concatenate, while `fixture/group/beta` with `override: true` replaces `fixture/*` | — |
| **AC5** (`section` default + `append`, `guidelines`, `prepend`, `replace`) | `apply.test.ts`: verifies `systemPromptOptions` mutations vs `{ systemPrompt }` return, bullet normalization, reserved tag rejection | Real `pi` runs verifying captured wire payloads for `section` (`<model_instructions>`), `append` (`<addendum>`), `guidelines` (`<rules>`), `prepend`, and `replace` | — |
| **AC6** (Mid-session model switch A -> B -> unmatched C + print mode + `supportsMidConvoSystemMessages`) | `apply.test.ts`: sequential fresh `normalizeBuildSystemPromptOptions` runs | Real `pi --mode rpc`: Turn 1 (`fixture/alpha`) -> `set_model` (`fixture/group/beta`) Turn 2 has B and NOT A -> `set_model` (`other/gamma`) Turn 3 has neither; plus `supportsMidConvoSystemMessages: true` patch check; plus `pi -p` print mode check | — |
| **AC7** (Live disk reload + malformed config / missing file resilience + clean stdout) | `config.test.ts`: stat cache invalidation on file edit/delete, malformed JSON & missing file diagnostics | Real `pi --mode rpc`: edit `model-prompts.json` & `.md` file mid-session -> Turn N reflects new text without `/reload`; write invalid JSON -> warning UI event emitted, turn succeeds, RPC stdout stays valid JSONL | — |
| **AC8** (`/model-prompt` status & reload command) | Unit handler test for command output & warning summary | Real `pi --mode rpc`: send `"/model-prompt"` and `"/model-prompt reload"`, assert RPC `extension_ui_request` notify payload | — |
| **D1** (`README.md`) | — | — | Verifier inspects `README.md` + `npm pack --dry-run` includes `README.md`, `extensions/**`, `src/**` |
| **D2** (`AGENTS.md` + E2E exemption) | — | — | Verifier inspects root `AGENTS.md` commands, scratch paths, build lock, and explicit E2E exemption |

### Representative Capability Probe (Hardest Path)
Even though qex E2E is explicitly exempted, per `e2e-feature-v2` ("Before substantial initial-feature implementation, prove the hardest representative test path"), the executor should build the minimal vertical slice + `http-stub.ts` / `pi-rpc.ts` harness early and verify both:
1. **Baseline failure detection**: without the extension rule active, the captured HTTP request from real `pi` does not contain `<model_instructions>` (proving the capturing HTTP harness observes real `pi` wire requests accurately).
2. **Active + model-switch detection**: with `-e ./extensions/per-model-system-prompt.ts`, Turn 1 captures Model A's `<model_instructions>` and Turn 2 after `set_model` captures Model B's `<model_instructions>` without Model A's.

---

## 8. Task Breakdown

Single coherent sequential task **T1** (greenfield single-package extension <600 LOC; splitting implementation across tasks would add artificial handoff overhead over tightly coupled files).

### T1 — Implement `pi-per-model-system-prompt`, test suite, verification recipe, and documentation
- **Owner**: Executor (`magpie/group/gemini-speed`, medium thinking)
- **Dependencies**: Approved plan (`docs/features/per-model-system-prompt-plan.md`)
- **Owned paths**:
  - `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`
  - `src/types.ts`, `src/match.ts`, `src/config.ts`, `src/apply.ts`
  - `extensions/per-model-system-prompt.ts`
  - `tests/support/http-stub.ts`, `tests/support/pi-rpc.ts`, `tests/unit/*.test.ts`, `tests/integration/pi-runtime.integration.test.ts`
  - `README.md`, `AGENTS.md`
  - `<run dir>/verification.json` (if requested by orchestrator brief)
- **Do NOT touch**: `docs/features/per-model-system-prompt-plan.md` (owned by Design), `~/.pi/**`, running Paseo state.
- **Produced interfaces**:
  - Pi extension default export at `./extensions/per-model-system-prompt.ts` (declared in `package.json` `"pi.extensions"`).
  - Pure programmatic helpers in `src/` (`compileModelPattern`, `matchesModel`, `parseModelPromptsConfig`, `ReloadableConfigStore`, `resolveModelPrompts`, `applyModelPrompts`).

---

## 9. Exact Commands, Environment, Scratch Data & Locks

### Scratch & Isolation Paths
- Reusable npm cache (optional if needed): `${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/npm-cache`
- Disposable test runtime root (`PI_MODEL_PROMPT_TEST_SCRATCH_DIR`):
  `${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/test-runs/`
  - `tests/support/pi-rpc.ts` creates per-test `mkdtemp` subdirectories under `${PI_MODEL_PROMPT_TEST_SCRATCH_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/test-runs}` and removes only its own per-test directory in `finally` when the test passes.
- Shared Paseo feature build lock:
  `/home/sinkerine/dev/pi-per-model-system-prompt/.git/worktrees/feat-per-model-system-prompt/e2e-feature-build.lock`
  - Acquire once around actual build/install/check commands (`flock --close <build-lock> <command>`); never hold idle while editing.

### NixOS Biome Note
- On NixOS (`kazuki`), the prebuilt `@biomejs/biome` Linux binary in `node_modules` may require the system `NIX_LD` dynamic loader if invoked bare. Follow `~/dev/pi-btw` conventions: check `npx biome --version`; if needed on NixOS without `NIX_LD` exported in non-login shells, provide a small gitignored local wrapper (e.g. `.biome-bin/biome`) or `NIX_LD` resolution in a local script without modifying host/system configuration.

### Prerequisite & Discovery Commands
```bash
node --version          # Expect >= v22.19.0 (host has v24.22.2)
npm --version
pi --version            # Expect 1.5.2 on PATH (/home/sinkerine/.nix-profile/bin/pi)
```

### Setup / Install
```bash
npm install --cache "${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/npm-cache"
# Subsequent deterministic installs once package-lock.json exists:
npm ci --cache "${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/npm-cache"
```

### Verification Check Inventory (All Non-qex)
1. **Typecheck (`typecheck`)**:
   ```bash
   npm run typecheck
   # -> tsc --noEmit
   ```
2. **Lint & Format check (`lint`)**:
   ```bash
   npm run lint
   # -> biome check .
   ```
3. **Unit tests (`test-unit`)**:
   ```bash
   npm run test:unit
   # -> vitest run tests/unit --bail=1
   ```
4. **Real-Pi Integration tests (`test-integration`)**:
   ```bash
   PI_BINARY=pi npm run test:integration
   # -> vitest run tests/integration --maxWorkers=1 --bail=1
   ```
5. **Extension load smoke check (`smoke-load`)**:
   ```bash
   tmpdir="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/smoke-XXXXXX")"
   trap 'rm -rf "$tmpdir"' EXIT
   PI_CODING_AGENT_DIR="$tmpdir" pi --offline --no-session --no-extensions -e ./extensions/per-model-system-prompt.ts --help >/dev/null
   ```
6. **Package tarball contents check (`pack-check`)**:
   ```bash
   npm pack --dry-run --json
   # Verify tarball includes extensions/per-model-system-prompt.ts, src/*.ts, README.md, LICENSE, package.json; excludes tests/ and AGENTS.md if desired or keeps tarball clean.
   ```

### Teardown
- Each integration test closes its spawned `pi` child process (`SIGTERM` -> `SIGKILL` fallback) and closes its `127.0.0.1` HTTP server (`server.closeAllConnections()` + `server.close()`) in `try / finally`, then deletes its owned per-test scratch directory.

---

## 10. E2E Policy & Resource Cost Record

- **E2E classification**: **Explicit E2E Exemption** (decided by user via `ask_user` during design on `2026-11-18`).
- **Root `AGENTS.md` E2E statement**: The executor must include an explicit `## E2E Exemption` section in root `AGENTS.md` stating that this standalone in-process Pi extension repository is explicitly exempt from qex E2E stacks, and that wire-level behavior (real `pi` binary in RPC and print modes against an isolated loopback HTTP capturing fixture with disposable `PI_CODING_AGENT_DIR`) is verified via `npm run test:integration` alongside `npm run test:unit`.
- **Resource footprint (informational, non-qex)**: `npm run test:integration` runs serially (`--maxWorkers=1`), spawning 1 Vitest worker + 1 `pi` CLI child + 1 in-process loopback `node:http` server (~1–2 CPU cores, <512 MiB RSS, <30s wall time). Because the repository is explicitly exempt from qex E2E, no `qex-e2e` block or `agent-job` submission is used.

---

## 11. Execution Roles (`e2e-feature-v2`)

| Role | Model | Thinking | Responsibility |
| --- | --- | --- | --- |
| Orchestrator | `magpie/group/agy-opus` | high | Coordinate milestones, inspect evidence/diffs, manage goal, commit & merge delivery |
| Design | `magpie/group/gemini` | high | Independent visible Paseo tab; owns `docs/features/per-model-system-prompt-plan.md` & human approval |
| Executor | `magpie/group/gemini-speed` | medium | Direct `worker` subagent; owns all implementation, tests, tooling, `README.md`, root `AGENTS.md`, and repairs |
| Reviewer | `magpie/group/sol-fast` | high | Direct `reviewer` subagent; independent read-only review (max 3 rounds per scope) |
| Verifier | `magpie/group/sol-fast` | medium | Direct `worker` subagent; independent execution of checks & criterion-to-test audit; no code edits |

---

## 12. Material Tradeoffs & Recorded Design Decisions

1. **Global-only `<agentDir>/model-prompts.json` vs project-local `.pi/`**: User chose **Global JSON config only**. *Tradeoff*: teams cannot check shared model prompts into a repo's `.pi/` folder, in exchange for simpler mental model, zero untrusted-repo prompt-injection surface, and a single source of truth in `~/.pi/agent/model-prompts.json`.
2. **Ordered rule concatenation + `override: true` vs single winner**: User chose **Concatenate matching rules (with optional `override`)**. *Tradeoff*: authors must set `"override": true` when a specialized rule should replace a broader wildcard rule rather than add to it, in exchange for natural composition of provider-wide defaults (`anthropic/*`) with model-specific additions (`anthropic/claude-opus-*`).
3. **Structured `<model_instructions>` section default + optional modes vs plain string concatenation**: User chose **Structured section default + optional modes (`section`, `append`, `guidelines`, `prepend`, `replace`)**. *Tradeoff*: slightly richer `apply.ts` (~60 LOC), in exchange for preserving Pi 1.5.2's native diffable structured sections and prompt caching in the default path while still accommodating users who need raw `prepend`, `append`, `guidelines`, or `replace`.
4. **Explicit E2E exemption + real-Pi Vitest integration vs qex E2E journey**: User chose **Explicit E2E exemption**. *Tradeoff*: skips `qex`/`agent-job` queueing ceremony, while `npm run test:integration` still exercises the exact real `pi` binary and captured HTTP wire payloads in isolated scratch state.
5. **Literal `:` in model patterns (agent design decision)**: `:` is matched literally rather than parsed as a `:thinkingLevel` suffix so colon-tagged model IDs (`ollama/qwen3:32b`) work without ambiguity.
6. **Zero runtime npm dependencies (agent design decision)**: Wildcard matching (`*`, `?`) is implemented directly in ~20 lines of TypeScript RegExp compilation rather than adding `minimatch` to `dependencies`, keeping `pi install` offline-friendly and avoiding `minimatch`'s `/` path-separator restriction on gateway model IDs like `magpie/group/gemini`.

---

## Approval

- **Status**: Approved by the user (`r1`).
- **Reviewed plan revision**: `r1` (`2026-11-18T11:40:00-08:00 PST`, `America/Los_Angeles`)
- **Reviewed plan body SHA-256** (exact UTF-8 bytes preceding `\n## Approval\n`): `1269e844d420347ba1806edfe8aa46af29145f6f3bdaec51b8e4d8f1fecb3a98`
- **Approved at**: `2026-11-18T11:46:15-08:00 PST` (`America/Los_Angeles`)
- **Requirements & E2E gate (`ask_user` batch — `"Per-model system prompt — requirements & E2E journey alignment"`)**:
  1. `"Where and in what format should per-model system prompts be configured?"` → `Global JSON config only`
  2. `"How should rules match models and behave when multiple rules match?"` → `Concatenate matching rules (with optional override)`
  3. `"How should matched fragments be injected into Pi's system prompt?"` → `Structured section default + optional modes`
  4. `"Should we define the isolated real-Pi E2E journey for root AGENTS.md, or exempt this repo from qex E2E?"` → `Explicit E2E exemption (unit + integration only)`
- **Final plan approval question (`ask_user` verbatim)**:
  `"Do you approve the per-model-system-prompt feature plan (revision r1, SHA-256 1269e844d420347ba1806edfe8aa46af29145f6f3bdaec51b8e4d8f1fecb3a98) for implementation?"`
- **User's explicit answer (`ask_user` verbatim)**:
  `"User answered: Approve plan"`
