import { expect, test } from "bun:test";
for (const [name, fixture] of [
  [
    "production assembly CLI, HTTP, rendering and review workflow",
    "assembly-server-fixture.ts",
  ],
  ["assembly scenes and multitrack presentation", "assembly-view-fixture.tsx"],
])
  test(
    name!,
    () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "run",
          "--tsconfig-override",
          "./studio/tsconfig.json",
          `test/studio/fixtures/${fixture}`,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", timeout: 45000 },
      );
      if (result.exitCode !== 0)
        throw new Error(result.stdout.toString() + result.stderr.toString());
      expect(result.stdout.toString()).toContain("PASS:");
    },
    50000,
  );
