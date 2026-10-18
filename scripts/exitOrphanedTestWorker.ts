// A forked Vitest worker reports every uncaught error to its parent over IPC. When the parent dies
// mid-run (a crashed or killed `vitest run`), that report fails with ERR_IPC_CHANNEL_CLOSED, which
// is itself uncaught and reported again. The orphan then spins at full CPU and grows by about
// 100 MB a second; a dozen of them exhausted a 48 GB machine. A worker whose parent is gone has
// nobody to report to, so it ends itself as soon as the channel closes. SIGKILL is used because
// Vitest replaces `process.exit` inside workers with a function that throws.
const installed = Symbol.for("happy-agent.exitOrphanedTestWorker");
const state = process as NodeJS.Process & { [installed]?: true };

if (process.send && !state[installed]) {
    state[installed] = true;
    process.once("disconnect", () => {
        process.kill(process.pid, "SIGKILL");
    });
}
