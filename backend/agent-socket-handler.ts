import { DockgeACServer } from "./dockge-server";
import { AgentSocket } from "../common/agent-socket";
import { DockgeACSocket } from "./util-server";

export abstract class AgentSocketHandler {
    abstract create(socket : DockgeACSocket, server : DockgeACServer, agentSocket : AgentSocket): void;
}
