import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/isolateHappyTestEnvironment.ts",
            "../../scripts/exitOrphanedTestWorker.ts",
        ],
        // Windows startup provisions private ACLs through PowerShell; bound concurrency
        // keeps these integration fixtures from competing with every other worker. Elsewhere
        // half the cores leaves room for the agents and daemons that run beside a suite.
        ...(process.platform === "win32"
            ? { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2 }
            : { maxWorkers: "50%" }),
        include: ["tests/**/*.test.ts"],
    },
});
