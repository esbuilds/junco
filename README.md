# JUNCO

Small online sellers lose PayPal disputes they could have won. Pulling the order, the tracking and the messages together takes an evening, the 10-day response window slips by, and refunding starts to feel easier. A case that escalates can also cost a $15 dispute fee, which PayPal waives when it's settled early.

JUNCO reads each dispute, pulls the evidence PayPal already has, and recommends one action: message the buyer, offer a partial refund, contest with evidence, or accept. Every claim it makes cites a piece of evidence, and plain code checks those citations before anything happens. Actions that move money wait for the owner.

It is built as an extension to [PayPal's Agent Toolkit](https://github.com/paypal/agent-toolkit). The stock toolkit can list disputes and concede them, but it cannot contest one. JUNCO adds the missing tools, so any MCP-capable agent gets them, and ships a dispute desk for the merchant.

**Hosted demo:** the URL and password are on the Devpost submission page.

## How it works

```
 PayPal sandbox                         JUNCO
 ┌──────────────┐   dispute, order,    ┌──────────────────────────┐
 │ Disputes API │   tracking, messages │ recommend.ts             │
 │ Orders API   │ ───────────────────► │  numbered evidence E1..En │
 │ Payments API │                      │  Claude Opus 5.5 decides  │
 └──────▲───────┘                      │  validator checks it      │
        │                              └────────────┬─────────────┘
        │                                           │ one action
        │                              ┌────────────▼─────────────┐
        │   only if allowed            │ gate.ts + policy.json    │
        └───────────────────────────── │  allow / hold / deny     │
                                       │  every MCP tool call     │
                                       └────────────▲─────────────┘
                                                    │
                          AI agents (MCP)  ─────────┤
                          Dispute desk (web) ───────┘
```

1. **Evidence.** `recommend.ts` follows the dispute to its capture and order and collects the reason, amount, deadline, messages, evidence already on file, offer history, items, ship-to address, tracking and seller-protection status. Each item gets an ID (E1, E2, ...).
2. **Recommendation.** Claude Opus 5.5 returns a structured decision (`message`, `offer`, `contest` or `accept`), a short summary, claims that each cite evidence IDs, and a draft message to the buyer. It is told which actions PayPal currently allows on the case.
3. **Checks.** `validate()` rejects the recommendation if a claim cites evidence that does not exist or cites nothing, if PayPal does not currently allow the action, if an offer is zero or larger than the disputed amount, or if a message is empty. A blocked recommendation cannot be carried out from the desk.
4. **Gate.** Every tool call on the MCP server, including PayPal's stock tools, goes through `policy.json`. The default policy lets messages and evidence through, allows offers up to $25, and holds larger offers, refunds and concessions for the owner.
5. **Action.** The new tools check PayPal's HATEOAS links before calling the API, so they only run when PayPal says the action is available.

## Quick start

Requires Node 22+, a [PayPal developer](https://developer.paypal.com) sandbox app, and an Anthropic API key.

```bash
git clone https://github.com/esbuilds/junco && cd junco
npm install
cat > .env <<'EOF'
PAYPAL_CLIENT_ID=your-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-sandbox-secret
ANTHROPIC_API_KEY=sk-ant-...
EOF
npm run desk          # http://localhost:3000
```

Set `DESK_PASSWORD` to require a password (any username). The desk refuses to start on Render without one.

### Create a dispute to work on

PayPal's buyer-side dispute API needs permissions a normal sandbox app does not have, so the buyer step happens in the sandbox website.

```bash
npm run seed                                   # creates an order, prints the buyer approval link
npm run seed capture <order_id>                # shipped: captures and adds USPS tracking
npm run seed capture <order_id> --no-tracking  # never shipped: the honest answer is to refund
```

Then log in to sandbox.paypal.com as the buyer, open the payment, choose **Report a problem**, then **I didn't receive my item**. PayPal unlocks merchant actions about 4 minutes later.

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

Held calls return `{"held": true, "hold_id": "...", "reason": "..."}` to the agent. The owner approves or rejects them in the desk or with `npm run holds [approve|reject <id>]`.

## Tools added

| Tool | PayPal endpoint | Needs PayPal to allow | Checked before calling |
|---|---|---|---|
| `provide_dispute_evidence` | `POST /v1/customer/disputes/{id}/provide-evidence` | `provide_evidence` | fulfillment needs carrier and tracking; refund proof needs a refund ID |
| `make_dispute_offer` | `POST /v1/customer/disputes/{id}/make-offer` | `make_offer` | amount required unless replacement only |
| `send_dispute_message` | `POST /v1/customer/disputes/{id}/send-message` | `send_message` | 1 to 2000 characters |

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

A rule is `"allow"`, `"hold"`, `"deny"`, or `{ "max_amount": n, "over": verdict }`. Tools not listed get `default`. A tool with an amount limit but no readable amount is held.

## Checks

```bash
npm run typecheck
npm run check        # tools through the MCP server against the sandbox (add -- --write to send a real message)
npm run check-gate   # policy decisions, holds, approve and reject
npm run check-ai     # validator cases offline, then one real Claude call
```

## Security notes

- Sandbox only. The PayPal base URL is fixed to `api-m.sandbox.paypal.com`.
- The gate wraps every registered tool, so an agent cannot reach a stock money-moving tool around it. Unknown tools are held.
- Approving a hold marks it before running it, so a crash cannot run it twice. A rejected hold cannot be approved later.
- Buyer and merchant messages are passed to Claude as evidence and the prompt tells it to treat them as data. The desk escapes all text it displays.
- Credentials come from environment variables. `.env` is git-ignored.
- The hosted desk uses HTTP basic auth over HTTPS. It is a demo control, not multi-user auth.

## Known limits

- Holds and cached recommendations are JSON files in `.junco/`. Fine for one process; use a database for more.
- PayPal's tracker only stores "shipped". Carrier delivery scans are entered by the merchant, and Claude is told they are merchant-supplied.
- Transaction Search and the v1 trackers API return 403 without extra app permissions, so evidence comes from the Orders and Payments APIs.
- The toolkit's MCP server takes a fixed access token, so long-running processes exit 10 minutes before the ~9 hour token expires and the host restarts them.
- PayPal Agent Toolkit 1.11.0 validates `accept_dispute_claim`'s `note` with the dispute-ID pattern, so any note with a space is rejected. JUNCO works around it with a one-word note.

## Built with

- **PayPal:** Agent Toolkit (MCP server and stock tools), Disputes API, Orders API, Payments API, sandbox.
- **Anthropic:** Claude Opus 5.5 through the Anthropic TypeScript SDK, with structured output.
- **Model Context Protocol** TypeScript SDK.
- **AG Grid** Community for the dispute queue.
- **Render** for hosting the desk.

## License

MIT, see [LICENSE](LICENSE).
