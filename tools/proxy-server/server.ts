import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

const DEFAULT_HOSTS = [
  "auth.openai.com",
  "api.openai.com",
  "chatgpt.com",
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
];
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function integer(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.T3_PROXY_HOST ?? "127.0.0.1";
  if (!NodeNet.isIP(host)) throw new Error("T3_PROXY_HOST must be an IPv4 or IPv6 listen address");
  const allowedHosts = new Set(
    (env.T3_PROXY_ALLOWED_HOSTS ?? DEFAULT_HOSTS.join(","))
      .split(",")
      .map((host) => host.trim().toLowerCase()),
  );
  if ([...allowedHosts].some((host) => !HOSTNAME.test(host))) {
    throw new Error(
      "T3_PROXY_ALLOWED_HOSTS must contain exact hostnames, separated by commas (no wildcards)",
    );
  }
  const allowedPorts = new Set(
    (env.T3_PROXY_ALLOWED_PORTS ?? "443")
      .split(",")
      .map((port) => integer(port.trim(), "T3_PROXY_ALLOWED_PORTS", 65535)),
  );
  const certPath = env.T3_PROXY_TLS_CERT;
  const keyPath = env.T3_PROXY_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error(
      "Set both T3_PROXY_TLS_CERT and T3_PROXY_TLS_KEY to enable HTTPS on the listener",
    );
  }
  return {
    host,
    port: integer(env.T3_PROXY_PORT ?? "3128", "T3_PROXY_PORT", 65535),
    allowedHosts,
    allowedPorts,
    maxConnections: integer(
      env.T3_PROXY_MAX_CONNECTIONS ?? "256",
      "T3_PROXY_MAX_CONNECTIONS",
      10000,
    ),
    connectTimeoutMs: integer(
      env.T3_PROXY_CONNECT_TIMEOUT_MS ?? "10000",
      "T3_PROXY_CONNECT_TIMEOUT_MS",
      300000,
    ),
    idleTimeoutMs: integer(
      env.T3_PROXY_IDLE_TIMEOUT_MS ?? "600000",
      "T3_PROXY_IDLE_TIMEOUT_MS",
      86400000,
    ),
    certPath,
    keyPath,
  };
}

// CONNECT transports the provider's TLS stream unchanged, including OAuth and WSS.
export function createProxyServer(config: ReturnType<typeof readConfig>) {
  const sockets = new Set<NodeStream.Duplex>();
  let closing = false;
  let serverClosed = false;
  let shutdown: Promise<void> | undefined;
  let finishShutdown = () => {};
  const handler: NodeHttp.RequestListener = (request, response) => {
    const healthy = request.method === "GET" && request.url === "/healthz" && !closing;
    response.writeHead(healthy ? 200 : 405, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    response.end(healthy ? "ok\n" : "HTTPS CONNECT required\n");
  };
  const options = { maxHeaderSize: 8192, headersTimeout: 15000, requestTimeout: 30000 };
  const server =
    config.certPath && config.keyPath
      ? NodeHttps.createServer(
          {
            ...options,
            handshakeTimeout: 15000,
            cert: NodeFS.readFileSync(config.certPath),
            key: NodeFS.readFileSync(config.keyPath),
          },
          handler,
        )
      : NodeHttp.createServer(options, handler);
  server.maxConnections = config.maxConnections;
  server.timeout = config.idleTimeoutMs;

  const track = (socket: NodeStream.Duplex) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      finishShutdown();
    });
    socket.on("error", () => socket.destroy());
  };
  server.on("connection", (socket) => {
    track(socket);
    if (closing) socket.destroy();
  });
  const reject = (socket: NodeStream.Duplex, status: number, reason: string) => {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // A peer need not acknowledge our FIN. Bound rejected connections as well.
    const timer = setTimeout(() => socket.destroy(), 1000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
  };
  server.on("clientError", (_error, socket) => reject(socket, 400, "Bad Request"));
  server.on("connect", (request, client, head) => {
    if (closing) return reject(client, 503, "Service Unavailable");
    const match = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(request.url ?? "");
    if (
      !match ||
      !HOSTNAME.test(match[1]!.toLowerCase()) ||
      Number(match[2]) < 1 ||
      Number(match[2]) > 65535
    ) {
      return reject(client, 400, "Bad Request");
    }
    const host = match[1]!.toLowerCase();
    const port = Number(match[2]);
    if (!config.allowedHosts.has(host) || !config.allowedPorts.has(port)) {
      return reject(client, 403, "Forbidden");
    }
    const upstream = NodeNet.connect({ host, port });
    track(upstream);
    let connected = false;
    const connectTimer = setTimeout(() => {
      reject(client, 504, "Gateway Timeout");
      upstream.destroy();
    }, config.connectTimeoutMs);
    connectTimer.unref();
    client.once("close", () => {
      clearTimeout(connectTimer);
      upstream.destroy();
    });
    upstream.once("error", () => {
      clearTimeout(connectTimer);
      if (connected) client.destroy();
      else reject(client, 502, "Bad Gateway");
    });
    upstream.once("close", () => {
      clearTimeout(connectTimer);
      if (connected && !upstream.readableEnded) client.destroy();
    });
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      if (client.destroyed) return upstream.destroy();
      connected = true;
      upstream.setTimeout(config.idleTimeoutMs, () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  return {
    server,
    close(graceMs = 10000): Promise<void> {
      if (shutdown) return shutdown;
      closing = true;
      shutdown = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, graceMs);
        timer.unref();
        finishShutdown = () => {
          if (serverClosed && sockets.size === 0) {
            clearTimeout(timer);
            resolve();
          }
        };
        server.close(() => {
          serverClosed = true;
          finishShutdown();
        });
        server.closeIdleConnections();
      });
      return shutdown;
    },
  };
}

if (import.meta.main) {
  try {
    const config = readConfig();
    const proxy = createProxyServer(config);
    proxy.server.on("error", (error: NodeJS.ErrnoException) => {
      console.error(`Proxy listener failed: ${error.code ?? error.name}`);
      process.exitCode = 1;
      void proxy.close(0);
    });
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        console.log(`Received ${signal}; draining connections`);
        void proxy.close();
      });
    }
    proxy.server.listen(config.port, config.host, () => {
      console.log(
        `T3 proxy listening on ${config.certPath ? "https" : "http"}://${config.host}:${config.port}; ${config.allowedHosts.size} allowed destinations`,
      );
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Proxy startup failed");
    process.exitCode = 1;
  }
}
