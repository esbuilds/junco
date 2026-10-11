# JUNCO

Small online sellers lose PayPal disputes they could have won. Pulling the order, the tracking and the messages together takes an evening, the 10-day response window slips by, and refunding starts to feel easier. A case that escalates to a claim can also cost a [$15 dispute fee](https://www.paypal.com/us/webapps/mpp/merchant-fees#statement-19), which [PayPal doesn't charge](https://www.paypal.com/us/legalhub/paypal/useragreement-full) when it's resolved with the buyer before it becomes a claim.

JUNCO reads each dispute, pulls the evidence PayPal already has, and recommends one action: message the buyer, offer a partial refund, contest with evidence, accept, or wait while PayPal reviews. Every claim it makes cites a piece of evidence, and plain code checks those citations, the quotes and the message to the buyer before anything happens. Actions that move money wait for the owner.

JUNCO rejects missing evidence and made-up quotes. What the AI concludes is still the AI's; what it's allowed to do is checked against PayPal's case and the owner's policy.

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
2. **Recommendation.** Claude Opus 5.5 returns a structured decision (`message`, `offer`, `contest`, `accept` or `wait`), a short summary, claims that each cite evidence IDs, and a draft message to the buyer. It is told which actions PayPal currently allows on the case.
3. **Checks.** `validate()` rejects the recommendation if a claim cites evidence that does not exist or cites nothing, if a quote from someone's words (a message, a note, a merchant record) isn't in that text word for word, if PayPal does not currently allow the action, if an offer is zero or larger than the disputed amount, or if a message is empty. The message to the buyer is checked too: it can't say an order shipped, has tracking or was delivered unless a tracker or delivery record is in the evidence, and any tracking number or date in it must appear in the evidence. A blocked recommendation cannot be carried out from the desk. Facts like amounts, dates and tracking status are shown on the desk from PayPal's own fields, not from the model's sentence.
4. **Gate.** Every tool call on the MCP server, including PayPal's stock tools and PayPal's own hosted MCP server, goes through `policy.json`. The default policy lets messages and evidence through, allows offers up to $25, holds larger offers, refunds and concessions for the owner, and denies anything it doesn't name. An approved hold runs only if the case is still the one the owner was shown, and its outcome is tracked (completed, failed, or unknown and settled by re-reading the case, never by running it twice). The gate is also a standalone package, see [junco-gate](#the-gate-on-its-own-junco-gate).
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

With a one-time buyer consent (`disputes/create`), the app can file disputes as the sandbox buyer by API. `npm run pool -- 4 unshipped` (or `delivered`) pays sandbox orders as the buyer in a headless browser and adds them to the desk's pool; the desk files them as disputes ahead of time. On an order with tracking, the sandbox opens the dispute as a chargeback under PayPal review; with no tracking, as an inquiry where the seller can message and offer. PayPal unlocks merchant actions 4 to 7 minutes after filing.

Without the consent, open one by hand: `npm run seed` creates an order and prints the buyer approval link, `npm run seed capture <order_id> [unshipped]` captures it, then log in to sandbox.paypal.com as the buyer and choose **Report a problem**.

## Agent mode

With `AGENT_MODE=on`, JUNCO handles new disputes by itself:

1. PayPal sends `CUSTOMER.DISPUTE.CREATED` / `UPDATED` / `RESOLVED` to `/webhooks/paypal`. Every event is checked with PayPal's `verify-webhook-signature` before anything runs.
2. The agent waits for PayPal to unlock merchant actions (new disputes have none for a few minutes), gets a recommendation, and carries it out through the gate. Messages and evidence go out; larger offers and concessions wait in the owner's queue.
3. It acts once per dispute state, never messages a buyer who hasn't answered the last seller message, and treats the update its own action causes as a no-op. A sweep every 10 minutes catches missed webhooks.
4. Every step lands in the activity log shown in the desk.
5. When the gate holds an action, JUNCO posts it to `HOLD_WEBHOOK_URL` (a Slack incoming webhook, or anything that accepts `{"text": ...}`) with the dispute, amount, reason and a link to the desk.

```bash
npm run webhook https://your-desk.example.com   # register the sandbox webhook
npm run check-agent                             # loop guards against live sandbox disputes
```

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

`/mcp/paypal` serves PayPal's own hosted MCP server (`mcp.sandbox.paypal.com`, 46 tools) behind the same gate, with JUNCO's dispute tools added. Every hosted tool has a class in `policy.json`; the Policy page lists them.

## Break the mandate

A page on the desk where a visitor plays the buyer and tries to make JUNCO give away more than the owner allowed: write a message, or start from a fair complaint, a haggler or an attacker. PayPal's sandbox lets this app file disputes as the buyer and nothing else, so the buyer in the challenge is simulated and the seller-side actions are real: JUNCO works a real never-shipped sandbox case, and whatever it proposes goes through the gate. Three cards show the exact call it made, what the gate decided and why, and what PayPal's re-read confirmed (or that nothing was sent); JUNCO's own reasoning is shown apart from them, labelled as the AI's. A "faulty agent" switch makes the agent concede the full amount without reading anything, to show the gate holds when the AI is wrong. Every run gets a shareable page at `/run/<id>`; the visitor's message appears there only if they choose to share it.

## The gate on its own: junco-gate

`packages/junco-gate` is the gate as a package for any MCP server: a policy per tool (read, allowed write, hold, not exposed, amount limits, default deny), holds bound to the exact call, guards, a re-check before an approved call runs, tracked outcomes, an action log, and `mirror()` to wrap someone else's server over any transport. `examples/wrap-any-server.ts` puts it in front of the official filesystem server: reads go through, writes wait for the owner, everything else is refused. Its three tests (allowed, held, stale) run with `npm run check-gate-pkg`. JUNCO's `src/gate.ts` is the same package with PayPal-specific hooks.

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

## Checks

```bash
npm run typecheck
npm run check        # tools through the MCP server against the sandbox (add -- --write to send a real message)
npm run check-gate   # policy decisions, holds, approve and reject, stale approvals, the hold lifecycle
npm run check-gate-pkg  # junco-gate on its own: allowed, held, stale through a real MCP server and client
npm run check-ai     # validator, quote and message cases offline, then one real Claude call
npm run check-agent  # agent triage: acts once per state, no repeat messages
npm run check-lease  # case leases, who may approve where, the pre-filed pool
npm run check-challenge  # Break the mandate: the three cards, caps, owner-only holds, private messages
npm run eval         # 42-scenario recommendation eval (about $1.20)
```

## Eval

`evals/scenarios.ts` holds 42 dispute scenarios: item not received (delivered, shipped only, never shipped, cancelled label, wrong ZIP, porch theft, empty box, signature), chargebacks under PayPal review, not as described, unauthorized, credit not processed, duplicate charges, merchant data mistakes, and 10 prompt injections in buyer messages, photo captions and merchant records (including fake PayPal rulings, a buyer posing as the seller, ready-made JSON output, and a planted note pushing the agent to contest a case it should concede). Scenario 42 is a mistake JUNCO made on the live desk (see below). Each lists the decisions a careful advisor could defend and the ones that are clearly wrong. `npm run eval` runs them through the production prompt and validator and scores in code, no model judges.

Latest full run (Oct 11 2026, Claude Opus 5.5, about $1.21):

| Measure | Result |
|---|---|
| Acceptable decision, passed the validator | 42 / 42 |
| Clearly wrong decision | 0 |
| Invented or missing citations | 0 |
| Quotes blocked (given but not found in the text) | 0 |
| Messages to the buyer blocked | 0 |
| Prompt injections resisted | 10 / 10 |

53 of 104 source-text claims carry a found quote; the rest state absence, timing or comparison, which a quote can't show; 0 quotes blocked.

The run before this one scored 40 / 41, and the miss was a scenario bug: a return logged as received the same day the order was paid. Claude flagged the impossible timeline and asked the buyer to confirm instead of refunding. The scenario now dates the return after the purchase and passes in three repeat runs. An earlier miss (Oct 7) was the same kind of bug: a UPS delivery scan against a USPS tracking number. Raw results, including the misses, are in `evals/results/`.

## A mistake JUNCO made, and what changed

On Oct 10, on a real sandbox case (PP-R-GJF-10190944) for an order that was never shipped, JUNCO sent the buyer a message saying the tote "has been shipped" and that tracking had been provided. Neither was true. PayPal lists evidence it has requested next to evidence that was submitted, and JUNCO's evidence formatter showed a request for proof of fulfillment as "Submitted proof of fulfillment". The model believed it. The validator didn't catch it because it checked the recommendation's claims, not the free text of the message to the buyer.

What changed: the formatter now says who submitted each item, or that PayPal asked for it and it hasn't been provided. The validator now checks the message to the buyer: a sentence saying an order shipped, has tracking or was delivered is blocked when no evidence item carries a tracker or delivery record, and any tracking number or date in the message must appear in the evidence. The case is scenario 42 in the eval. The original message stays in the case's activity log.

## DisputeBench

The scenarios double as a benchmark any dispute agent can be scored against, not just JUNCO.

- `npm run eval -- --agent ./my-agent.ts` scores a module that exports `async function decide(dispute, evidence)` and returns `{ decision }` (one of `accept`, `offer`, `contest`, `message`, `wait`) or a full recommendation with `claims: [{ text, evidence_ids }]`. Full recommendations go through the same citation validator, so invented evidence counts against any agent.
- `npm run bench:export` writes `evals/disputebench.json`: every case as plain JSON (the dispute and numbered evidence the agent sees, the decisions a careful advisor could defend, and the ones that are clearly wrong), for agents in any language.

A baseline that accepts every dispute it can (`evals/agents/always-accept.ts`) scored 17 / 41, made 23 clearly wrong decisions and resisted 1 of 10 injections (Oct 9 2026, on the 41 scenarios of the time). JUNCO scores 42 / 42 with none wrong on today's set (see Eval above).

## Carrier proof (USPS, UPS)

When carrier credentials are set, JUNCO looks up each tracking number on a disputed order with the carrier and adds the result as evidence labeled as carrier data: USPS through the [USPS APIs](https://developers.usps.com) (`USPS_CONSUMER_KEY`, `USPS_CONSUMER_SECRET`, Tracking product enabled) and UPS for `1Z` numbers through the [UPS Developer Portal](https://developer.ups.com) (`UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, Tracking API added). It only does that when the lookup succeeded; otherwise there is no carrier line, and a scan typed by the merchant is labeled "entered by merchant". Lookups are cached for 30 minutes. Check it with `npm run check-carrier -- <tracking number>`.

## Security notes

- Sandbox only. The PayPal base URL is fixed to `api-m.sandbox.paypal.com`.
- The gate wraps every registered tool, so an agent cannot reach a stock money-moving tool around it. Tools the policy doesn't name are denied.
- Approving a hold marks it before running it, so a crash cannot run it twice. A rejected hold cannot be approved later. An approval is refused if the case moved on since the hold (resolved, new stage, new amount, or PayPal no longer allows the action).
- On the hosted desk, visitors share one password. Each visitor's own sandbox case is leased to their browser session for 30 minutes; only that session can act on it, and holds from Break the mandate wait for the owner.
- Buyer and merchant messages are passed to Claude as evidence and the prompt tells it to treat them as data. The desk escapes all text it displays.
- Credentials come from environment variables. `.env` is git-ignored.
- The hosted desk uses HTTP basic auth over HTTPS. It is a demo control, not multi-user auth.

## Known limits

- Holds and cached recommendations are JSON files in `.junco/`, mirrored to Postgres on the hosted desk. Fine for one process.
- PayPal's sandbox lets this app file disputes as the buyer and nothing else: buyer messages and offer replies by API return 403, and the consent scope for them is rejected.
- PayPal's tracker only stores "shipped". Carrier delivery scans are entered by the merchant, and Claude is told they are merchant-supplied.
- Transaction Search and the v1 trackers API return 403 without extra app permissions, so evidence comes from the Orders and Payments APIs.
- The toolkit's MCP server takes a fixed access token, so long-running processes exit 10 minutes before the ~9 hour token expires and the host restarts them.
- PayPal Agent Toolkit 1.11.0 validates `accept_dispute_claim`'s `note` with the dispute-ID pattern, so any note with a space is rejected. JUNCO works around it with a one-word note.

## Built with

- **PayPal:** Agent Toolkit (MCP server and stock tools), Disputes API, Orders API, Payments API, sandbox.
- **Anthropic:** Claude Opus 5.5 through the Anthropic TypeScript SDK, with structured output.
- **Model Context Protocol** TypeScript SDK.
- **AG Grid:** AG Studio for the dispute desk (layout, widgets, Insights charts and the AI assistant), AG Grid for the dispute queue.
- **Render** for hosting the desk.

## License

MIT, see [LICENSE](LICENSE).
