# DevSpace Cloudflare Control Hub

hub.coldhao.win is the coordination backend for ColdHao DevSpace/Eterna.
Local DevSpace remains the final execution authority.

Cloudflare is responsible for four things:

1. Context offload: bulky redacted ChatGPT, Codex and tool input/output goes to R2.
2. Permission coordination: assign cloud capabilities for context, tasks and notifications.
3. Scheduling: queue reference-based tasks and wake them with Durable Object alarms.
4. Notifications: persist notifications first, then push them over hibernatable WebSockets.

The normal model-facing payload is POST /v1/model-envelope. It returns a compact
ContextCapsule plus permission references, task references and unread notifications.
The model should resolve full ContextBlobRef content only when the active task needs it.

Cloud permission assignments never authorize local shell, process or filesystem
mutation by themselves. Local Owner, A2 and Candidate checks remain authoritative.

The existing devspace.coldhao.win MCP/tunnel endpoint is not replaced or managed
by this Worker.

Cloudflare resources:

- Worker: devspace-control-hub
- Custom Domain: hub.coldhao.win
- SQLite Durable Object class: ControlHub
- R2 bucket: devspace-control-hub-context

Secrets:

- DEVSPACE_NODE_TOKEN
- DEVSPACE_ADMIN_TOKEN

Node calls must also send x-devspace-node-id and x-devspace-client-id.
Secrets must not be committed, copied into model context, R2 data or logs.

Deployment commands:

    cd cloudflare/control-hub
    pnpm install
    pnpm run cf:check
    pnpm run cf:whoami
    pnpm exec wrangler r2 bucket create devspace-control-hub-context
    pnpm exec wrangler secret put DEVSPACE_NODE_TOKEN --config wrangler.jsonc
    pnpm exec wrangler secret put DEVSPACE_ADMIN_TOKEN --config wrangler.jsonc
    pnpm run cf:deploy

Wrangler is pinned in this package instead of downloaded through pnpm dlx on
every run. This keeps the deployment toolchain reproducible and avoids relying
on user-global pnpm dlx/cache state.

Notification limitation: Cloudflare cannot inject a message into a closed
ChatGPT conversation on its own. Immediate Chat delivery requires the local/host
relay to be connected. Otherwise notifications remain durable and replay after
reconnect.
