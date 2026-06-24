#!/usr/bin/env bash
# Expose the provisioned Shopware server on a stable localhost port that the gh-aw sandbox can
# reach. The provision action currently starts Symfony on localhost:8000; keeping this as a proxy
# step avoids coupling the provision action to gh-aw sandbox details.
set -euo pipefail

TARGET_URL=${TARGET_URL:?TARGET_URL is required}
SANDBOX_APP_PORT=${SANDBOX_APP_PORT:-18080}

target_host=$(printf '%s' "$TARGET_URL" | sed -E 's#^https?://([^/:]+).*#\1#')
target_port=$(printf '%s' "$TARGET_URL" | sed -E 's#^https?://[^/:]+:([0-9]+).*#\1#')
if [ "$target_port" = "$TARGET_URL" ]; then
  target_port=80
fi
case "$target_host" in
  localhost|127.0.0.1) ;;
  *) echo "::error::refusing to proxy non-local Shopware target: $TARGET_URL"; exit 1 ;;
esac

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$SANDBOX_APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "::error::port $SANDBOX_APP_PORT is already in use"
  exit 1
fi

if command -v socat >/dev/null 2>&1; then
  nohup socat "TCP-LISTEN:${SANDBOX_APP_PORT},bind=0.0.0.0,reuseaddr,fork" "TCP:127.0.0.1:${target_port}" \
    >/tmp/repro-shopware-proxy.log 2>&1 &
else
  python3 - "$SANDBOX_APP_PORT" "$target_port" >/tmp/repro-shopware-proxy.log 2>&1 <<'PY' &
import socket
import socketserver
import sys
import threading

listen_port = int(sys.argv[1])
target_port = int(sys.argv[2])

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.create_connection(('127.0.0.1', target_port), timeout=10)
        sockets = (self.request, upstream)

        def pump(source, target):
            try:
                while True:
                    chunk = source.recv(65536)
                    if not chunk:
                        break
                    target.sendall(chunk)
            finally:
                for sock in sockets:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    try:
                        sock.close()
                    except OSError:
                        pass

        threading.Thread(target=pump, args=(self.request, upstream), daemon=True).start()
        pump(upstream, self.request)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

with Server(('0.0.0.0', listen_port), Handler) as server:
    server.serve_forever()
PY
fi
proxy_pid=$!
echo "$proxy_pid" > /tmp/repro-shopware-proxy.pid

host_app_url="http://127.0.0.1:${SANDBOX_APP_PORT}"
agent_app_url="http://host.docker.internal:${SANDBOX_APP_PORT}"
ready=0
for i in $(seq 1 30); do
  code=000
  if ! code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$host_app_url/admin"); then
    code=000
  fi
  if [ "$code" != "000" ]; then
    echo "sandbox proxy responding (HTTP $code) after ${i}s: $agent_app_url -> $TARGET_URL"
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" != 1 ]; then
  echo "::error::Shopware sandbox proxy did not become ready"
  cat /tmp/repro-shopware-proxy.log 2>/dev/null || true
  exit 1
fi

{
  echo "APP_URL=$agent_app_url"
  echo "REPRO_HOST_APP_URL=$host_app_url"
  echo "REPRO_SHOPWARE_PROXY_PID=$proxy_pid"
} >> "$GITHUB_ENV"
