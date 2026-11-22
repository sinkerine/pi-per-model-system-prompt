import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

export interface RpcRecord {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  method?: string;
  message?: unknown;
  notifyType?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function until<T>(
  read: () => T | undefined,
  label: string,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await setTimeout(20);
  }
  throw new Error(`Timed out: ${label}`);
}

export function getScratchRoot(): string {
  const explicit = process.env.PI_MODEL_PROMPT_TEST_SCRATCH_DIR?.trim();
  if (explicit) return explicit;
  const xdgCache = process.env.XDG_CACHE_HOME?.trim();
  const cacheBase = xdgCache || join(homedir(), ".cache");
  return join(
    cacheBase,
    "dev-scratch",
    "pi-per-model-system-prompt",
    "test-runs",
  );
}

export interface PiFixtureOptions {
  baseUrl: string;
  extensionPath?: string;
  extraExtensions?: string[];
  defaultProvider?: string;
  defaultModel?: string;
}

export class PiFixture {
  records: RpcRecord[] = [];
  stderr = "";
  nonJsonStdout: string[] = [];
  private process: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;

  private constructor(
    readonly directory: string,
    readonly workDir: string,
    readonly extensionPath: string,
    readonly extraExtensions: readonly string[],
    readonly defaultProvider: string,
    readonly defaultModel: string,
  ) {}

  static async create(options: PiFixtureOptions): Promise<PiFixture> {
    const scratchRoot = getScratchRoot();
    await mkdir(scratchRoot, { recursive: true });
    const directory = await mkdtemp(join(scratchRoot, "run-"));
    const workDir = join(directory, "work");
    await mkdir(workDir, { recursive: true });
    await mkdir(join(directory, "sessions"), { recursive: true });

    const defaultProvider = options.defaultProvider ?? "fixture";
    const defaultModel = options.defaultModel ?? "alpha";

    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        defaultProvider,
        defaultModel,
        defaultThinkingLevel: "off",
        transport: "sse",
        cacheWarming: "off",
        enableInstallTelemetry: false,
        compaction: {
          enabled: false,
          keepRecentTokens: 32,
          reserveTokens: 256,
        },
        retry: { enabled: false },
        codemode: { enabled: false },
      }),
    );

    const modelTemplate = (id: string, compat?: Record<string, unknown>) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
      ...(compat ? { compat } : {}),
    });

    await writeFile(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${options.baseUrl}/v1`,
            api: "openai-completions",
            apiKey: "public-fixture-key",
            models: [modelTemplate("alpha"), modelTemplate("group/beta")],
          },
          other: {
            baseUrl: `${options.baseUrl}/v1`,
            api: "openai-completions",
            apiKey: "public-fixture-key",
            models: [modelTemplate("gamma")],
          },
          midconvo: {
            baseUrl: `${options.baseUrl}/v1`,
            api: "openai-completions",
            apiKey: "public-fixture-key",
            models: [
              modelTemplate("one", { supportsMidConvoSystemMessages: true }),
              modelTemplate("two", { supportsMidConvoSystemMessages: true }),
              modelTemplate("three", { supportsMidConvoSystemMessages: true }),
            ],
          },
        },
      }),
    );

    return new PiFixture(
      directory,
      workDir,
      options.extensionPath ?? resolve("extensions/per-model-system-prompt.ts"),
      options.extraExtensions ?? [],
      defaultProvider,
      defaultModel,
    );
  }

  async writeModelPrompts(config: unknown): Promise<void> {
    await writeFile(
      join(this.directory, "model-prompts.json"),
      typeof config === "string" ? config : JSON.stringify(config, null, 2),
      "utf8",
    );
  }

  async writeAgentFile(relativePath: string, content: string): Promise<string> {
    const target = join(this.directory, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return target;
  }

  async writeWorkFile(relativePath: string, content: string): Promise<string> {
    const target = join(this.workDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return target;
  }

  buildChildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("PI_")) delete env[key];
    }
    env.PI_CODING_AGENT_DIR = this.directory;
    env.PI_TELEMETRY = "0";
    return env;
  }

  async start(): Promise<void> {
    this.records = [];
    this.stderr = "";
    this.nonJsonStdout = [];

    const env = this.buildChildEnv();
    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      this.extensionPath,
      ...this.extraExtensions.flatMap((ext) => ["-e", ext]),
      "--provider",
      this.defaultProvider,
      "--model",
      this.defaultModel,
      "--tools",
      "read,bash",
      "--session-dir",
      join(this.directory, "sessions"),
    ];

    const piBinary = process.env.PI_BINARY?.trim() || "pi";
    const child = spawn(piBinary, args, {
      cwd: this.workDir,
      env,
      stdio: "pipe",
    });
    this.process = child;

    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim().length > 0) {
          try {
            const record = JSON.parse(line) as RpcRecord;
            this.records.push(record);
          } catch {
            this.nonJsonStdout.push(line);
            this.stderr += `Non-JSON stdout: ${line}\n`;
          }
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.on("error", (error) => {
      this.stderr += error.message;
    });

    await this.rpc("get_commands");
  }

  async runPrint(
    promptText: string,
    provider = this.defaultProvider,
    model = this.defaultModel,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const env = this.buildChildEnv();
    const args = [
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      this.extensionPath,
      "--provider",
      provider,
      "--model",
      model,
      "--tools",
      "read,bash",
      promptText,
    ];
    const piBinary = process.env.PI_BINARY?.trim() || "pi";
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(piBinary, args, {
        cwd: this.workDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", rejectRun);
      child.on("exit", (exitCode) => {
        resolveRun({ exitCode, stdout, stderr });
      });
    });
  }

  async rpc(type: string, fields: object = {}): Promise<RpcRecord> {
    const child = this.process;
    if (!child) throw new Error("Pi not started");
    const id = String(++this.sequence);
    child.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
    const record = await until(
      () =>
        this.records.find(
          (entry) => entry.type === "response" && entry.id === id,
        ),
      `${type}; stderr=${this.stderr}`,
      30000,
    );
    if (!record.success) {
      throw new Error(`${type}: ${record.error}; stderr=${this.stderr}`);
    }
    return record;
  }

  async prompt(message: string): Promise<void> {
    const before = this.records.length;
    await this.rpc("prompt", { message });
    await until(
      () =>
        this.records
          .slice(before)
          .find((entry) => entry.type === "agent_settled"),
      `agent_settled after prompt; stderr=${this.stderr}`,
      30000,
    );
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.rpc("set_model", { provider, modelId });
  }

  async cycleModel(): Promise<RpcRecord> {
    return this.rpc("cycle_model");
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = null;
    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });

    child.kill("SIGTERM");
    const winner = await Promise.race([
      exited.then(() => "exited" as const),
      setTimeout(3000).then(() => "timeout" as const),
    ]);
    if (winner === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
  }

  async close(removeScratch = true): Promise<void> {
    await this.stop();
    if (removeScratch) {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}
