import { DockgeACServer } from "./dockge-server";
import { log } from "./log";

log.info("server", "Welcome to dockge-ac!");
const server = new DockgeACServer();
await server.serve();
