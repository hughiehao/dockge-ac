import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { io, type Socket } from "socket.io-client";

const TEST_USER = "e2e_user";
const TEST_PASSWORD = "e2e_password_123";
const STACK_NAME = "e2e-test";
const BLOCKED_STACK_NAME = "e2e-blocked";

interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface ServerHandle {
    process: ChildProcessWithoutNullStreams;
    port: number;
    dataDir: string;
    stacksDir: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args);
        let stdout = "";
        let stderr = "";

        process.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        process.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        process.on("error", (error: Error) => {
            reject(new Error(`Failed to run ${command} ${args.join(" ")}: ${error.message}`));
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

function parseContainerList(output: string): Array<Record<string, unknown>> {
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
    const direct = item.name ?? item.Name ?? item.Names ?? item.id ?? item.ID;
    if (typeof direct === "string" && direct) {
        return direct;
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

function readContainerState(item: Record<string, unknown>): string {
    const directState = item.state ?? item.State ?? item.status ?? item.Status;
    if (typeof directState === "string" && directState) {
        return directState.toLowerCase();
    }

    const configuration = item.configuration;
    if (configuration && typeof configuration === "object") {
        const nestedStatus = (configuration as Record<string, unknown>).status;
        if (typeof nestedStatus === "string" && nestedStatus) {
            return nestedStatus.toLowerCase();
        }
    }

    return "";
}

async function listContainersByPrefix(prefix: string): Promise<string[]> {
    const result = await runCommand("container", [ "list", "--all", "--format", "json" ]);
    if (result.exitCode !== 0) {
        throw new Error(`Failed to list containers: ${result.stderr || result.stdout}`);
    }

    return parseContainerList(result.stdout)
        .map((item) => readContainerName(item))
        .filter((name) => name.startsWith(prefix));
}

async function listRunningContainersByPrefix(prefix: string): Promise<string[]> {
    const result = await runCommand("container", [ "list", "--format", "json" ]);
    if (result.exitCode !== 0) {
        throw new Error(`Failed to list running containers: ${result.stderr || result.stdout}`);
    }

    return parseContainerList(result.stdout)
        .map((item) => readContainerName(item))
        .filter((name) => name.startsWith(prefix));
}

async function removeContainerByName(containerName: string): Promise<void> {
    await runCommand("container", [ "stop", containerName ]);
    await runCommand("container", [ "delete", containerName ]);
}

async function removeContainersByPrefix(prefix: string): Promise<void> {
    const names = await listContainersByPrefix(prefix);
    for (const name of names) {
        await removeContainerByName(name).catch(() => undefined);
    }
}

async function getFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error("Unable to allocate port"));
                return;
            }
            const { port } = address;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

async function waitForHttpReady(baseUrl: string, timeoutMs = 120_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(baseUrl);
            if (response.ok) {
                return;
            }
        } catch {
        }
        await sleep(500);
    }
    throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function startServer(): Promise<ServerHandle> {
    const port = await getFreePort();
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const dataDir = path.resolve(".dockge-data", `e2e-${uniqueSuffix}`);
    const stacksDir = path.resolve("stacks", `e2e-${uniqueSuffix}`);

    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(stacksDir, { recursive: true });

    const childProcess = spawn(
        "npm",
        [ "run", "start", "--", "--port", String(port), "--dataDir", dataDir, "--stacksDir", stacksDir ],
        {
            cwd: path.resolve("."),
            env: {
                ...process.env,
                NODE_ENV: "development",
                DOCKGE_PORT: String(port),
                DOCKGE_DATA_DIR: dataDir,
                DOCKGE_STACKS_DIR: stacksDir,
            },
        }
    );

    try {
        await waitForHttpReady(`http://127.0.0.1:${port}`);
    } catch (error) {
        childProcess.kill("SIGTERM");
        throw error;
    }

    return { process: childProcess,
        port,
        dataDir,
        stacksDir };
}

async function stopServer(server: ServerHandle): Promise<void> {
    await new Promise<void>((resolve) => {
        const done = () => resolve();
        server.process.once("exit", done);
        server.process.kill("SIGTERM");
        setTimeout(() => {
            if (!server.process.killed) {
                server.process.kill("SIGKILL");
            }
            resolve();
        }, 10_000);
    });

    await fs.rm(server.dataDir, { recursive: true,
        force: true });
    await fs.rm(server.stacksDir, { recursive: true,
        force: true });
}

function emitWithAck<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs: number, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for socket ack: ${event}`));
        }, timeoutMs);

        socket.emit(event, ...args, (response: T) => {
            clearTimeout(timeout);
            resolve(response);
        });
    });
}

function emitAgentWithAck<T = Record<string, unknown>>(socket: Socket, event: string, timeoutMs: number, ...args: unknown[]): Promise<T> {
    return emitWithAck<T>(socket, "agent", timeoutMs, "", event, ...args);
}

async function waitForContainerRunning(prefix: string, timeoutMs = 60_000): Promise<void> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const running = await listRunningContainersByPrefix(prefix);
        if (running.length > 0) {
            return;
        }
        await sleep(1000);
    }

    throw new Error(`Timed out waiting for running container with prefix '${prefix}'`);
}

async function waitForContainerStopped(prefix: string, timeoutMs = 60_000): Promise<void> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const allResult = await runCommand("container", [ "list", "--all", "--format", "json" ]);
        if (allResult.exitCode === 0) {
            const allContainers = parseContainerList(allResult.stdout)
                .filter((item) => readContainerName(item).startsWith(prefix));

            if (allContainers.length > 0) {
                const allStopped = allContainers.every((item) => {
                    const state = readContainerState(item);
                    return state.includes("stopped") || state.includes("exited") || state.includes("created");
                });

                if (allStopped) {
                    return;
                }
            }
        }

        await sleep(1000);
    }

    throw new Error(`Timed out waiting for stopped container with prefix '${prefix}'`);
}

async function waitForNoContainers(prefix: string, timeoutMs = 45_000): Promise<void> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const names = await listContainersByPrefix(prefix);
        if (names.length === 0) {
            return;
        }
        await sleep(1000);
    }

    throw new Error(`Timed out waiting for containers with prefix '${prefix}' to be removed`);
}

test("e2e stack lifecycle through socket workflow", { timeout: 420_000 }, async () => {
    const stackPrefix = `dockgeac_${STACK_NAME}_`;
    const blockedPrefix = `dockgeac_${BLOCKED_STACK_NAME}_`;

    await removeContainersByPrefix(stackPrefix);
    await removeContainersByPrefix(blockedPrefix);

    const server = await startServer();
    const socket = io(`http://127.0.0.1:${server.port}`, {
        transports: [ "websocket" ],
        forceNew: true,
    });

    await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", (error) => reject(error));
    });

    const containerPort = await getFreePort();
    const validCompose = [
        "services:",
        "  web:",
        "    image: nginx:latest",
        "    ports:",
        `      - "${containerPort}:80"`,
        "",
    ].join("\n");

    const blockedCompose = [
        "services:",
        "  web:",
        "    image: nginx:latest",
        "    deploy:",
        "      replicas: 3",
        "",
    ].join("\n");

    try {
        const setupRes = await emitWithAck<Record<string, unknown>>(socket, "setup", 30_000, TEST_USER, TEST_PASSWORD);
        assert.equal((setupRes as { ok?: boolean }).ok, true, `Setup failed: ${JSON.stringify(setupRes)}`);

        const loginRes = await emitWithAck<Record<string, unknown>>(socket, "login", 30_000, {
            username: TEST_USER,
            password: TEST_PASSWORD,
            token: "",
        });
        assert.equal((loginRes as { ok?: boolean }).ok, true, `Login failed: ${JSON.stringify(loginRes)}`);

        const deployRes = await emitAgentWithAck<Record<string, unknown>>(socket, "deployStack", 180_000, STACK_NAME, validCompose, "", true);
        assert.equal((deployRes as { ok?: boolean }).ok, true, `Deploy failed: ${JSON.stringify(deployRes)}`);

        await waitForContainerRunning(stackPrefix);

        const runningContainers = await listContainersByPrefix(stackPrefix);
        assert(
            runningContainers.some((name) => name.includes("_web_")),
            `Expected deployed stack container with prefix ${stackPrefix}, got ${runningContainers.join(", ")}`
        );

        const stopRes = await emitAgentWithAck<Record<string, unknown>>(socket, "stopStack", 60_000, STACK_NAME);
        assert.equal((stopRes as { ok?: boolean }).ok, true, `Stop failed: ${JSON.stringify(stopRes)}`);
        await waitForContainerStopped(stackPrefix);

        const startRes = await emitAgentWithAck<Record<string, unknown>>(socket, "startStack", 60_000, STACK_NAME);
        assert.equal((startRes as { ok?: boolean }).ok, true, `Start failed: ${JSON.stringify(startRes)}`);
        await waitForContainerRunning(stackPrefix);

        const deleteRes = await emitAgentWithAck<Record<string, unknown>>(socket, "deleteStack", 120_000, STACK_NAME);
        assert.equal((deleteRes as { ok?: boolean }).ok, true, `Delete failed: ${JSON.stringify(deleteRes)}`);
        await waitForNoContainers(stackPrefix);

        const blockedRes = await emitAgentWithAck<Record<string, unknown>>(socket, "deployStack", 120_000, BLOCKED_STACK_NAME, blockedCompose, "", true);
        assert.equal((blockedRes as { ok?: boolean }).ok, false, "Blocked compose should fail preflight checks");

        const blockedMessage = JSON.stringify(blockedRes);
        assert.match(blockedMessage, /deploy/i, `Expected blocked key message to include 'deploy': ${blockedMessage}`);
        await waitForNoContainers(blockedPrefix, 10_000);
    } finally {
        await emitAgentWithAck<Record<string, unknown>>(socket, "deleteStack", 60_000, STACK_NAME).catch(() => undefined);
        await emitAgentWithAck<Record<string, unknown>>(socket, "deleteStack", 60_000, BLOCKED_STACK_NAME).catch(() => undefined);

        socket.disconnect();
        await stopServer(server);

        await removeContainersByPrefix(stackPrefix);
        await removeContainersByPrefix(blockedPrefix);
    }
});
