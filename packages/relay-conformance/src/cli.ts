#!/usr/bin/env node
import { runConformanceSuite } from "./run.js";

function printUsage(): void {
  console.error("Usage: relay-conformance [--slow] [--large] <base-url>");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let slow = false;
  let large = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--slow") {
      slow = true;
      continue;
    }
    if (arg === "--large") {
      large = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    positional.push(arg);
  }

  const baseUrl = positional[0];
  if (!baseUrl) {
    printUsage();
    process.exit(2);
  }

  const result = await runConformanceSuite(baseUrl, { slow, large });

  for (const probe of result.passed) {
    console.log(`PASS  ${probe.id}`);
  }
  for (const probe of result.skipped) {
    console.log(`SKIP  ${probe.id}`);
  }
  for (const probe of result.failed) {
    console.error(`FAIL  ${probe.id}: ${probe.reason}`);
  }
  for (const advisory of result.advisories) {
    console.warn(`ADVISORY  ${advisory.code}: ${advisory.message}`);
  }

  process.exit(result.exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
