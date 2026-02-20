import { spawn } from "child_process";
import { RuntimeCapabilities } from "../types.js";

async function execQuiet(
    cmd: string,
    args: string[]
): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args);
        let stdout = "";
        proc.stdout?.on("data", (d) => {
            stdout += d.toString();
        });
        proc.on("close", (code) => {
            resolve({ stdout,
                exitCode: code ?? 1 });
        });
        proc.on("error", () => {
            resolve({ stdout: "",
                exitCode: 1 });
        });
    });
}

export async function isRuntimeAvailable(): Promise<boolean> {
    const result = await execQuiet("container", [ "system", "status" ]);
    return result.exitCode === 0;
}

export async function detectCapabilities(): Promise<RuntimeCapabilities> {
    const available = await isRuntimeAvailable();
    if (!available) {
        throw new Error("Apple Container runtime not available");
    }

    let runtimeVersion = "unknown";
    const versionResult = await execQuiet("container", [ "--version" ]);
    if (versionResult.exitCode === 0) {
        runtimeVersion = versionResult.stdout.trim();
    } else {
        const altVersionResult = await execQuiet("container", [ "version" ]);
        if (altVersionResult.exitCode === 0) {
            runtimeVersion = altVersionResult.stdout.trim();
        }
    }

    return {
        supportsFollowLogs: true,
        supportsInteractiveExec: true,
        supportsNetworks: true,
        supportsVolumes: true,
        supportsRestart: false,
        runtimeName: "apple-container",
        runtimeVersion,
    };
}
