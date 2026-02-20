import { log } from "./log";
import compareVersions from "compare-versions";
import packageJSON from "../package.json";
import { Settings } from "./settings";

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;
const CHECK_URL = process.env.DOCKGE_AC_CHECK_URL || "https://dockge.kuma.pet/version";
const CHECK_TOKEN = process.env.DOCKGE_AC_CHECK_TOKEN;

interface VersionPayload {
    slow?: string;
    beta?: string;
}

const VERSION_TOKEN_REGEX = /v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object") {
        return value as Record<string, unknown>;
    }
    return {};
}

function readVersionString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    const tokenMatch = trimmed.match(VERSION_TOKEN_REGEX);
    if (tokenMatch?.[0]) {
        return tokenMatch[0];
    }

    return trimmed;
}

function parseResponseData(body: string, contentType: string): unknown {
    const trimmed = body.trim();
    if (!trimmed) {
        return "";
    }

    const maybeJson = contentType.includes("application/json") || /^[\[{\"]/.test(trimmed);
    if (maybeJson) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return trimmed;
        }
    }

    return trimmed;
}

function normalizeVersionPayload(data: unknown): VersionPayload {
    if (typeof data === "string") {
        return { slow: readVersionString(data) };
    }

    if (Array.isArray(data)) {
        const entries = data.map(asRecord);

        if (entries.some((entry) => "tag_name" in entry || "prerelease" in entry)) {
            const stable = entries.find((entry) => !entry.draft && !entry.prerelease);
            const prerelease = entries.find((entry) => !entry.draft && entry.prerelease);

            return {
                slow: readVersionString(stable?.tag_name),
                beta: readVersionString(prerelease?.tag_name),
            };
        }

        const firstTag = entries.find((entry) => readVersionString(entry.name));
        return {
            slow: readVersionString(firstTag?.name),
        };
    }

    const obj = asRecord(data);

    if ("slow" in obj || "beta" in obj) {
        return {
            slow: readVersionString(obj.slow),
            beta: readVersionString(obj.beta),
        };
    }

    if ("tag_name" in obj) {
        return {
            slow: readVersionString(obj.tag_name),
        };
    }

    if ("name" in obj) {
        return {
            slow: readVersionString(obj.name),
        };
    }

    return {};
}

function isVersionGreater(v1: string, v2: string): boolean {
    try {
        return compareVersions.compare(v1, v2, ">");
    } catch {
        return false;
    }
}

class CheckVersion {
    version = packageJSON.version;
    latestVersion? : string;
    interval? : NodeJS.Timeout;

    async startInterval() {
        const check = async () => {
            if (await Settings.get("checkUpdate") === false) {
                return;
            }

            log.debug("update-checker", "Retrieving latest versions");

            try {
                const headers: Record<string, string> = {
                    "Accept": "application/json, application/vnd.github+json",
                    "User-Agent": "Dockge-AC-UpdateChecker",
                };

                if (CHECK_TOKEN) {
                    headers.Authorization = `Bearer ${CHECK_TOKEN}`;
                }

                const res = await fetch(CHECK_URL, {
                    headers,
                });

                if (!res.ok) {
                    throw new Error(`Version endpoint returned ${res.status}`);
                }

                const body = await res.text();
                const contentType = res.headers.get("content-type")?.toLowerCase() || "";
                const data = parseResponseData(body, contentType);
                const payload = normalizeVersionPayload(data);

                // For debug
                if (process.env.TEST_CHECK_VERSION === "1") {
                    payload.slow = "1000.0.0";
                }

                const checkBeta = await Settings.get("checkBeta");

                if (checkBeta && payload.beta) {
                    if (!payload.slow || isVersionGreater(payload.beta, payload.slow)) {
                        this.latestVersion = payload.beta;
                        return;
                    }
                }

                if (payload.slow) {
                    this.latestVersion = payload.slow;
                } else if (payload.beta) {
                    this.latestVersion = payload.beta;
                }

            } catch (_) {
                log.info("update-checker", "Failed to check for new versions");
            }

        };

        await check();
        this.interval = setInterval(check, UPDATE_CHECKER_INTERVAL_MS);
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
