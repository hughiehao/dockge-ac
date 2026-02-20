import { StackPlan, ContainerStatus, RuntimeCapabilities, TerminalConfig, RuntimeImage } from "./types.js";

export abstract class RuntimeAdapter {
  abstract deploy(plan: StackPlan): Promise<void>;
  abstract start(stackName: string, serviceName?: string): Promise<void>;
  abstract stop(stackName: string, serviceName?: string): Promise<void>;
  abstract down(stackName: string, removeVolumes?: boolean): Promise<void>;
  abstract restart(stackName: string, serviceName?: string): Promise<void>;
  abstract getServiceStatusList(stackName: string): Promise<Map<string, ContainerStatus>>;
  abstract getStackStatus(stackName: string): Promise<number>;
  abstract getAllStackStatus(): Promise<Map<string, number>>;
  abstract logs(stackName: string, serviceName: string, tail?: number, follow?: boolean): AsyncGenerator<string>;
  abstract exec(stackName: string, serviceName: string, command: string): TerminalConfig;
  abstract pullImage(image: string): Promise<void>;
  abstract getImageList(): Promise<RuntimeImage[]>;
  abstract deleteImage(reference: string): Promise<void>;
  abstract getNetworkList(): Promise<string[]>;
  abstract getCapabilities(): RuntimeCapabilities;
}
