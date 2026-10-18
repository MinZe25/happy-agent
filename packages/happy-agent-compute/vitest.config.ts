import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/exitOrphanedTestWorker.ts",
        ],
        include: ["tests/**/*.test.ts"],
        // Windows PowerShell process startup and process-tree shutdown can exceed five seconds.
        // Elsewhere half the cores leaves room for the agents and daemons beside a suite.
        maxWorkers: process.platform === "win32" ? 2 : "50%",
        testTimeout: process.platform === "win32" ? 20_000 : 5_000,
    },
});
