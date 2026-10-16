import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/isolateHappyTestEnvironment.ts",
            "../../scripts/exitOrphanedTestWorker.ts",
        ],
        include: ["tests/**/*.live.test.ts"],
    },
});
