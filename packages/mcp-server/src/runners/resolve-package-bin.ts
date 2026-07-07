import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

type PackageJson = {
  bin?: string | Record<string, string>;
};

/**
 * Resolve a dependency's CLI entry to an absolute path.
 * Works under pnpm's isolated layout and npm's hoisted npx installs.
 */
export function resolvePackageBin(
  packageName: string,
  binName?: string,
): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageDir = dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;

  if (typeof pkg.bin === "string") {
    return join(packageDir, pkg.bin);
  }

  if (pkg.bin && typeof pkg.bin === "object") {
    const key = binName ?? Object.keys(pkg.bin)[0];
    const relative = key ? pkg.bin[key] : undefined;
    if (relative) {
      return join(packageDir, relative);
    }
  }

  throw new Error(`No bin entry found for package ${packageName}`);
}
