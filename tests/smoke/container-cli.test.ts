import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const SMOKE_CONTAINER_NAME = "dockgeac_smoke_test_1";

interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function runContainer(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const process = spawn("container", args);
        let stdout = "";
        let stderr = "";

        process.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        process.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        process.on("error", (error: Error) => {
            reject(new Error(`Failed to execute container ${args.join(" ")}: ${error.message}`));
        });

        process.on("close", (code) => {
            resolve({
                exitCode: code ?? 1,
                stdout,
                stderr,
            });
        });
    });
}

function parseJsonOutput(output: string): Array<Record<string, unknown>> {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }

    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [ parsed as Record<string, unknown> ];
    } catch {
        return trimmed
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line) as Record<string, unknown>;
                } catch {
                    return null;
                }
            })
            .filter((value): value is Record<string, unknown> => value !== null);
    }
}

function readContainerName(item: Record<string, unknown>): string {
    const directName = item.name ?? item.Name ?? item.Names ?? item.id ?? item.ID;
    if (typeof directName === "string" && directName) {
        return directName;
    }

    const configuration = item.configuration;
    if (configuration && typeof configuration === "object") {
        const nestedId = (configuration as Record<string, unknown>).id;
        if (typeof nestedId === "string" && nestedId) {
            return nestedId;
        }
    }

    return "";
}

function assertSuccess(step: string, args: string[], result: CommandResult): void {
    assert.equal(
        result.exitCode,
        0,
        [
            `[${step}] expected success for: container ${args.join(" ")}`,
            `stdout: ${result.stdout.trim()}`,
            `stderr: ${result.stderr.trim()}`,
        ].join("\n")
    );
}

async function ensureSmokeContainerDeleted(): Promise<void> {
    await runContainer([ "stop", SMOKE_CONTAINER_NAME ]).catch(() => undefined);
    await runContainer([ "delete", SMOKE_CONTAINER_NAME ]).catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

test("apple container CLI smoke validation", { timeout: 180_000 }, async () => {
    await ensureSmokeContainerDeleted();

    try {
        const statusResult = await runContainer([ "system", "status" ]);
        assertSuccess("1. container system status", [ "system", "status" ], statusResult);

        const pullResult = await runContainer([ "image", "pull", "alpine:latest" ]);
        assertSuccess("2. container image pull alpine:latest", [ "image", "pull", "alpine:latest" ], pullResult);

        const createArgs = [ "create", "--name", SMOKE_CONTAINER_NAME, "alpine:latest", "sleep", "3600" ];
        const createResult = await runContainer(createArgs);
        assertSuccess("3. container create", createArgs, createResult);

        const startResult = await runContainer([ "start", SMOKE_CONTAINER_NAME ]);
        assertSuccess("4. container start", [ "start", SMOKE_CONTAINER_NAME ], startResult);

        let listResult: CommandResult | null = null;
        let containerFound = false;

        for (let attempt = 0; attempt < 20; attempt++) {
            listResult = await runContainer([ "list", "--format", "json" ]);
            if (listResult.exitCode === 0) {
                const runningContainers = parseJsonOutput(listResult.stdout);
                containerFound = runningContainers.some((item) => readContainerName(item) === SMOKE_CONTAINER_NAME);
                if (containerFound) {
                    break;
                }
            }
            await sleep(500);
        }

        assert(listResult, "[5. container list --format json] command did not execute");
        assertSuccess("5. container list --format json", [ "list", "--format", "json" ], listResult);
        assert(
            containerFound,
            [
                "[5. container list --format json] expected smoke container in running list",
                `stdout: ${listResult.stdout.trim()}`,
                `stderr: ${listResult.stderr.trim()}`,
            ].join("\n")
        );

        const logsResult = await runContainer([ "logs", SMOKE_CONTAINER_NAME ]);
        assertSuccess("6. container logs", [ "logs", SMOKE_CONTAINER_NAME ], logsResult);

        const execResult = await runContainer([ "exec", SMOKE_CONTAINER_NAME, "echo", "hello" ]);
        assertSuccess("7. container exec", [ "exec", SMOKE_CONTAINER_NAME, "echo", "hello" ], execResult);
        assert.match(
            execResult.stdout,
            /hello/,
            "[7. container exec] expected stdout to contain 'hello'"
        );

        const stopResult = await runContainer([ "stop", SMOKE_CONTAINER_NAME ]);
        assertSuccess("8. container stop", [ "stop", SMOKE_CONTAINER_NAME ], stopResult);

        const deleteResult = await runContainer([ "delete", SMOKE_CONTAINER_NAME ]);
        assertSuccess("9. container delete", [ "delete", SMOKE_CONTAINER_NAME ], deleteResult);

        const networkResult = await runContainer([ "network", "list" ]);
        assertSuccess("10. container network list", [ "network", "list" ], networkResult);

        const volumeResult = await runContainer([ "volume", "list" ]);
        assertSuccess("11. container volume list", [ "volume", "list" ], volumeResult);
    } finally {
        await ensureSmokeContainerDeleted();

        const listAllResult = await runContainer([ "list", "--all", "--format", "json" ]);
        if (listAllResult.exitCode === 0) {
            const allContainers = parseJsonOutput(listAllResult.stdout);
            assert(
                !allContainers.some((item) => readContainerName(item) === SMOKE_CONTAINER_NAME),
                "Cleanup failed: smoke container still exists after test"
            );
        }
    }
});
