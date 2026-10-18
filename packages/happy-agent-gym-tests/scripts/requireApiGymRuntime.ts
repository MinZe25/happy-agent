// The API gym starts its real daemon in this worker. Checking only the suite runner would
// miss a child launcher that silently selected Node, where real Bun terminals cannot start.
if (process.env.HAPPY_API_REQUIRE_BUN === "1") {
    if (process.versions.bun === undefined) {
        throw new Error("The API gym worker needs Bun to exercise real Happy Agent terminals.");
    }
    console.error(
        "API gym worker runtime: " +
            JSON.stringify({
                bun: process.versions.bun,
                execPath: process.execPath,
                pid: process.pid,
            }),
    );
}
