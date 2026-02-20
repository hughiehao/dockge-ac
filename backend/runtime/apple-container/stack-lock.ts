import fs from "fs";
import path from "path";
import crypto from "crypto";
import { StackLockData } from "../types.js";

export class StackLock {
    private locksDir: string;

    constructor(dataDir: string) {
        this.locksDir = path.join(dataDir, "locks");
        if (!fs.existsSync(this.locksDir)) {
            fs.mkdirSync(this.locksDir, { recursive: true });
        }
    }

    read(stackName: string): StackLockData | null {
        const lockPath = this.getLockPath(stackName);
        try {
            const content = fs.readFileSync(lockPath, "utf-8");
            return JSON.parse(content) as StackLockData;
        } catch {
            return null;
        }
    }

    write(stackName: string, data: StackLockData): void {
        const lockPath = this.getLockPath(stackName);
        const tmpPath = `${lockPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, lockPath);
    }

    delete(stackName: string): void {
        const lockPath = this.getLockPath(stackName);
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
        }
    }

    exists(stackName: string): boolean {
        const lockPath = this.getLockPath(stackName);
        return fs.existsSync(lockPath);
    }

    getFingerprint(composeContent: string): string {
        return crypto.createHash("sha256").update(composeContent).digest("hex");
    }

    hasChanged(stackName: string, composeContent: string): boolean {
        const lockData = this.read(stackName);
        if (!lockData) {
            return true;
        }
        const currentFingerprint = this.getFingerprint(composeContent);
        return lockData.fingerprint !== currentFingerprint;
    }

    listAll(): string[] {
        if (!fs.existsSync(this.locksDir)) {
            return [];
        }
        const files = fs.readdirSync(this.locksDir);
        return files
            .filter((file) => file.endsWith(".lock.json"))
            .map((file) => file.replace(".lock.json", ""));
    }

    private getLockPath(stackName: string): string {
        return path.join(this.locksDir, `${stackName}.lock.json`);
    }
}

export default StackLock;
