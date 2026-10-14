import { describe, expect, it } from "vitest";

import { sudoRunnerCommand } from "../../../sources/runners/impl/sudoRunnerCommand.js";

describe("the sudo command a workload user's runner starts with", () => {
    it("is exactly the command one sudoers line allows, with nothing of the daemon's environment", () => {
        expect(sudoRunnerCommand("happy-work", "/usr/local/bin/happy-agent")).toEqual({
            program: "sudo",
            args: [
                "-n",
                "-u",
                "happy-work",
                "--",
                "/usr/local/bin/happy-agent",
                "runner",
                "--stdio",
            ],
            environment: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        });
    });

    it("never lets a user name or path reach sudo as anything else", () => {
        for (const user of [
            "root",
            "-u",
            "#1000",
            "%admin",
            "happy work",
            "Happy",
            "a".repeat(33),
        ]) {
            expect(() => sudoRunnerCommand(user, "/usr/local/bin/happy-agent")).toThrow(
                "is not a Linux user agent work may run as",
            );
        }
        for (const executable of ["happy-agent", "./happy-agent", "/usr/bin/happy\nagent", ""]) {
            expect(() => sudoRunnerCommand("happy-work", executable)).toThrow(
                "must be named by its absolute path",
            );
        }
    });
});
