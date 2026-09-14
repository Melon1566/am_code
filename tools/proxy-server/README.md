# T3 provider proxy

A small HTTP CONNECT proxy for Codex and Claude Code. It forwards their HTTPS
connections, including OAuth token refresh and WebSocket streams, without
terminating the provider's TLS connection. Credentials stay with the CLI.

**Runtime dependency: Node.js 24.13 or newer.** No npm install, build step, Docker,
T3 server, or other JavaScript packages are needed. This folder can also be copied
by itself. Node runs the TypeScript source directly using its
[built-in TypeScript support](https://nodejs.org/api/typescript.html).

This is an HTTPS-destination proxy: its listener can use HTTP or HTTPS, but ordinary
HTTP destination requests are not forwarded. Codex and Claude's provider endpoints
use HTTPS. Browser sign-in pages still use the browser's connection.

## EC2 setup

1. Use a Linux instance with systemd, such as Ubuntu or Amazon Linux 2023. One
   small instance is a reasonable starting point; no GPU is needed.
2. Install Git, Make, and Node.js 24.13+ system-wide. Node must be accessible to root
   under `/usr` or `/opt`; a user-only nvm installation is not suitable for the
   service. Check `sudo node --version`. See the optional Node installation below.
3. Before exposing the listener, restrict inbound TCP **3128** in the EC2 security
   group to the public egress IP of your T3 environment (a `/32`), or an appropriate
   private-network source. Keep SSH restricted as well. The proxy has **no client
   authentication**; do not allow `0.0.0.0/0` or `::/0` inbound to its port. Allow
   outbound HTTPS and DNS. The destination allowlist is not client authentication.
4. Clone your fork containing this folder and install:

   ```sh
   git clone <your-repository-url> t3-code
   cd t3-code/tools/proxy-server
   make install LISTEN=0.0.0.0
   ```

The installer copies this folder's runtime files to `/opt/t3-proxy-server`, stores
configuration in `/etc/t3-proxy-server.env`, and starts the service. systemd runs it
as an unprivileged dynamic user, starts it after boot, and restarts it three seconds
after a failure. You can disconnect SSH. It does not run any other part of T3.

For a private tunnel or local-only listener, omit the address when installing:

```sh
make install
```

Run Make commands from `tools/proxy-server`, or use `make -C tools/proxy-server`
from the repository root. Running `make` alone lists the available commands.
Service commands invoke `sudo` as needed. When already root on a system without
sudo, use `make install SUDO=`. For foreground runs or tests with a custom Node
binary, use `NODE_BIN=/absolute/path/to/node` as a Make argument. Service installs
still require system-wide Node as described above.

Existing configuration is preserved on reinstall. Passing an address explicitly
changes the saved listen address; omitting it preserves the existing address.

## Connect T3

On the environment running the CLIs, open **Settings → Providers**, select the
Codex or Claude instance, and set **HTTP proxy URL** to:

```text
http://<reachable-ec2-address>:3128
```

Use a private address only if that environment has a route into the VPC. Otherwise
use the instance's reachable public address with the restricted security-group
rule above. A stable address or DNS name avoids having to update T3 after an EC2
address changes. Configure each pooled provider instance that should use the proxy.

The `http://` listener does not decrypt the inner HTTPS connection to the provider.
Destination hostnames are visible on this first hop. If you need the connection to
the proxy itself encrypted too, configure the optional HTTPS listener below.

Verify the listener and forwarding from the T3 environment:

```sh
curl --fail http://<reachable-ec2-address>:3128/healthz
curl --verbose --proxy http://<reachable-ec2-address>:3128 https://auth.openai.com/ -o /dev/null
```

The second command should show `200 Connection Established` and a successful TLS
handshake. OpenAI may then return a 403 or another HTTP response for that unauthenticated
page; that is distinct from a proxy rejection. Finish by trying Codex in T3. These
curl checks do not prove subscription login or token refresh succeeds.

## Operate and update

```sh
make status
make logs       # Ctrl-C stops following logs, not the proxy
make restart
make stop       # stop now; still enabled for the next boot
make start
make disable    # stop and disable startup at boot
make enable     # start and enable startup at boot
```

Edit `/etc/t3-proxy-server.env`, then restart to apply changes. The supported settings
and defaults are in [proxy.env.example](./proxy.env.example). Host allowlisting is
exact; add any additional provider destinations as comma-separated hostnames.
Only destination port 443 is allowed by default. Never add EC2 metadata endpoints
or untrusted domains to the allowlist.

To update, pull the repository and run `make update`. It updates the
runtime files and unit, preserves the environment file and systemd drop-ins, and
restarts the service. Existing tunnels are given up to ten seconds to finish, then
closed. Update between agent turns; interrupted requests may need a retry.

The service limits connections to 256 and memory to 256 MB. Idle tunnels close
after ten minutes with no traffic; connection attempts time out after ten seconds.
Streaming uses Node's backpressure instead of buffering complete responses.
It logs startup and listener failures, not requests, prompts, tokens, or responses.
Network failures affect their individual connections; process crashes are restarted
by [systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=).
Logs are managed by journald; use your host's normal retention settings.

## Optional HTTPS listener

Obtain a certificate for the proxy's DNS name from your usual certificate service.
Clients must trust its issuer. Do not disable TLS verification in the CLIs.

Use systemd credentials so the unprivileged service can read a root-owned private
key. Run `sudo systemctl edit t3-proxy-server` and add (using your actual paths):

```ini
[Service]
LoadCredential=proxy-cert:/etc/ssl/proxy/fullchain.pem
LoadCredential=proxy-key:/etc/ssl/proxy/privkey.pem
Environment=T3_PROXY_TLS_CERT=%d/proxy-cert
Environment=T3_PROXY_TLS_KEY=%d/proxy-key
```

Then run `make restart` and use
`https://<proxy-dns-name>:3128` in T3. Restart after certificate renewal so systemd
and Node load the new files. With HTTPS enabled, health checks also use HTTPS.
Certificate issuance and renewal are handled by your existing certificate tooling.

## Run in a terminal / test

```sh
make run                                   # localhost:3128
make run LISTEN=0.0.0.0                     # reachable listener
node --env-file=proxy.env.example server.ts # explicit configuration file
make test                                  # local sockets only, no provider calls
```

The PEM files under `fixtures/` are public test-only credentials, never deployment certificates.

The terminal command stays in the foreground; use the systemd installer for
unattended operation. Environment-file changes do not apply until restart.

## Optional: install a system-wide Node 24 binary

If your distribution does not provide Node 24+, these commands install the current
Node 24 Linux binary from nodejs.org. They require `curl`, `tar` with xz support,
and `sha256sum` (standard Linux utilities). They install into `/usr/local`; use
this on an instance where you want this system-wide Node installation.

```sh
(
set -eu
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo 'Unsupported architecture'; exit 1 ;;
esac
node_download_dir=$(mktemp -d)
cd "$node_download_dir"
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
node_archive=$(awk -v arch="$node_arch" '$2 ~ ("-linux-" arch "\\.tar\\.xz$") {print $2}' SHASUMS256.txt)
test -n "$node_archive"
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$node_archive"
sha256sum --check --ignore-missing SHASUMS256.txt
sudo tar -xJf "$node_archive" -C /usr/local --strip-components=1
sudo /usr/local/bin/node --version
)
```

Return to the cloned repository before running the installer. Keep Node updated
alongside normal host maintenance; this tool does not update your system packages.
