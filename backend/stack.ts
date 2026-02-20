import { DockgeACServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import dotenv from "dotenv";
import { DockgeACSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    envsubstYAML,
    getCombinedTerminalName,
    getContainerExecTerminalName,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import { Settings } from "./settings";
import { AppleContainerAdapter } from "./runtime/apple-container/adapter.js";
import { compile } from "./runtime/apple-container/compiler.js";
import { StackLock } from "./runtime/apple-container/stack-lock.js";

const CONTAINER_PREFIX = "dockgeac";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeACServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    private static adapter: AppleContainerAdapter | null = null;
    private static stackLock: StackLock | null = null;

    static getAdapter(server: DockgeACServer): AppleContainerAdapter {
        if (!Stack.adapter) {
            Stack.adapter = new AppleContainerAdapter(server.config.dataDir);
        }
        return Stack.adapter;
    }

    static getStackLock(server: DockgeACServer): StackLock {
        if (!Stack.stackLock) {
            Stack.stackLock = new StackLock(server.config.dataDir);
        }
        return Stack.stackLock;
    }

    constructor(server : DockgeACServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack via adapter
     */
    async ps() : Promise<object> {
        const adapter = Stack.getAdapter(this.server);
        const statusMap = await adapter.getServiceStatusList(this.name);
        const result: Record<string, object> = {};
        for (const [ svc, status ] of statusMap) {
            result[svc] = status;
        }
        return result;
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Write or overwrite the compose.yaml
        await fsAsync.writeFile(path.join(dir, this._composeFileName), this.composeYAML);

        const envPath = path.join(dir, ".env");

        // Write or overwrite the .env
        // If .env is not existing and the composeENV is empty, we don't need to write it
        if (await fileExists(envPath) || this.composeENV.trim() !== "") {
            await fsAsync.writeFile(envPath, this.composeENV);
        }
    }

    async deploy(socket : DockgeACSocket) : Promise<number> {
        const adapter = Stack.getAdapter(this.server);
        const lock = Stack.getStackLock(this.server);

        const env = dotenv.parse(this.composeENV ?? "");
        const renderedComposeYAML = envsubstYAML(this.composeYAML ?? "", env);

        const { plan, errors, warnings } = compile(renderedComposeYAML, this.name);

        if (errors.length > 0) {
            const errorMsg = errors.map(e => `${e.path}: ${e.message}`).join("\n");
            log.error("deploy", `Preflight failed for ${this.name}: ${errorMsg}`);
            throw new Error(`Preflight failed:\n${errorMsg}`);
        }

        for (const w of warnings) {
            log.warn("deploy", `${this.name}: ${w}`);
        }

        try {
            await adapter.deploy(plan);
            const lockData = lock.read(this.name);
            if (lockData) {
                lockData.fingerprint = lock.getFingerprint(this.composeYAML ?? "");
                lock.write(this.name, lockData);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.error("deploy", msg);
            throw e;
        }

        return 0;
    }

    async delete(socket: DockgeACSocket) : Promise<number> {
        const adapter = Stack.getAdapter(this.server);

        try {
            await adapter.down(this.name);
        } catch (e) {
            log.warn("delete", `Failed to down stack ${this.name}: ${e}`);
        }

        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return 0;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList();
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeACServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get status from adapter
        const adapter = Stack.getAdapter(server);
        try {
            const allStatus = await adapter.getAllStackStatus();
            for (const [ stackName, status ] of allStatus) {
                let stack = stackList.get(stackName);
                if (!stack) {
                    if (stackName === "dockge") {
                        continue;
                    }
                    stack = new Stack(server, stackName);
                    stackList.set(stackName, stack);
                }
                stack._status = status;
            }
        } catch (e) {
            log.warn("getStackList", `Failed to get adapter status: ${e}`);
        }

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed will be returned
     */
    static async getStatusList() : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();
        try {
            const adapter = Stack.getAdapter(Stack.managedStackList.values().next().value?.server);
            if (adapter) {
                return await adapter.getAllStackStatus();
            }
        } catch (e) {
            log.error("getStatusList", e);
        }
        return statusList;
    }

    static async getStack(server: DockgeACServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed externally
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    async start(socket: DockgeACSocket) {
        const adapter = Stack.getAdapter(this.server);
        const lock = Stack.getStackLock(this.server);

        if (this.isManagedByDockge && !lock.read(this.name)) {
            return await this.deploy(socket);
        }

        try {
            await adapter.start(this.name);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);

            if (this.isManagedByDockge && /not found/i.test(msg)) {
                return await this.deploy(socket);
            }

            throw e;
        }

        return 0;
    }

    async stop(socket: DockgeACSocket) : Promise<number> {
        const adapter = Stack.getAdapter(this.server);
        await adapter.stop(this.name);
        return 0;
    }

    async restart(socket: DockgeACSocket) : Promise<number> {
        const adapter = Stack.getAdapter(this.server);
        await adapter.restart(this.name);
        return 0;
    }

    async down(socket: DockgeACSocket) : Promise<number> {
        const adapter = Stack.getAdapter(this.server);
        await adapter.down(this.name);
        return 0;
    }

    async update(socket: DockgeACSocket) {
        const adapter = Stack.getAdapter(this.server);
        const lock = Stack.getStackLock(this.server);

        const env = dotenv.parse(this.composeENV ?? "");
        const renderedComposeYAML = envsubstYAML(this.composeYAML ?? "", env);

        for (const svc of Object.values((compile(renderedComposeYAML, this.name)).plan.services)) {
            await adapter.pullImage(svc.image);
        }

        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return 0;
        }

        const { plan, errors } = compile(renderedComposeYAML, this.name);
        if (errors.length > 0) {
            throw new Error(`Preflight failed: ${errors.map(e => e.message).join(", ")}`);
        }

        await adapter.down(this.name);
        await adapter.deploy(plan);

        const lockData = lock.read(this.name);
        if (lockData) {
            lockData.fingerprint = lock.getFingerprint(this.composeYAML ?? "");
            lock.write(this.name, lockData);
        }

        return 0;
    }

    async joinCombinedTerminal(socket: DockgeACSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "container", [ "logs", "--follow", "--tail", "100", `${CONTAINER_PREFIX}_${this.name}` ], this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeACSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeACSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            const cName = `${CONTAINER_PREFIX}_${this.name}_${serviceName}_1`;
            terminal = new InteractiveTerminal(this.server, terminalName, "container", [ "exec", "-it", cName, shell ], this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, { state: string, ports: string[] }>();

        try {
            const adapter = Stack.getAdapter(this.server);
            const adapterStatusMap = await adapter.getServiceStatusList(this.name);

            for (const [ svcName, status ] of adapterStatusMap) {
                statusList.set(svcName, {
                    state: status.state,
                    ports: [],
                });
            }

            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }
}
