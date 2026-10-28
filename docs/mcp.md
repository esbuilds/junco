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

The desk also serves the same gated tools over HTTP at `/mcp`, behind the desk password: 15 tools listed (8 dispute and tracking tools, `create_refund`, `get_refund` and `get_order` through the Agent Toolkit, the 3 incident tools below and `junco_hold_status`). `create_refund` comes back held for the owner. An agent connected this way shares the desk's policy and holds, so anything it tries that needs approval shows up on the desk right away, marked "MCP client" in the activity log.

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

`/mcp/paypal` serves PayPal's own hosted MCP server (`mcp.sandbox.paypal.com`, 46 tools, over SSE) behind the same gate, with JUNCO's tools added: 28 tools listed (20 of PayPal's, JUNCO's 4 dispute write tools, the 3 incident tools below and `junco_hold_status`, which tells the hold card in Claude how a held call ended). Every hosted tool has a class in `policy.json`; the Policy page lists them.

## Tools added

| Tool | PayPal endpoint | Needs PayPal to allow | Checked before calling |
|---|---|---|---|
| `provide_dispute_evidence` | `POST /v1/customer/disputes/{id}/provide-evidence` | `provide_evidence` | fulfillment needs carrier and tracking; refund proof needs a refund ID |
| `make_dispute_offer` | `POST /v1/customer/disputes/{id}/make-offer` | `make_offer` | amount required unless replacement only |
| `send_dispute_message` | `POST /v1/customer/disputes/{id}/send-message` | `send_message` | 1 to 2000 characters |
| `provide_dispute_supporting_info` | `POST /v1/customer/disputes/{id}/provide-supporting-info` | `provide_supporting_info` | 1 to 2000 characters; used for cases already under PayPal review |

They use the toolkit's own tool shape (`method`, `name`, `description`, zod `parameters`, `actions`) and register on the toolkit's `PayPalAgentToolkit` MCP server, so nothing in PayPal's package is forked.

## Incident tools (BLACK BOX)

On both `/mcp` and `/mcp/paypal`, classed `read` in `policy.json`, so the gate passes them straight through. They read the desk's records and never call PayPal.

| Tool | Takes | Returns |
|---|---|---|
| `junco_list_incidents` | nothing | every AI purchase on record: buyer txn, title, dispute id, money-move counts |
| `junco_get_incident` | `id` (the buyer txn) | the incident: what the buyer allowed, the purchase, every event with its mode (live or recorded) and refs, the counts, and what the records don't have |
| `junco_what_if` | `event_id` (a `hold:` or `gate:` event) and exactly one of `max_amount` or `budget` | the recorded verdict, the verdict under today's policy with that one change, and `paypal_calls: 0` |

The same incident is on the desk at `/incident/<buyer txn>` (page), `/incident/<buyer txn>/receipt` (printable, with a QR code to the page) and `/api/incident/<buyer txn>` (JSON), with `/api/incidents` for the list and `POST /api/incident/<buyer txn>/what-if` (`event_id`, `max_amount`) for the page's what-if. All of them sit behind the desk password.

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
