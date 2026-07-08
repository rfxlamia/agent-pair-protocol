import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type OpenApiDocument,
  extractSchemas,
  pickTopLevelSchema,
  schemaBundleForTopLevel,
} from "./openapi-schemas.js";
import { resolvePackageBin } from "./resolve-package-bin.js";

const execFileAsync = promisify(execFile);

function resolveDefaultQuicktypeBin(): string {
  return resolvePackageBin("quicktype");
}

export const DEFAULT_DOCKER_IMAGE = "agentpair/runner-esp32";

export type RunnerResult = {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type DockerCheck = () => Promise<RunnerResult>;

export async function checkDockerAvailable(): Promise<RunnerResult> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Docker unavailable: ${message}`,
    };
  }
}

export type CodegenCompileOptions = {
  topLevel?: string;
  dockerImage?: string;
  checkDocker?: DockerCheck;
  quicktypeBin?: string;
};

export async function runCodegenCompile(
  openApiDoc: OpenApiDocument,
  options: CodegenCompileOptions = {},
): Promise<RunnerResult> {
  const checkDocker = options.checkDocker ?? checkDockerAvailable;
  const dockerStatus = await checkDocker();
  if (!dockerStatus.ok) {
    return dockerStatus;
  }

  const schemas = extractSchemas(openApiDoc);
  if (Object.keys(schemas).length === 0) {
    return {
      ok: false,
      error: "No components.schemas found in OpenAPI document",
    };
  }

  let topLevel: string;
  try {
    topLevel = pickTopLevelSchema(schemas, options.topLevel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const bundle = schemaBundleForTopLevel(schemas, topLevel);
  const dockerImage = options.dockerImage ?? DEFAULT_DOCKER_IMAGE;
  let quicktypeBin = options.quicktypeBin;
  if (!quicktypeBin) {
    try {
      quicktypeBin = resolveDefaultQuicktypeBin();
    } catch {
      return {
        ok: false,
        error: "codegen-compile runner unavailable: install quicktype (dev dependency)",
      };
    }
  }
  const workDir = await mkdtemp(join(tmpdir(), "agentpair-codegen-"));

  try {
    const schemaPath = join(workDir, `${topLevel}.json`);
    const outBase = join(workDir, topLevel);
    await writeFile(schemaPath, JSON.stringify(bundle, null, 2), "utf8");

    await execFileAsync(
      quicktypeBin,
      [
        "--lang",
        "cjson",
        "--src",
        schemaPath,
        "--src-lang",
        "schema",
        "--top-level",
        topLevel,
        "--out",
        outBase,
      ],
      { timeout: 60_000 },
    );

    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${workDir}:/work`, dockerImage, `/work/${topLevel}`],
      { timeout: 120_000 },
    );

    return {
      ok: true,
      details: {
        topLevel,
        schemaCount: Object.keys(schemas).length,
        dockerImage,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `codegen-compile failed: ${message}`,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
