#!/usr/bin/env bash
# Expose the provisioned Shopware server (localhost:8000) on a stable port the gh-aw sandbox can
# reach (host.docker.internal:18080), via a tiny HTTP proxy that rewrites the Host header. Then
# register the proxy URLs as sales-channel domains so the Storefront resolves through them.
#
# Env: TARGET_URL (req, the local shop), SANDBOX_APP_PORT (default 18080), SHOP_DIR (default shop).
# Exports APP_URL (agent-visible), REPRO_HOST_APP_URL (runner-visible), REPRO_SHOPWARE_PROXY_PID.
set -euo pipefail

TARGET_URL=${TARGET_URL:?TARGET_URL is required}
PORT=${SANDBOX_APP_PORT:-18080}
SHOP_DIR=${SHOP_DIR:-shop}

target_host=$(printf '%s' "$TARGET_URL" | sed -E 's#^https?://([^/:]+).*#\1#')
target_port=$(printf '%s' "$TARGET_URL" | sed -E 's#^https?://[^/:]+:([0-9]+).*#\1#')
[ "$target_port" = "$TARGET_URL" ] && target_port=80
case "$target_host" in localhost|127.0.0.1) ;; *) echo "::error::refusing to proxy non-local target: $TARGET_URL"; exit 1 ;; esac
if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "::error::port $PORT already in use"; exit 1; fi

python3 - "$PORT" "$target_port" "${target_host}:${target_port}" >/tmp/repro-shop-proxy.log 2>&1 <<'PY' &
import socket, socketserver, sys, threading
listen_port, target_port, upstream_host = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]

def rewrite_host(chunk):
    if b'\r\n\r\n' not in chunk:
        return chunk
    header, body = chunk.split(b'\r\n\r\n', 1)
    lines, saw_host, saw_conn = [], False, False
    for line in header.split(b'\r\n'):
        low = line.lower()
        if low.startswith(b'host:'):
            lines.append(f'Host: {upstream_host}'.encode()); saw_host = True
        elif low.startswith(b'connection:'):
            lines.append(b'Connection: close'); saw_conn = True
        else:
            lines.append(line)
    if not saw_host: lines.insert(1, f'Host: {upstream_host}'.encode())
    if not saw_conn: lines.append(b'Connection: close')
    return b'\r\n'.join(lines) + b'\r\n\r\n' + body

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.create_connection(('127.0.0.1', target_port), timeout=10)
        socks = (self.request, upstream)
        def pump(src, dst):
            try:
                while (data := src.recv(65536)):
                    dst.sendall(data)
            finally:
                for s in socks:
                    try: s.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    try: s.close()
                    except OSError: pass
        first = b''
        while b'\r\n\r\n' not in first and len(first) < 65536:
            data = self.request.recv(65536)
            if not data: break
            first += data
        if first: upstream.sendall(rewrite_host(first))
        threading.Thread(target=pump, args=(self.request, upstream), daemon=True).start()
        pump(upstream, self.request)

class Server(socketserver.ThreadingTCPServer): allow_reuse_address = True
with Server(('0.0.0.0', listen_port), Handler) as server:
    server.serve_forever()
PY
proxy_pid=$!
echo "$proxy_pid" > /tmp/repro-shop-proxy.pid

host_url="http://127.0.0.1:${PORT}"
agent_url="http://host.docker.internal:${PORT}"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$host_url/admin" || echo 000)
  [ "$code" != "000" ] && { echo "proxy responding (HTTP $code) after ${i}s: $agent_url -> $TARGET_URL"; ready=1; break; }
  sleep 1
done
[ "${ready:-0}" = 1 ] || { echo "::error::sandbox proxy did not become ready"; cat /tmp/repro-shop-proxy.log 2>/dev/null || true; exit 1; }

ADMIN_API_URL="$host_url" STOREFRONT_DOMAIN_URLS="${host_url},${agent_url}" node "$(dirname "$0")/align-domains.mjs"
[ -x "$SHOP_DIR/bin/console" ] && ( cd "$SHOP_DIR" && APP_ENV=prod php bin/console cache:clear --no-warmup --no-interaction )

{ echo "APP_URL=$agent_url"; echo "REPRO_HOST_APP_URL=$host_url"; echo "REPRO_SHOPWARE_PROXY_PID=$proxy_pid"; } >> "$GITHUB_ENV"
