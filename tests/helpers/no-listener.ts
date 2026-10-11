/**
 * Preload (`bun --preload tests/helpers/no-listener.ts …`) that fails the process
 * with exit code 99 the moment it tries to accept connections: Bun.serve, or
 * listen() on any node:net server (node:http and node:https servers are net
 * servers). It also fails on loading server/src/index.ts, the server entry point.
 * The report CLI tests run under it to prove `yald report` opens no port.
 */
import { plugin } from "bun";
import net from "node:net";

function refuse(what: string): never {
  process.stderr.write(`NO-LISTENER GUARD: ${what}\n`);
  process.exit(99);
}

Bun.serve = (() => refuse("Bun.serve() was called")) as unknown as typeof Bun.serve;
net.Server.prototype.listen = function listen() {
  refuse("net.Server.listen() was called");
} as unknown as typeof net.Server.prototype.listen;

plugin({
  name: "no-server-entry",
  setup(build) {
    build.onLoad({ filter: /[\\/]server[\\/]src[\\/]index\.ts$/ }, () => refuse("server/src/index.ts was imported"));
  },
});
