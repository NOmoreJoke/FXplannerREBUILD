import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogServer } from "./server.js";
import { LogWriter } from "./writer.js";

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const port = Number(process.env.DEV_LOG_PORT ?? 8787);

const writer = new LogWriter({ dir: path.join(packageRoot, "logs") });
const server = createLogServer({ writer });

server.listen(port, "127.0.0.1", () => {
	console.log(
		`[dev-log-server] listening on http://127.0.0.1:${port}/frontend-log`,
	);
	console.log(`[dev-log-server] log dir: ${path.join(packageRoot, "logs")}`);
});

server.on("error", (error) => {
	console.error("[dev-log-server] failed to start:", error);
	process.exit(1);
});
