// Environment, homes and pricing have already been supplied by the Node launcher.
// This entry owns its listener explicitly, so readiness means a successful bind.
export {};
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
function stop() {
  stopping = true;
  server?.stop(true);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("disconnect", stop);
if (process.env.YALD_DEMO !== "1" || !process.send || !process.env.YALD_DEMO_TOKEN) {
  throw new Error("Start the isolated demo with yald demo.");
}
const { default: options } = await import("../index");
if (!stopping) {
  server = Bun.serve(options);
  process.send({ type: "yald-demo-ready", token: process.env.YALD_DEMO_TOKEN, port: server.port });
}
