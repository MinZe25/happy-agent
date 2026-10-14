import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const repositoryDocs = join(packageRoot, "..", "..", "docs");
const packagedDocs = join(packageRoot, "dist", "docs");

await rm(packagedDocs, { force: true, recursive: true });
await cp(repositoryDocs, packagedDocs, { recursive: true });
await cp(join(packageRoot, "API.md"), join(packagedDocs, "API.md"));
await cp(join(packageRoot, "API_P2P.md"), join(packagedDocs, "API_P2P.md"));
