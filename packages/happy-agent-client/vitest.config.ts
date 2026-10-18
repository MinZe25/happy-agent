import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/exitOrphanedTestWorker.ts"],
        include: ["tests/**/*.test.ts"],
    },
});
