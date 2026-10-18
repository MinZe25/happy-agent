import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "./scripts/requireApiGymRuntime.ts",
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/exitOrphanedTestWorker.ts",
        ],
    },
});
