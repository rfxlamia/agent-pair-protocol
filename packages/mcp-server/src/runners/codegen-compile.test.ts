import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkDockerAvailable,
  runCodegenCompile,
} from "./codegen-compile.js";
import {
  extractSchemas,
  schemaBundleForTopLevel,
} from "./openapi-schemas.js";
import { runPayloadSize } from "./payload-size.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_ESP32_DIR = join(__dirname, "../../../runner-esp32");
const DOCKER_IMAGE = "agentpair/runner-esp32";

const sampleOpenApi = {
  openapi: "3.0.3",
  info: {
    title: "Sensor API",
    version: "1.0.0",
  },
  paths: {},
  components: {
    schemas: {
      Reading: {
        type: "object",
        required: ["sensor_id", "value"],
        properties: {
          sensor_id: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" },
        },
      },
    },
  },
} as const;

const oversizedSchema = {
  type: "object",
  required: ["blob"],
  properties: {
    blob: {
      type: "string",
      minLength: 5000,
    },
  },
};

async function ensureRunnerImage(): Promise<void> {
  try {
    await execFileAsync("docker", ["image", "inspect", DOCKER_IMAGE], {
      timeout: 10_000,
    });
    return;
  } catch {
    // build below
  }

  await execFileAsync(
    "docker",
    ["build", "-t", DOCKER_IMAGE, RUNNER_ESP32_DIR],
    { timeout: 600_000 },
  );
}

describe("openapi-schemas", () => {
  it("extracts components.schemas from OpenAPI", () => {
    const schemas = extractSchemas(sampleOpenApi);
    expect(schemas.Reading).toMatchObject({
      type: "object",
      required: ["sensor_id", "value"],
    });
  });

  it("builds a JSON Schema bundle for quicktype", () => {
    const schemas = extractSchemas(sampleOpenApi);
    const bundle = schemaBundleForTopLevel(schemas, "Reading");
    expect(bundle.definitions).toEqual(schemas);
    expect(bundle.type).toBe("object");
  });
});

describe("payload-size", () => {
  it("fails when generated payload exceeds byte limit", () => {
    const result = runPayloadSize(oversizedSchema, {
      maxBytes: 4096,
      seed: 42,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds limit of 4096 bytes/);
    expect(result.details?.byteLength).toBeGreaterThan(4096);
  });
});

describe("codegen-compile", () => {
  it("returns explicit error when Docker is unavailable (no silent pass)", async () => {
    const result = await runCodegenCompile(sampleOpenApi, {
      checkDocker: async () => ({
        ok: false,
        error: "Docker unavailable: mocked for test",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Docker unavailable/);
  });

  it("runs quicktype cjson and xtensa-esp-elf-gcc -fsyntax-only via Docker", async () => {
    const dockerStatus = await checkDockerAvailable();
    if (!dockerStatus.ok) {
      const result = await runCodegenCompile(sampleOpenApi);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Docker unavailable/);
      return;
    }

    await ensureRunnerImage();

    const result = await runCodegenCompile(sampleOpenApi, {
      dockerImage: DOCKER_IMAGE,
    });

    expect(result.ok).toBe(true);
    expect(result.details?.topLevel).toBe("Reading");
  }, 600_000);
});
