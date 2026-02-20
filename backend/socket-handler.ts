import { DockgeACServer } from "./dockge-server";
import { DockgeACSocket } from "./util-server";

export abstract class SocketHandler {
    abstract create(socket : DockgeACSocket, server : DockgeACServer): void;
}
