import { spawn } from "child_process";
import { EventEmitter } from "events";
import { ContainerStatus } from "../types.js";

function mapState(raw: string | undefined): ContainerStatus["state"] {
    if (!raw) {
        return "unknown";
    }
    const lower = raw.toLowerCase();
    if (lower.includes("running") || lower.includes("up")) {
        return "running";
    }
    if (lower.includes("stopped") || lower.includes("exited")) {
        return "stopped";
    }
    if (lower.includes("created")) {
        return "created";
    }
    return "unknown";
}

function getConfiguration(item: Record<string, unknown>): Record<string, unknown> {
    const configuration = item.configuration;
    if (configuration && typeof configuration === "object") {
        return configuration as Record<string, unknown>;
    }
    return {};
}

function readContainerName(item: Record<string, unknown>): string {
    const direct = item.name ?? item.Name ?? item.Names ?? item.id ?? item.ID;
    if (typeof direct === "string" && direct) {
        return direct;
    }

    const configuration = getConfiguration(item);
    const nestedId = configuration.id;
    if (typeof nestedId === "string" && nestedId) {
        return nestedId;
    }

    return "";
}

function readContainerState(item: Record<string, unknown>): string {
    const direct = item.state ?? item.State ?? item.Status ?? item.status;
    if (typeof direct === "string") {
        return direct;
    }

    const configuration = getConfiguration(item);
    const nestedStatus = configuration.status;
    if (typeof nestedStatus === "string") {
        return nestedStatus;
    }

    return "";
}

function readContainerExitCode(item: Record<string, unknown>): number | undefined {
    const direct = item.exitCode ?? item.ExitCode;
    if (direct != null) {
        return Number(direct);
    }

    const configuration = getConfiguration(item);
    const nestedExitCode = configuration.exitCode;
    if (nestedExitCode != null) {
        return Number(nestedExitCode);
    }

    return undefined;
}

function readContainerStartedAt(item: Record<string, unknown>): string | undefined {
    const direct = item.startedAt ?? item.StartedAt ?? item.startedDate;
    if (direct != null) {
        return String(direct);
    }

    const configuration = getConfiguration(item);
    const nestedStartedAt = configuration.startedAt ?? configuration.startedDate;
    if (nestedStartedAt != null) {
        return String(nestedStartedAt);
    }

    return undefined;
}

function isInternalContainer(item: Record<string, unknown>): boolean {
    const configuration = getConfiguration(item);
    const labelsRaw = item.labels ?? item.Labels ?? configuration.labels;
    if (!labelsRaw || typeof labelsRaw !== "object") {
        return false;
    }

    const labels = labelsRaw as Record<string, unknown>;
    return labels["com.apple.container.resource.role"] === "builder";
}

function parseContainerListOutput(stdout: string): ContainerStatus[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    let rawItems: Record<string, unknown>[];

    try {
        const parsed = JSON.parse(trimmed);
        rawItems = Array.isArray(parsed) ? parsed : [ parsed ];
    } catch {
        // JSONL fallback — one JSON object per line
        rawItems = trimmed
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                try {
                    return JSON.parse(line) as Record<string, unknown>;
                } catch {
                    return null;
                }
            })
            .filter((item): item is Record<string, unknown> => item !== null);
    }

    return rawItems
        .filter((item) => !isInternalContainer(item))
        .map((item) => ({
            name: readContainerName(item),
            state: mapState(readContainerState(item)),
            exitCode: readContainerExitCode(item),
            startedAt: readContainerStartedAt(item),
        }))
        .filter((container) => container.name.length > 0);
}

function runContainerList(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = spawn("container", [ "list", "--all", "--format", "json" ]);
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("error", (err: Error) => {
            reject(err);
        });

        child.on("close", (code: number | null) => {
            if (code !== 0) {
                reject(new Error(`container list exited with code ${code}: ${stderr.trim()}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Polling-based observer that periodically queries Apple container status
 * and emits diff events (created, removed, stateChanged) plus full status updates.
 *
 * Events:
 *  - statusUpdate:      Map<string, ContainerStatus>
 *  - stateChanged:      { name: string, oldState: string, newState: string }
 *  - containerCreated:  ContainerStatus
 *  - containerRemoved:  string (container name)
 *  - pollError:         Error
 */
export class ContainerObserver extends EventEmitter {
    private pollIntervalMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastState: Map<string, ContainerStatus> = new Map();

    constructor(pollIntervalMs: number = 5000) {
        super();
        this.pollIntervalMs = pollIntervalMs;
    }

    start(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            void this.poll();
        }, this.pollIntervalMs);

        void this.poll();
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    async getStatus(): Promise<Map<string, ContainerStatus>> {
        const stdout = await runContainerList();
        const all = parseContainerListOutput(stdout);
        const result = new Map<string, ContainerStatus>();
        for (const c of all) {
            result.set(c.name, c);
        }
        return result;
    }

    private async poll(): Promise<void> {
        try {
            const stdout = await runContainerList();
            const all = parseContainerListOutput(stdout);
            const current = new Map<string, ContainerStatus>();

            for (const c of all) {
                current.set(c.name, c);
            }

            for (const [ name, status ] of current) {
                if (!this.lastState.has(name)) {
                    this.emit("containerCreated", status);
                }
            }

            for (const [ name ] of this.lastState) {
                if (!current.has(name)) {
                    this.emit("containerRemoved", name);
                }
            }

            for (const [ name, status ] of current) {
                const prev = this.lastState.get(name);
                if (prev && prev.state !== status.state) {
                    this.emit("stateChanged", {
                        name,
                        oldState: prev.state,
                        newState: status.state,
                    });
                }
            }

            this.lastState = current;
            this.emit("statusUpdate", current);
        } catch (err) {
            this.emit("pollError", err instanceof Error ? err : new Error(String(err)));
        }
    }
}
