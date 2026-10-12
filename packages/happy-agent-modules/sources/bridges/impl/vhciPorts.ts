import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** One port of the USB/IP virtual host controller. */
export interface VhciPort {
    /** `"hs"` takes low, full, high, and wireless devices; `"ss"` takes SuperSpeed ones. */
    readonly hub: "hs" | "ss";
    /** The number the attach control is given. */
    readonly port: number;
    readonly free: boolean;
}

/** `VDEV_ST_NULL`: nothing attached and nothing on its way. */
const VDEV_ST_NULL = 4;

/**
 * Reads every port the virtual host controllers report.
 *
 * Each controller reports its ports in one status file beside the attach control: `status` for
 * the first, `status.1` and on for any more the module was loaded with.
 */
export async function readVhciPorts(controllerPath: string): Promise<VhciPort[]> {
    const names = (await readdir(controllerPath)).filter((name) => /^status(\.\d+)?$/.test(name));
    const files = await Promise.all(
        names.map(async (name) => await readFile(join(controllerPath, name), "utf8")),
    );
    return files.flatMap(parseVhciStatus);
}

/**
 * Parses one status file.
 *
 * Each line after the header is `hub port sta spd dev sockfd local_busid`, such as
 * `hs  0000 004 000 00000000 000000 0-0`. Lines in any other shape are skipped rather than
 * guessed at.
 */
export function parseVhciStatus(text: string): VhciPort[] {
    const ports: VhciPort[] = [];
    for (const line of text.split("\n")) {
        const match = /^(hs|ss)\s+(\d+)\s+(\d+)\s/.exec(line.trim() + " ");
        if (match === null) continue;
        ports.push({
            hub: match[1] as "hs" | "ss",
            port: Number(match[2]),
            free: Number(match[3]) === VDEV_ST_NULL,
        });
    }
    return ports;
}
