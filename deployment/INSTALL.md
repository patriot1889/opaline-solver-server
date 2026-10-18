# Install Opaline Solver with Nginx Proxy Manager on another host

This package runs the solver on one Docker host and uses your existing Nginx
Proxy Manager (NPM) on a different host for the domain and HTTPS certificate.
There is no Caddy service and no shared Docker network requirement.

Connection path:

```text
Opaline → HTTPS → NPM host → private HTTP port 8080 → solver host
```

## 1. Prepare the hosts and networking

The solver host needs Linux amd64 or arm64, about 2 GB available RAM, two CPU
cores, Docker Engine, and the Docker Compose plugin. Node.js is built into the
image; it does not need to be installed on the host.

Check Docker on the solver host:

```sh
docker --version
docker compose version
```

Commands assume your SSH user can run Docker; use `sudo docker` if required.
Docker installation: https://docs.docker.com/engine/install/

Choose a fixed private LAN IPv4 address on the solver host, for example
`192.168.1.50`. Reserve it in DHCP or configure a static address. NPM must be
able to reach it from its own container. If the hosts are on different networks,
connect them with a routed VPN and use the solver host's VPN address instead.
The address must be assigned to the solver host before starting the container.

The NPM-to-solver connection uses HTTP and includes the secret path. Use a
trusted private LAN or encrypted VPN; do not send it across the public internet.
Do not forward public port 8080 to the solver. Restrict private port 8080 to the
NPM host using your router/network firewall or Docker-aware host firewall rules.
Docker published ports may bypass ordinary UFW rules, so do not rely on UFW
alone to restrict the published port. The bind address limits which local
interface listens; it does not itself restrict which clients may connect.

Keep public TCP 80/443 directed to your existing NPM host. Point a subdomain,
such as `solver.yourdomain.com`, at NPM's public IP, not at the solver's private
address. Only publish an IPv6 record if IPv6 actually reaches NPM.

The solver needs outbound HTTPS and DNS to download its image/dependencies and
connect to YouTube and Google.

## 2. Transfer and extract

From your local computer, in the folder containing the archive, replace the SSH
user and address below with those of the **solver host**:

```sh
scp opaline-solver-npm.tar.gz YOUR_USER@YOUR_SOLVER_SERVER:~/
ssh YOUR_USER@YOUR_SOLVER_SERVER
cd ~
tar -xzf opaline-solver-npm.tar.gz
cd opaline-solver-npm
sha256sum -c SHA256SUMS
```

All checksums should report `OK`. Start in a fresh directory for a new install.
The archive includes this guide as `INSTALL.md`.

## 3. Configure the solver

On the solver host, from the extracted directory:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
nano .env
```

Copy the OpenSSL output into `SOLVER_SECRET`. Set `SOLVER_BIND_IP` to the solver
host's actual LAN or VPN IPv4 address. Example:

```dotenv
SOLVER_BIND_IP=192.168.1.50
SOLVER_SECRET=PASTE_THE_64_CHARACTER_RANDOM_HEX_VALUE_HERE
GENERATE_IT_ENDPOINT=google
```

Do not use the placeholder secret, the NPM host's address, `127.0.0.1`, or a
Docker container IP. No domain setting is needed here; configure it in NPM.

## 4. Build and start

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail=50 solver
```

This publishes port 8080 on the private address specified in `.env`. The first
build downloads dependencies. Allow time for the initial health check and
YouTube warmup. The container restarts after reboots if Docker starts on boot.

Check readiness internally:

```sh
docker compose exec solver node -e "fetch('http://localhost:8080/health/ready').then(async r=>console.log(r.status,await r.json()))"
```

A `200` with `ready: true` means the TV solve and mint probes succeeded. A `503`
means a capability is not ready; inspect the logs. `playbackVerified: false` is
expected because only app testing can verify actual playback.

From the **NPM host**, check connectivity, replacing the example private IP:

```sh
curl --connect-timeout 5 http://192.168.1.50:8080/health/live
```

Expect `{"live":true}`. If this fails, fix private routing/firewall access first.
If NPM later reports 502 despite this check succeeding, check connectivity from
NPM's container network as well; host and container routing may differ.

## 5. Configure the Proxy Host in NPM

Choose **Hosts → Proxy Hosts → Add Proxy Host**:

| Setting | Value |
| --- | --- |
| Domain Names | `solver.yourdomain.com`, replaced with your chosen domain |
| Scheme | `http` |
| Forward Hostname / IP | Solver host's private LAN/VPN IP, e.g. `192.168.1.50` |
| Forward Port | `8080` |
| Cache Assets | Off |
| Websockets Support | Off; not required |
| Access List | Publicly Accessible; the solver authenticates using its secret path |

Use the same address as `SOLVER_BIND_IP`. Do not use `opaline-solver`,
`localhost`, or a container IP: the solver is on another Docker host.
Do not configure a path rewrite that removes the secret.

In **SSL**, select a certificate covering this subdomain or request a Let's
Encrypt certificate. Enable **Force SSL** and save. For HTTP certificate
validation, public DNS and TCP 80 must reach NPM. If you already use DNS
validation, follow your existing workflow.

In **Advanced**, add:

```nginx
access_log off;

location = /health/live {
    return 404;
}

location = /health/ready {
    return 404;
}
```

Save and check the proxy host remains online. These health routes are available
on the private upstream but blocked on the public domain. The secret is part of
request paths, so avoid access/request logging. NPM error logs can also contain
paths; keep its logs and backups private. Prior logs may contain earlier URLs.

NPM reference: https://github.com/NginxProxyManager/nginx-proxy-manager

## 6. Connect Opaline

In **Opaline → Settings → Debug → Solver Server**, save:

```text
https://solver.yourdomain.com/YOUR_ACTUAL_SOLVER_SECRET
```

Use the exact secret from `.env`. Do not append `/solve`, `/sts`, or `/get_pot`.
Keep this URL private, including screenshots and exported app logs.

Opening the domain root in a browser returns **404**, which is expected. Test
actual playback beyond one minute, seeking, and available dubbed audio/kids
content. Repeat on your intended device/network. A minted token alone does not
prove YouTube will accept it for playback.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cannot assign requested address | `SOLVER_BIND_IP` must be an IPv4 address assigned to the solver host. |
| Port 8080 already in use | Another service/deployment is using that address and port. |
| NPM host cannot reach health endpoint | Correct private IP, solver running, routes/VPN, and firewall rules. |
| NPM shows 502 | Upstream must be HTTP to the solver host's private address on 8080; also check NPM container routing. |
| Certificate failure | DNS, IPv6 records, inbound ports to NPM, certificate logs. |
| Browser shows 404 | Expected for domain root and GET requests. |
| App requests return 404 | Exact secret/base URL, no extra endpoint suffix or proxy path rewrite. |
| Readiness returns 503 | Solver logs, upstream compatibility, outbound HTTPS/DNS, and host resources. |

If you previously deployed the original Caddy-based package, stop its Caddy
service with `docker compose stop caddy` from that old deployment directory.
Stop the old solver deployment before starting a replacement. Keep your
existing NPM running.

## Maintenance

Run from the solver deployment directory:

```sh
docker compose logs --tail=100 solver
docker compose restart solver
```

To stop and remove this solver container:

```sh
docker compose down
```

This does not affect NPM on the other host. The solver has no persistent database;
restarts clear its caches.

For updates, retain the previous package and your private `.env`. Replace the
application files with the new package, preserve `.env`, then run
`docker compose up --build -d`. Retain this NPM-specific Compose configuration
if updating from a general source distribution. Repeat readiness/playback checks.

To rotate the secret, generate another with `openssl rand -hex 32`, edit `.env`,
and recreate the solver:

```sh
docker compose up -d --force-recreate solver
```

Update every device's URL. The old URL stops working after recreation. To use
the app's built-in solver again, choose **Reset to default** in its solver setting.

## Included files

Dockerfile, NPM-specific `compose.yaml`, `.env.example`, TypeScript source and
configuration, dependency manifests/lockfile, vendored solver code/license
notices, this guide, and checksums. Local secrets, node_modules, build output,
test fixtures, and Caddy are excluded. The image is built on the server.
