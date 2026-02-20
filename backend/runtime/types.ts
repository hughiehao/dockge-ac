export interface ServicePlan {
  image: string;
  command?: string;
  environment?: Record<string, string>;
  ports?: string[];           // "host:container" format
  volumes?: string[];         // "host:container" format
  networks?: string[];
  workingDir?: string;
  user?: string;
  dependsOn?: string[];
}

export interface StackPlan {
  stackName: string;
  services: Record<string, ServicePlan>;
  networks?: string[];
  volumes?: string[];
  envFiles?: string[];
}

export interface CompileResult {
  plan: StackPlan;
  errors: CompileError[];
  warnings: string[];
}

export interface CompileError {
  key: string;
  path: string;        // e.g. "services.web.deploy"
  message: string;
}

export interface StackLockData {
  stackName: string;
  fingerprint: string;  // sha256 of compose.yaml content
  services: Record<string, LockedService>;
  networks: string[];
  volumes: string[];
  lastDeployed: string; // ISO timestamp
}

export interface LockedService {
  containerName: string;
  containerId?: string;
  image: string;
  createdAt: string;
}

export interface ContainerStatus {
  name: string;
  state: "running" | "stopped" | "created" | "unknown";
  exitCode?: number;
  startedAt?: string;
}

export interface RuntimeImage {
  reference: string;
  digest?: string;
  mediaType?: string;
  fullSize?: string;
  inUseCount?: number;
}

export interface RuntimeCapabilities {
  supportsFollowLogs: boolean;
  supportsInteractiveExec: boolean;
  supportsNetworks: boolean;
  supportsVolumes: boolean;
  supportsRestart: boolean;
  runtimeName: string;
  runtimeVersion?: string;
}

export interface TerminalConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}
