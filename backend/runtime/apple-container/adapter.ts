import { spawn } from "child_process";
import { RuntimeAdapter } from "../runtime-adapter.js";
import { StackPlan, ContainerStatus, RuntimeCapabilities, RuntimeImage, TerminalConfig, StackLockData } from "../types.js";
import { StackLock } from "./stack-lock.js";
import { CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../../common/util-common";

const CONTAINER_PREFIX = "dockgeac";

function containerName(stackName: string, serviceName: string, index = 1): string {
    return `${CONTAINER_PREFIX}_${stackName}_${serviceName}_${index}`;
}

async function execContainer(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("container", args);
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (d: Buffer) => {
            stdout += d.toString();
        });
        proc.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
        });
        proc.on("close", (code: number | null) => {
            resolve({ stdout,
                stderr,
                exitCode: code ?? 1 });
        });
        proc.on("error", (err: Error) => {
            reject(new Error(`Failed to execute container ${args.join(" ")}: ${err.message}`));
        });
    });
}

function mapState(raw: string): ContainerStatus["state"] {
    const lower = (raw || "").toLowerCase();
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

function inferStackNameFromManagedContainerName(container: string): string | null {
    if (!container.startsWith(`${CONTAINER_PREFIX}_`)) {
        return null;
    }

    const rest = container.substring(CONTAINER_PREFIX.length + 1);
    const parts = rest.split("_");
    if (parts.length < 3) {
        return null;
    }

    return parts[0] || null;
}

function parseJsonOutputRecords(stdout: string): Record<string, unknown>[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [ parsed ];
    } catch {
        return trimmed.split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
    }
}

function readImageReference(item: Record<string, unknown>): string {
    const reference = item.reference ?? item.Reference;
    return typeof reference === "string" ? reference : "";
}

function readImageDescriptor(item: Record<string, unknown>): Record<string, unknown> {
    const descriptor = item.descriptor;
    if (descriptor && typeof descriptor === "object") {
        return descriptor as Record<string, unknown>;
    }
    return {};
}

function readImageDigest(item: Record<string, unknown>): string | undefined {
    const descriptor = readImageDescriptor(item);
    const digest = descriptor.digest;
    return typeof digest === "string" ? digest : undefined;
}

function readImageMediaType(item: Record<string, unknown>): string | undefined {
    const descriptor = readImageDescriptor(item);
    const mediaType = descriptor.mediaType;
    return typeof mediaType === "string" ? mediaType : undefined;
}

function readImageSize(item: Record<string, unknown>): string | undefined {
    const fullSize = item.fullSize ?? item.FullSize;
    return typeof fullSize === "string" ? fullSize : undefined;
}

function readContainerImageReference(item: Record<string, unknown>): string {
    const direct = item.image ?? item.Image;
    if (typeof direct === "string" && direct) {
        return direct;
    }

    const configuration = getConfiguration(item);
    const image = configuration.image;
    if (typeof image === "string" && image) {
        return image;
    }

    if (image && typeof image === "object") {
        const reference = (image as Record<string, unknown>).reference;
        if (typeof reference === "string" && reference) {
            return reference;
        }
    }

    return "";
}

function readContainerImageDigest(item: Record<string, unknown>): string | undefined {
    const direct = item.imageDigest ?? item.ImageDigest;
    if (typeof direct === "string" && direct) {
        return direct;
    }

    const configuration = getConfiguration(item);
    const image = configuration.image;
    if (image && typeof image === "object") {
        const descriptor = (image as Record<string, unknown>).descriptor;
        if (descriptor && typeof descriptor === "object") {
            const digest = (descriptor as Record<string, unknown>).digest;
            if (typeof digest === "string" && digest) {
                return digest;
            }
        }
    }

    return undefined;
}

function hasRegistryPrefix(ref: string): boolean {
    const firstSegment = ref.split("/")[0] || "";
    return firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";
}

function normalizeImageReference(reference: string): string {
    return reference.trim().toLowerCase();
}

function buildImageReferenceCandidates(reference: string): string[] {
    const normalized = normalizeImageReference(reference);
    if (!normalized) {
        return [];
    }

    const noDigest = normalized.split("@")[0] || normalized;
    const result = new Set<string>([ normalized, noDigest ]);

    if (noDigest.startsWith("docker.io/library/")) {
        const withoutPrefix = noDigest.substring("docker.io/library/".length);
        if (withoutPrefix) {
            result.add(withoutPrefix);
        }
    }

    if (noDigest.startsWith("docker.io/")) {
        const withoutPrefix = noDigest.substring("docker.io/".length);
        if (withoutPrefix) {
            result.add(withoutPrefix);
        }
    }

    if (!noDigest.includes("/")) {
        result.add(`docker.io/library/${noDigest}`);
    } else if (!hasRegistryPrefix(noDigest)) {
        result.add(`docker.io/${noDigest}`);
    }

    return [ ...result ].filter(Boolean);
}

function isLocalOnlyImageReference(reference: string): boolean {
    const normalized = normalizeImageReference(reference);
    return normalized.endsWith(":local") || normalized.startsWith("localhost/");
}

function topologicalSort(services: Record<string, { dependsOn?: string[] }>): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    function visit(name: string) {
        if (visited.has(name)) {
            return;
        }
        visited.add(name);
        const deps = services[name]?.dependsOn ?? [];
        for (const dep of deps) {
            if (services[dep]) {
                visit(dep);
            }
        }
        result.push(name);
    }

    for (const name of Object.keys(services)) {
        visit(name);
    }
    return result;
}

export class AppleContainerAdapter extends RuntimeAdapter {
    private lock: StackLock;

    constructor(dataDir: string) {
        super();
        this.lock = new StackLock(dataDir);
    }

    async deploy(plan: StackPlan): Promise<void> {
        const order = topologicalSort(plan.services);
        const lockServices: StackLockData["services"] = {};

        for (const svcName of order) {
            const svc = plan.services[svcName];
            const name = containerName(plan.stackName, svcName);

            await this.pullImage(svc.image);

            const args = [ "run", "-d", "--name", name ];

            if (svc.ports) {
                for (const p of svc.ports) {
                    args.push("-p", p);
                }
            }
            if (svc.environment) {
                for (const [ k, v ] of Object.entries(svc.environment)) {
                    args.push("-e", `${k}=${v}`);
                }
            }
            if (svc.volumes) {
                for (const v of svc.volumes) {
                    args.push("-v", v);
                }
            }
            if (svc.networks) {
                for (const n of svc.networks) {
                    args.push("--network", n);
                }
            }
            if (svc.workingDir) {
                args.push("-w", svc.workingDir);
            }
            if (svc.user) {
                args.push("--user", svc.user);
            }

            args.push(svc.image);

            if (svc.command) {
                args.push(...svc.command.split(/\s+/));
            }

            const result = await execContainer(args);
            if (result.exitCode !== 0) {
                throw new Error(`Failed to run ${name}: ${result.stderr.trim()}`);
            }

            lockServices[svcName] = {
                containerName: name,
                image: svc.image,
                createdAt: new Date().toISOString(),
            };
        }

        this.lock.write(plan.stackName, {
            stackName: plan.stackName,
            fingerprint: "",
            services: lockServices,
            networks: plan.networks ?? [],
            volumes: plan.volumes ?? [],
            lastDeployed: new Date().toISOString(),
        });
    }

    async start(stackName: string, serviceName?: string): Promise<void> {
        const names = this.getContainerNames(stackName, serviceName);
        for (const name of names) {
            const result = await execContainer([ "start", name ]);
            if (result.exitCode !== 0) {
                throw new Error(`Failed to start ${name}: ${result.stderr.trim()}`);
            }
        }
    }

    async stop(stackName: string, serviceName?: string): Promise<void> {
        const names = this.getContainerNames(stackName, serviceName);
        for (const name of names) {
            const result = await execContainer([ "stop", name ]);
            if (result.exitCode !== 0) {
                throw new Error(`Failed to stop ${name}: ${result.stderr.trim()}`);
            }
        }
    }

    async down(stackName: string, removeVolumes?: boolean): Promise<void> {
        const lockData = this.lock.read(stackName);
        if (!lockData) {
            await execContainer([ "stop", stackName ]).catch(() => {});
            const deleteResult = await execContainer([ "delete", stackName ]);
            if (deleteResult.exitCode !== 0) {
                throw new Error(`Failed to delete ${stackName}: ${deleteResult.stderr.trim()}`);
            }
            return;
        }

        for (const svc of Object.values(lockData.services)) {
            await execContainer([ "stop", svc.containerName ]).catch(() => {});
            const del = await execContainer([ "delete", svc.containerName ]);
            if (del.exitCode !== 0) {
                throw new Error(`Failed to delete ${svc.containerName}: ${del.stderr.trim()}`);
            }
        }

        if (removeVolumes && lockData.volumes.length > 0) {
            for (const vol of lockData.volumes) {
                await execContainer([ "volume", "delete", vol ]).catch(() => {});
            }
        }

        this.lock.delete(stackName);
    }

    async restart(stackName: string, serviceName?: string): Promise<void> {
        await this.stop(stackName, serviceName);
        await this.start(stackName, serviceName);
    }

    async getServiceStatusList(stackName: string): Promise<Map<string, ContainerStatus>> {
        const result = new Map<string, ContainerStatus>();
        const containers = await this.listAllContainers();
        const containerByName = new Map<string, ContainerStatus>();

        for (const container of containers) {
            containerByName.set(container.name, container);
        }

        const lockData = this.lock.read(stackName);
        if (lockData) {
            for (const [ serviceName, service ] of Object.entries(lockData.services)) {
                const status = containerByName.get(service.containerName);
                if (status) {
                    result.set(serviceName, status);
                } else {
                    result.set(serviceName, {
                        name: service.containerName,
                        state: "unknown",
                    });
                }
            }

            return result;
        }

        for (const c of containers) {
            if (c.name === stackName || inferStackNameFromManagedContainerName(c.name) === stackName) {
                result.set(c.name, c);
            }
        }

        return result;
    }

    async getStackStatus(stackName: string): Promise<number> {
        const statuses = await this.getServiceStatusList(stackName);
        if (statuses.size === 0) {
            return UNKNOWN;
        }

        let allRunning = true;
        let allStopped = true;
        let allCreated = true;

        for (const s of statuses.values()) {
            if (s.state !== "running") {
                allRunning = false;
            }
            if (s.state !== "stopped") {
                allStopped = false;
            }
            if (s.state !== "created") {
                allCreated = false;
            }
        }

        if (allRunning) {
            return RUNNING;
        }
        if (allStopped) {
            return EXITED;
        }
        if (allCreated) {
            return CREATED_STACK;
        }

        if ([ ...statuses.values() ].some((status) => status.state === "running")) {
            return RUNNING;
        }

        if ([ ...statuses.values() ].some((status) => status.state === "stopped")) {
            return EXITED;
        }

        return UNKNOWN;
    }

    async getAllStackStatus(): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        const containers = await this.listAllContainers();
        const stacks = new Map<string, ContainerStatus[]>();

        const managedContainerToStack = new Map<string, string>();
        for (const stackName of this.lock.listAll()) {
            const lockData = this.lock.read(stackName);
            if (!lockData) {
                continue;
            }

            for (const service of Object.values(lockData.services)) {
                managedContainerToStack.set(service.containerName, stackName);
            }
        }

        for (const c of containers) {
            let stackName = managedContainerToStack.get(c.name);

            if (!stackName) {
                stackName = inferStackNameFromManagedContainerName(c.name) ?? c.name;
            }

            if (!stackName || stackName === "dockge") {
                continue;
            }

            if (!stacks.has(stackName)) {
                stacks.set(stackName, []);
            }
            stacks.get(stackName)!.push(c);
        }

        for (const [ stackName, containers ] of stacks) {
            let allRunning = true;
            let allStopped = true;
            let allCreated = true;

            for (const c of containers) {
                if (c.state !== "running") {
                    allRunning = false;
                }
                if (c.state !== "stopped") {
                    allStopped = false;
                }
                if (c.state !== "created") {
                    allCreated = false;
                }
            }

            if (allRunning) {
                result.set(stackName, RUNNING);
            } else if (allStopped) {
                result.set(stackName, EXITED);
            } else if (allCreated) {
                result.set(stackName, CREATED_STACK);
            } else if (containers.some((container) => container.state === "running")) {
                result.set(stackName, RUNNING);
            } else if (containers.some((container) => container.state === "stopped")) {
                result.set(stackName, EXITED);
            } else {
                result.set(stackName, UNKNOWN);
            }
        }

        const lockStacks = this.lock.listAll();
        for (const s of lockStacks) {
            if (!result.has(s)) {
                result.set(s, UNKNOWN);
            }
        }

        return result;
    }

    async *logs(stackName: string, serviceName: string, tail?: number, follow?: boolean): AsyncGenerator<string> {
        const name = containerName(stackName, serviceName);
        const args = [ "logs" ];
        if (tail != null) {
            args.push("--tail", String(tail));
        }
        if (follow) {
            args.push("--follow");
        }
        args.push(name);

        const proc = spawn("container", args);
        const stream = proc.stdout;
        if (!stream) {
            return;
        }

        for await (const chunk of stream) {
            yield chunk.toString();
        }
    }

    exec(stackName: string, serviceName: string, command: string): TerminalConfig {
        const name = containerName(stackName, serviceName);
        return {
            command: "container",
            args: [ "exec", "-it", name, ...command.split(/\s+/) ],
        };
    }

    async pullImage(image: string): Promise<void> {
        if (isLocalOnlyImageReference(image)) {
            const exists = await this.hasLocalImage(image);
            if (!exists) {
                throw new Error(`Local image ${image} not found. Build it first before deploying.`);
            }
            return;
        }

        const result = await execContainer([ "image", "pull", image ]);
        if (result.exitCode !== 0) {
            const exists = await this.hasLocalImage(image);
            if (exists) {
                return;
            }
            throw new Error(`Failed to pull image ${image}: ${result.stderr.trim()}`);
        }
    }

    async getImageList(): Promise<RuntimeImage[]> {
        const result = await execContainer([ "image", "list", "--format", "json" ]);
        if (result.exitCode !== 0) {
            return [];
        }

        const items = parseJsonOutputRecords(result.stdout);

        const usageByDigest = new Map<string, number>();
        const usageByReference = new Map<string, number>();

        const containerResult = await execContainer([ "list", "--all", "--format", "json" ]);
        if (containerResult.exitCode === 0) {
            const containerItems = parseJsonOutputRecords(containerResult.stdout);
            for (const containerItem of containerItems) {
                const digest = readContainerImageDigest(containerItem);
                if (digest) {
                    usageByDigest.set(digest, (usageByDigest.get(digest) ?? 0) + 1);
                }

                const candidates = new Set(buildImageReferenceCandidates(readContainerImageReference(containerItem)));
                for (const candidate of candidates) {
                    usageByReference.set(candidate, (usageByReference.get(candidate) ?? 0) + 1);
                }
            }
        }

        return items
            .map((item) => {
                const reference = readImageReference(item);
                const digest = readImageDigest(item);

                let inUseCount = 0;
                if (digest) {
                    inUseCount = usageByDigest.get(digest) ?? 0;
                }

                if (inUseCount === 0) {
                    for (const candidate of buildImageReferenceCandidates(reference)) {
                        inUseCount = Math.max(inUseCount, usageByReference.get(candidate) ?? 0);
                    }
                }

                return {
                    reference,
                    digest,
                    mediaType: readImageMediaType(item),
                    fullSize: readImageSize(item),
                    inUseCount,
                };
            })
            .filter((image) => image.reference.length > 0);
    }

    async deleteImage(reference: string): Promise<void> {
        const imageList = await this.getImageList();
        const requestedCandidates = new Set(buildImageReferenceCandidates(reference));

        const matched = imageList.find((image) => {
            const imageCandidates = buildImageReferenceCandidates(image.reference);
            return imageCandidates.some((candidate) => requestedCandidates.has(candidate));
        });

        if (matched && (matched.inUseCount ?? 0) > 0) {
            throw new Error(`Cannot delete image ${reference}: image is used by ${matched.inUseCount} container(s)`);
        }

        const result = await execContainer([ "image", "delete", reference ]);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to delete image ${reference}: ${result.stderr.trim()}`);
        }
    }

    async getNetworkList(): Promise<string[]> {
        const result = await execContainer([ "network", "list", "--format", "json" ]);
        if (result.exitCode !== 0) {
            return [];
        }
        try {
            const parsed = JSON.parse(result.stdout.trim());
            const items = Array.isArray(parsed) ? parsed : [ parsed ];
            return items.map((n: Record<string, unknown>) => String(n.name ?? n.Name ?? "")).filter(Boolean);
        } catch {
            return [];
        }
    }

    getCapabilities(): RuntimeCapabilities {
        return {
            supportsFollowLogs: true,
            supportsInteractiveExec: true,
            supportsNetworks: true,
            supportsVolumes: true,
            supportsRestart: false,
            runtimeName: "apple-container",
        };
    }

    private getContainerNames(stackName: string, serviceName?: string): string[] {
        const lockData = this.lock.read(stackName);
        if (!lockData) {
            if (!serviceName) {
                return [ stackName ];
            }
            return [];
        }
        if (serviceName) {
            const svc = lockData.services[serviceName];
            return svc ? [ svc.containerName ] : [];
        }
        return Object.values(lockData.services).map((s) => s.containerName);
    }

    private async hasLocalImage(reference: string): Promise<boolean> {
        const result = await execContainer([ "image", "list", "--format", "json" ]);
        if (result.exitCode !== 0) {
            return false;
        }

        const requestedCandidates = new Set(buildImageReferenceCandidates(reference));
        const imageItems = parseJsonOutputRecords(result.stdout);
        for (const imageItem of imageItems) {
            const imageReference = readImageReference(imageItem);
            if (!imageReference) {
                continue;
            }

            const imageCandidates = buildImageReferenceCandidates(imageReference);
            if (imageCandidates.some((candidate) => requestedCandidates.has(candidate))) {
                return true;
            }
        }

        return false;
    }

    private async listAllContainers(): Promise<ContainerStatus[]> {
        const result = await execContainer([ "list", "--all", "--format", "json" ]);
        if (result.exitCode !== 0) {
            return [];
        }
        const items = parseJsonOutputRecords(result.stdout);

        return items
            .filter((item) => !isInternalContainer(item))
            .map((item) => ({
                name: readContainerName(item),
                state: mapState(readContainerState(item)),
                exitCode: readContainerExitCode(item),
                startedAt: readContainerStartedAt(item),
            }))
            .filter((container) => container.name.length > 0);
    }
}
