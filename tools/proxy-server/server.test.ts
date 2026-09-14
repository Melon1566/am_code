import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeHttps from "node:https";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import * as NodeChildProcess from "node:child_process";
import { createProxyServer, readConfig } from "./server.ts";

async function listen(server: NodeNet.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  NodeAssert.ok(address && typeof address !== "string");
  return address.port;
}

function readUntil(socket: NodeNet.Socket, ending: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let result = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error(`Connection closed before ${JSON.stringify(ending)}`));
    const onData = (chunk: Buffer) => {
      result += chunk.toString();
      if (result.includes(ending)) {
        cleanup();
        resolve(result);
      }
    };
    socket.on("data", onData).once("error", onError).once("close", onClose);
  });
}

NodeTest.test("configuration defaults to local-only and validates configuration", () => {
  const config = readConfig({});
  NodeAssert.equal(config.host, "127.0.0.1");
  NodeAssert.equal(config.port, 3128);
  NodeAssert.ok(config.allowedHosts.has("auth.openai.com"));
  for (const env of [
    { T3_PROXY_PORT: "0" },
    { T3_PROXY_PORT: "12junk" },
    { T3_PROXY_PORT: "65536" },
    { T3_PROXY_ALLOWED_HOSTS: "*" },
    { T3_PROXY_ALLOWED_HOSTS: "" },
    { T3_PROXY_ALLOWED_PORTS: "443,no" },
    { T3_PROXY_TLS_CERT: "/cert.pem" },
    { T3_PROXY_MAX_CONNECTIONS: "-1" },
    { T3_PROXY_HOST: "" },
  ])
    NodeAssert.throws(() => readConfig(env));
  NodeAssert.deepEqual(
    [...readConfig({ T3_PROXY_ALLOWED_HOSTS: "AUTH.OPENAI.COM, api.openai.com" }).allowedHosts],
    ["auth.openai.com", "api.openai.com"],
  );
});

NodeTest.test(
  "CONNECT forwards bytes both ways, including bytes sent with the headers",
  { timeout: 5000 },
  async (t) => {
    const upstream = NodeNet.createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    const proxy = createProxyServer(
      readConfig({
        T3_PROXY_ALLOWED_HOSTS: "127.0.0.1",
        T3_PROXY_ALLOWED_PORTS: String(upstreamPort),
      }),
    );
    const proxyPort = await listen(proxy.server);
    const client = NodeNet.connect(proxyPort, "127.0.0.1");
    t.after(async () => {
      client.destroy();
      await proxy.close(0);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const received = readUntil(client, "first-payload");
    client.write(
      `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\nfirst-payload`,
    );
    NodeAssert.match(await received, /^HTTP\/1.1 200 Connection Established\r\n\r\nfirst-payload$/);
    const second = readUntil(client, "second-payload");
    client.write("second-payload");
    NodeAssert.equal(await second, "second-payload");
  },
);

NodeTest.test(
  "rejects unlisted hosts, ports and malformed CONNECT authorities",
  { timeout: 5000 },
  async (t) => {
    const proxy = createProxyServer(readConfig({}));
    const port = await listen(proxy.server);
    t.after(() => proxy.close(0));
    for (const [target, status] of [
      ["example.com:443", 403],
      ["auth.openai.com.evil.example:443", 403],
      ["auth.openai.com:80", 403],
      ["169.254.169.254:80", 403],
      ["auth.openai.com:443/path", 400],
      ["user@auth.openai.com:443", 400],
      ["auth.openai.com:65536", 400],
    ] as const) {
      const socket = NodeNet.connect(port, "127.0.0.1");
      try {
        const received = readUntil(socket, "\r\n\r\n");
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        NodeAssert.match(await received, new RegExp(`^HTTP/1.1 ${status} `));
      } finally {
        socket.destroy();
      }
    }
  },
);

NodeTest.test(
  "reports upstream connection failure and remains available",
  { timeout: 5000 },
  async (t) => {
    const unused = NodeNet.createServer();
    const upstreamPort = await listen(unused);
    await new Promise<void>((resolve) => unused.close(() => resolve()));
    const proxy = createProxyServer(
      readConfig({
        T3_PROXY_ALLOWED_HOSTS: "127.0.0.1",
        T3_PROXY_ALLOWED_PORTS: String(upstreamPort),
      }),
    );
    const port = await listen(proxy.server);
    const socket = NodeNet.connect(port, "127.0.0.1");
    t.after(async () => {
      socket.destroy();
      await proxy.close(0);
    });
    const received = readUntil(socket, "\r\n\r\n");
    socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    NodeAssert.match(await received, /^HTTP\/1.1 502 /);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    NodeAssert.equal(health.status, 200);
    NodeAssert.equal((await fetch(`http://127.0.0.1:${port}/anything`)).status, 405);
  },
);

NodeTest.test(
  "shutdown closes established tunnels after its grace period",
  { timeout: 5000 },
  async () => {
    const upstream = NodeNet.createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    const proxy = createProxyServer(
      readConfig({
        T3_PROXY_ALLOWED_HOSTS: "127.0.0.1",
        T3_PROXY_ALLOWED_PORTS: String(upstreamPort),
      }),
    );
    const port = await listen(proxy.server);
    const socket = NodeNet.connect(port, "127.0.0.1");
    try {
      const connected = readUntil(socket, "\r\n\r\n");
      socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      await connected;
      const closed = NodeEvents.EventEmitter.once(socket, "close");
      await proxy.close(10);
      await closed;
      NodeAssert.equal(socket.destroyed, true);
    } finally {
      socket.destroy();
      await proxy.close(0);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

NodeTest.test(
  "delivers the entire streamed response before upstream EOF",
  { timeout: 5000 },
  async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, "x");
    const upstream = NodeNet.createServer((socket) =>
      socket.once("data", () => socket.end(payload)),
    );
    const upstreamPort = await listen(upstream);
    const proxy = createProxyServer(
      readConfig({
        T3_PROXY_ALLOWED_HOSTS: "127.0.0.1",
        T3_PROXY_ALLOWED_PORTS: String(upstreamPort),
      }),
    );
    const port = await listen(proxy.server);
    const socket = NodeNet.connect(port, "127.0.0.1");
    try {
      const connected = readUntil(socket, "\r\n\r\n");
      socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      await connected;
      const chunks: Buffer[] = [];
      socket.on("data", (data: Buffer) => chunks.push(data));
      const closed = NodeEvents.EventEmitter.once(socket, "close");
      socket.write("go");
      await closed;
      NodeAssert.deepEqual(Buffer.concat(chunks), payload);
    } finally {
      socket.destroy();
      await proxy.close(0);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

NodeTest.test("closes abandoned idle tunnels", { timeout: 5000 }, async () => {
  const upstream = NodeNet.createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(
    readConfig({
      T3_PROXY_ALLOWED_HOSTS: "127.0.0.1",
      T3_PROXY_ALLOWED_PORTS: String(upstreamPort),
      T3_PROXY_IDLE_TIMEOUT_MS: "30",
    }),
  );
  const port = await listen(proxy.server);
  const socket = NodeNet.connect(port, "127.0.0.1");
  try {
    const connected = readUntil(socket, "\r\n\r\n");
    socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    await connected;
    await NodeEvents.EventEmitter.once(socket, "close");
  } finally {
    socket.destroy();
    await proxy.close(0);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

NodeTest.test(
  "supports an HTTPS proxy listener with certificate verification",
  { timeout: 5000 },
  async (t) => {
    const upstream = NodeNet.createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    const certPath = NodeURL.fileURLToPath(new URL("./fixtures/test-cert.pem", import.meta.url));
    const keyPath = NodeURL.fileURLToPath(new URL("./fixtures/test-key.pem", import.meta.url));
    const proxy = createProxyServer(
      readConfig({
        T3_PROXY_ALLOWED_HOSTS: "127.0.0.1",
        T3_PROXY_ALLOWED_PORTS: String(upstreamPort),
        T3_PROXY_TLS_CERT: certPath,
        T3_PROXY_TLS_KEY: keyPath,
      }),
    );
    const port = await listen(proxy.server);
    t.after(async () => {
      await proxy.close(0);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const request = NodeHttps.request({
      hostname: "127.0.0.1",
      port,
      method: "CONNECT",
      path: `127.0.0.1:${upstreamPort}`,
      ca: NodeFS.readFileSync(certPath),
    });
    const connected = NodeEvents.EventEmitter.once(request, "connect");
    request.end();
    const [response, socket] = await connected;
    try {
      NodeAssert.equal(response.statusCode, 200);
      const echoed = readUntil(socket, "encrypted-hop");
      socket.write("encrypted-hop");
      NodeAssert.equal(await echoed, "encrypted-hop");
    } finally {
      socket.destroy();
    }
  },
);

NodeTest.test(
  "startup script serves health checks and exits cleanly on SIGTERM",
  { timeout: 5000 },
  async (t) => {
    const reserved = NodeNet.createServer();
    const port = await listen(reserved);
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const child = NodeChildProcess.spawn("./start.sh", [], {
      cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        NODE_BIN: process.execPath,
        T3_PROXY_HOST: "127.0.0.1",
        T3_PROXY_PORT: String(port),
        T3_PROXY_TLS_CERT: "",
        T3_PROXY_TLS_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = NodeEvents.EventEmitter.once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    const [output] = await NodeEvents.EventEmitter.once(child.stdout, "data");
    NodeAssert.match(String(output), /T3 proxy listening/);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    NodeAssert.equal(await health.text(), "ok\n");
    child.kill("SIGTERM");
    NodeAssert.deepEqual(await exited, [0, null]);
  },
);
