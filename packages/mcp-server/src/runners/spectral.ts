import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { OpenApiDocument } from "./openapi-schemas.js";
import { resolvePackageBin } from "./resolve-package-bin.js";

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultSpectralBin = resolvePackageBin("@stoplight/spectral-cli", "spectral");
const defaultRulesetPath = join(moduleDir, "spectral-ruleset.yaml");

export type RunnerResult = {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type SpectralOptions = {
  spectralBin?: string;
  rulesetPath?: string;
};

export async function runSpectral(
  openApiDoc: OpenApiDocument,
  options: SpectralOptions = {},
): Promise<RunnerResult> {
  const spectralBin = options.spectralBin ?? defaultSpectralBin;
  const workDir = await mkdtemp(join(tmpdir(), "agentpair-spectral-"));

  try {
    const specPath = join(workDir, "openapi.json");
    await writeFile(specPath, JSON.stringify(openApiDoc, null, 2), "utf8");

    const { stdout, stderr } = await execFileAsync(
      spectralBin,
      [
        "lint",
        specPath,
        "--ruleset",
        options.rulesetPath ?? defaultRulesetPath,
        "--format",
        "json",
      ],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );

    return {
      ok: true,
      details: {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      },
    };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    const message = execErr.stderr?.trim() || execErr.message || String(err);

    return {
      ok: false,
      error: `spectral lint failed: ${message}`,
      details: {
        exitCode: execErr.code,
        stdout: execErr.stdout?.trim(),
        stderr: execErr.stderr?.trim(),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
