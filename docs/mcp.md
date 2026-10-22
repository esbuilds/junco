# Using JUNCO from an AI agent (MCP)

Every way to connect, the tools JUNCO adds, and the policy file. Back to the [README](../README.md).

## As a Claude connector (no config file)

In claude.ai, Settings, Connectors, Add custom connector, enter `https://junco-desk.onrender.com/mcp/paypal` (or `/mcp` for the desk's own server with PayPal's stock toolkit). Claude registers itself, the desk shows a sign-in page, and you sign in as `judge` with the desk password from the Devpost testing instructions. The connector then shows up in Claude on a phone too. Tested Oct 21 2026 from claude.ai on the web and on a phone: the tools listed, `list_disputes` ran, and `create_refund` came back held, marked "Claude connector" on the desk. `npm run check-connector` runs the same sign-in against any desk.

## Use it from an AI agent (MCP)

`src/server.ts` starts one MCP server with PayPal's stock dispute tools plus JUNCO's, all behind the gate. For Claude Desktop or any MCP client:

```json
{
  "mcpServers": {
    "junco": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/junco/src/server.ts"],
      "env": { "PAYPAL_CLIENT_ID": "...", "PAYPAL_CLIENT_SECRET": "..." }
    }
  }
}
```

### Connect to a running desk

The desk also serves the same gated tools over HTTP at `/mcp`, behind the desk password. An agent connected this way shares the desk's policy and holds, so anything it tries that needs approval shows up on the desk right away, marked "MCP client" in the activity log.

Claude Code:

```bash
claude mcp add --transport http junco https://YOUR-DESK.onrender.com/mcp \
  --header "Authorization: Basic $(printf 'junco:YOUR_DESK_PASSWORD' | base64)"
```

Claude Desktop (through `mcp-remote`):

```json
{
  "mcpServers": {
    "junco": {
      "command": "npx",
      "args": ["mcp-remote", "https://YOUR-DESK.onrender.com/mcp", "--header", "Authorization:${JUNCO_AUTH}"],
      "env": { "JUNCO_AUTH": "Basic <base64 of junco:YOUR_DESK_PASSWORD>" }
    }
  }
}
```

Held calls return `{"held": true, "hold_id": "...", "reason": "..."}` to the agent. The owner approves or rejects them in the desk or with `npm run holds [approve|reject <id>]`.

`/mcp/paypal` serves PayPal's own hosted MCP server (`mcp.sandbox.paypal.com`, 46 tools, over SSE) behind the same gate, with JUNCO's dispute tools added: 24 tools listed (20 of PayPal's, 4 of JUNCO's). Every hosted tool has a class in `policy.json`; the Policy page lists them.

## Tools added

| Tool | PayPal endpoint | Needs PayPal to allow | Checked before calling |
|---|---|---|---|
| `provide_dispute_evidence` | `POST /v1/customer/disputes/{id}/provide-evidence` | `provide_evidence` | fulfillment needs carrier and tracking; refund proof needs a refund ID |
| `make_dispute_offer` | `POST /v1/customer/disputes/{id}/make-offer` | `make_offer` | amount required unless replacement only |
| `send_dispute_message` | `POST /v1/customer/disputes/{id}/send-message` | `send_message` | 1 to 2000 characters |
| `provide_dispute_supporting_info` | `POST /v1/customer/disputes/{id}/provide-supporting-info` | `provide_supporting_info` | 1 to 2000 characters; used for cases already under PayPal review |

They use the toolkit's own tool shape (`method`, `name`, `description`, zod `parameters`, `actions`) and register on the toolkit's `PayPalAgentToolkit` MCP server, so nothing in PayPal's package is forked.

## Policy file

```json
{
  "default": "hold",
  "tools": {
    "send_dispute_message": "allow",
    "make_dispute_offer": { "max_amount": 25, "over": "hold" },
    "accept_dispute_claim": "hold",
    "create_refund": "hold"
  }
}
```

A rule is `"read"`, `"allow"`, `"hold"`, `"deny"`, `"hidden"` (not listed, denied if called), or `{ "max_amount": n, "over": verdict }`. Tools not listed get `default`, which is `"deny"` in the shipped policy. A tool with an amount limit but no readable amount is held.
