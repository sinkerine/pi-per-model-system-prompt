import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyModelPrompts, resolveModelPrompts } from "../src/apply.js";
import { ReloadableConfigStore } from "../src/config.js";
import type { ModelRef } from "../src/types.js";

export interface ExtensionOptions {
  store?: ReloadableConfigStore;
}

export default function perModelSystemPrompt(
  pi: ExtensionAPI,
  options?: ExtensionOptions,
): void {
  const store = options?.store ?? new ReloadableConfigStore();
  const observedSourceSigs = new Map<string, string>();
  const reportedWarnings = new Set<string>();

  function emitWarnings(
    ctx: ExtensionContext,
    currentSources: ReadonlyMap<string, string>,
    warnings: readonly string[],
  ): void {
    let existingSourceChanged = false;
    for (const [sourceKey, sig] of currentSources) {
      const prev = observedSourceSigs.get(sourceKey);
      if (prev !== undefined && prev !== sig) {
        existingSourceChanged = true;
      }
      observedSourceSigs.set(sourceKey, sig);
    }
    if (existingSourceChanged) {
      reportedWarnings.clear();
    }
    if (!ctx.hasUI) return;
    for (const warning of warnings) {
      if (reportedWarnings.has(warning)) continue;
      reportedWarnings.add(warning);
      ctx.ui.notify(warning, "warning");
    }
  }

  function evaluate(model: ModelRef | undefined, force = false) {
    const loaded = store.load(force);
    const warnings = [...loaded.warnings];
    const currentSources = new Map<string, string>([
      ["config", loaded.signature],
    ]);
    const matches = resolveModelPrompts(
      loaded.config,
      loaded.configPath,
      model,
      warnings,
      loaded.resolveFile,
      currentSources,
    );
    return { loaded, currentSources, warnings, matches };
  }

  function formatStatus(
    model: ModelRef | undefined,
    force = false,
  ): { text: string; warnings: string[]; signature: string } {
    const { loaded, warnings, matches } = evaluate(model, force);
    const modelLabel = model ? `${model.provider}/${model.id}` : "(none)";
    const lines = [
      `Model: ${modelLabel}`,
      `Config: ${loaded.configPath} (enabled=${loaded.config.enabled})`,
    ];
    if (matches.length === 0) {
      lines.push("Matched rules: (none)");
    } else {
      lines.push(
        `Matched rules (${matches.length}): ${matches
          .map((m) => {
            const modeLabel =
              m.mode === "section" ? `section:<${m.sectionTag}>` : m.mode;
            return `${m.id} [match=${m.match.join("|")}, ${modeLabel}, ${m.source}]`;
          })
          .join(", ")}`,
      );
    }
    if (warnings.length > 0) {
      lines.push(`Warnings (${warnings.length}): ${warnings.join("; ")}`);
    }
    return { text: lines.join("\n"), warnings, signature: loaded.signature };
  }

  pi.on("session_start", (_event, ctx) => {
    const { currentSources, warnings } = evaluate(
      ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined,
    );
    emitWarnings(ctx, currentSources, warnings);
  });

  pi.on("model_select", (event, ctx) => {
    const { currentSources, warnings } = evaluate({
      provider: event.model.provider,
      id: event.model.id,
    });
    emitWarnings(ctx, currentSources, warnings);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const { currentSources, warnings, matches } = evaluate(
      ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined,
    );
    emitWarnings(ctx, currentSources, warnings);
    return applyModelPrompts(event, matches);
  });

  pi.on("session_shutdown", () => {
    store.clear();
    observedSourceSigs.clear();
    reportedWarnings.clear();
  });

  pi.registerCommand("model-prompt", {
    description:
      "Inspect active per-model system prompt rules or reload config",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub !== "" && sub !== "status" && sub !== "reload") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Usage: /model-prompt [status|reload] (unknown subcommand "${sub}")`,
            "warning",
          );
        }
        return;
      }

      const force = sub === "reload";
      if (force) {
        observedSourceSigs.clear();
        reportedWarnings.clear();
      }

      const model = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      const status = formatStatus(model, force);
      if (ctx.hasUI) {
        ctx.ui.notify(
          force ? `Reloaded.\n${status.text}` : status.text,
          status.warnings.length > 0 ? "warning" : "info",
        );
      }
    },
  });
}
