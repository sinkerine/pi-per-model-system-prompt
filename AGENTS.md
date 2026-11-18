# AGENTS.md — `pi-per-model-system-prompt`

Standalone Pi coding-agent extension package (`@sinkerine/pi-per-model-system-prompt`) that injects per-model system-prompt rules from `<agentDir>/model-prompts.json` (`PI_CODING_AGENT_DIR` / `~/.pi/agent/model-prompts.json`).

## Architecture

- `extensions/per-model-system-prompt.ts`: thin Pi `ExtensionAPI` adapter wiring `session_start`, `model_select`, `before_agent_start`, `session_shutdown`, and `/model-prompt`. Zero factory disk I/O and zero `stdout`/`stderr`/`console.*` output.
- `src/types.ts`: shared TypeScript types for configuration, rules, injection modes, and diagnostics.
- `src/match.ts`: zero-dependency case-insensitive wildcard (`*`, `?`) and exact matcher against `${model.provider}/${model.id}` and `${model.id}` (`*` matches across `/`; `:` is matched literally).
- `src/config.ts`: schema validation, reserved Pi section tag checks, `~/` and relative file resolution, BOM stripping, and `ReloadableConfigStore` (stat-keyed cache over `model-prompts.json` and referenced files).
- `src/apply.ts`: ordered rule evaluation (concatenation + `override: true`) and `BeforeAgentStartEvent` injection across `section`, `append`, `guidelines`, `prepend`, and `replace` modes.
- `tests/support/`: `http-stub.ts` (loopback `127.0.0.1:0` capturing SSE stub) and `pi-rpc.ts` (isolated `PI_CODING_AGENT_DIR` + scratch driver for RPC and print-mode runs).

## Protected State & Scratch Isolation

- Never read or modify `~/.pi`, `~/.config`, live `auth.json`/`models.json`/`settings.json`, or any running Paseo daemon in tests.
- Integration tests strip inherited `PI_*` env vars (preserving only `PI_BINARY` for spawning `pi`) and create disposable per-test directories under:
  - `${PI_MODEL_PROMPT_TEST_SCRATCH_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/test-runs}`
- Reusable npm cache path:
  - `${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/npm-cache`

## Build Lock

When running install, build, lint, or test commands in parallel-agent workflows, wrap commands with `flock --close <lock> <cmd>` using the worktree's `e2e-feature-build.lock` (never hold the lock idle while editing):

```bash
flock --close /home/sinkerine/dev/pi-per-model-system-prompt/.git/worktrees/feat-per-model-system-prompt/e2e-feature-build.lock <command>
```

## NixOS Biome Note

`biome` (`@biomejs/biome` 2.6.6) is configured via `biome.json` (excluding `docs/features/**`). On NixOS hosts where the prebuilt `@biomejs/biome` binary requires `NIX_LD`, ensure `NIX_LD` is set or provide a gitignored local wrapper under `.biome-bin/biome` without modifying host/system configuration.

## Development & Verification Commands

```bash
# Deterministic install
npm ci --cache "${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt/npm-cache"

# Typecheck & lint
npm run typecheck
npm run lint

# Unit tests
npm run test:unit

# Real-Pi integration tests (serial, isolated loopback HTTP stub)
PI_BINARY=pi npm run test:integration

# Extension load smoke check
scratch_parent="${XDG_CACHE_HOME:-$HOME/.cache}/dev-scratch/pi-per-model-system-prompt"
mkdir -p "$scratch_parent"
tmpdir="$(mktemp -d "$scratch_parent/smoke-XXXXXX")" || exit 1
trap 'rm -rf "$tmpdir"' EXIT
PI_CODING_AGENT_DIR="$tmpdir" pi --offline --no-session --no-extensions -e ./extensions/per-model-system-prompt.ts --help >/dev/null

# Package tarball contents check
npm pack --dry-run --json
```

## E2E Exemption

This standalone in-process Pi extension repository is **explicitly exempt from qex E2E stacks** (approved by user decision during feature design). Wire-level behavior — including real `pi` CLI execution in RPC and `-p` print modes against an isolated `127.0.0.1:0` loopback HTTP capturing stub with disposable `PI_CODING_AGENT_DIR` — is verified deterministically via `PI_BINARY=pi npm run test:integration` alongside `npm run test:unit`.
