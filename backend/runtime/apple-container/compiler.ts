import YAML from "yaml";
import { StackPlan, ServicePlan, CompileResult, CompileError } from "../types.js";

const SUPPORTED_SERVICE_KEYS = new Set([
    "image", "command", "entrypoint", "environment", "env_file",
    "ports", "volumes", "networks", "working_dir", "user",
    "depends_on", "container_name", "stdin_open", "tty",
    "restart"
]);

const BLOCKED_SERVICE_KEYS = new Set([
    "deploy", "profiles", "secrets", "configs", "healthcheck",
    "build", "cap_add", "cap_drop", "cgroup_parent", "devices",
    "dns", "dns_search", "domainname", "external_links",
    "extra_hosts", "init", "ipc", "isolation", "labels",
    "links", "logging", "network_mode", "pid", "platform",
    "privileged", "read_only", "security_opt", "shm_size",
    "sysctls", "tmpfs", "ulimits", "userns_mode"
]);

const SUPPORTED_TOP_LEVEL_KEYS = new Set([
    "services", "networks", "volumes", "version", "name"
]);

function normalizeEnvironment(env: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (Array.isArray(env)) {
        for (const item of env) {
            const str = String(item);
            const eqIdx = str.indexOf("=");
            if (eqIdx === -1) {
                result[str] = "";
            } else {
                result[str.substring(0, eqIdx)] = str.substring(eqIdx + 1);
            }
        }
    } else if (env && typeof env === "object") {
        for (const [ k, v ] of Object.entries(env as Record<string, unknown>)) {
            result[k] = v == null ? "" : String(v);
        }
    }
    return result;
}

function normalizeDependsOn(dep: unknown, servicePath: string, warnings: string[]): string[] {
    if (Array.isArray(dep)) {
        return dep.map(String);
    }
    if (dep && typeof dep === "object") {
        warnings.push(`${servicePath}.depends_on: object form detected — conditions ignored, only service names extracted`);
        return Object.keys(dep as Record<string, unknown>);
    }
    return [];
}

function validateKeys(
    obj: Record<string, unknown>,
    path: string,
    errors: CompileError[],
    warnings: string[]
): void {
    for (const key of Object.keys(obj)) {
        if (BLOCKED_SERVICE_KEYS.has(key)) {
            errors.push({
                key,
                path: `${path}.${key}`,
                message: `Unsupported key "${key}" at ${path}.${key} — blocked in Apple Container mode`
            });
        } else if (!SUPPORTED_SERVICE_KEYS.has(key)) {
            warnings.push(`Unknown key "${key}" at ${path}.${key} — ignored`);
        }
    }
}

function buildServicePlan(name: string, svc: Record<string, unknown>, warnings: string[]): ServicePlan {
    const plan: ServicePlan = {
        image: String(svc.image || ""),
    };

    if (svc.command != null) {
        plan.command = String(svc.command);
    }
    if (svc.environment != null) {
        plan.environment = normalizeEnvironment(svc.environment);
    }
    if (Array.isArray(svc.ports)) {
        plan.ports = svc.ports.map(String);
    }
    if (Array.isArray(svc.volumes)) {
        plan.volumes = svc.volumes.map(String);
    }
    if (Array.isArray(svc.networks)) {
        plan.networks = svc.networks.map(String);
    }
    if (svc.working_dir != null) {
        plan.workingDir = String(svc.working_dir);
    }
    if (svc.user != null) {
        plan.user = String(svc.user);
    }
    if (svc.depends_on != null) {
        plan.dependsOn = normalizeDependsOn(svc.depends_on, `services.${name}`, warnings);
    }

    return plan;
}

export function compile(yamlContent: string, stackName: string): CompileResult {
    const errors: CompileError[] = [];
    const warnings: string[] = [];

    if (!yamlContent || !yamlContent.trim()) {
        errors.push({ key: "",
            path: "",
            message: "Empty compose file" });
        return {
            plan: { stackName,
                services: {} },
            errors,
            warnings
        };
    }

    let doc: Record<string, unknown>;
    try {
        doc = YAML.parse(yamlContent) as Record<string, unknown>;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ key: "",
            path: "",
            message: `YAML parse error: ${msg}` });
        return {
            plan: { stackName,
                services: {} },
            errors,
            warnings
        };
    }

    if (!doc || typeof doc !== "object") {
        errors.push({ key: "",
            path: "",
            message: "Invalid compose file: not an object" });
        return {
            plan: { stackName,
                services: {} },
            errors,
            warnings
        };
    }

    for (const key of Object.keys(doc)) {
        if (!SUPPORTED_TOP_LEVEL_KEYS.has(key)) {
            errors.push({
                key,
                path: key,
                message: `Unsupported top-level key "${key}" — not supported in Apple Container mode`
            });
        }
    }

    const services = doc.services;
    if (!services || typeof services !== "object") {
        errors.push({ key: "services",
            path: "services",
            message: "No services defined" });
        return {
            plan: { stackName,
                services: {} },
            errors,
            warnings
        };
    }

    const servicePlans: Record<string, ServicePlan> = {};
    const svcEntries = services as Record<string, unknown>;

    for (const [ svcName, svcDef ] of Object.entries(svcEntries)) {
        if (!svcDef || typeof svcDef !== "object") {
            errors.push({
                key: svcName,
                path: `services.${svcName}`,
                message: `Service "${svcName}" is not a valid object`
            });
            continue;
        }

        const svc = svcDef as Record<string, unknown>;

        validateKeys(svc, `services.${svcName}`, errors, warnings);

        if (!svc.image) {
            errors.push({
                key: "image",
                path: `services.${svcName}.image`,
                message: `Service "${svcName}" has no image`
            });
            continue;
        }

        // Warn about restart (parsed but not enforced)
        if (svc.restart) {
            warnings.push(`services.${svcName}.restart: parsed but not enforced by Apple Container runtime`);
        }

        servicePlans[svcName] = buildServicePlan(svcName, svc, warnings);
    }

    const networks = doc.networks && typeof doc.networks === "object"
        ? Object.keys(doc.networks as Record<string, unknown>)
        : undefined;

    const volumes = doc.volumes && typeof doc.volumes === "object"
        ? Object.keys(doc.volumes as Record<string, unknown>)
        : undefined;

    const plan: StackPlan = {
        stackName,
        services: servicePlans,
        networks,
        volumes,
    };

    return { plan,
        errors,
        warnings };
}

export function validate(yamlContent: string): { errors: CompileError[]; warnings: string[] } {
    const result = compile(yamlContent, "__validate__");
    return { errors: result.errors,
        warnings: result.warnings };
}
