import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/isolateHappyTestEnvironment.ts",
            "../../scripts/exitOrphanedTestWorker.ts",
        ],
        exclude: ["tests/**/*.live.test.ts"],
        include: ["tests/**/*.test.ts"],
        // Half the cores leaves room for the agents and daemons that run beside a suite.
        maxWorkers: "50%",
    },
});
