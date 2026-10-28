# Running JUNCO

Setup, agent mode, carrier lookups, checks, security notes and known limits. Back to the [README](../README.md).

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

With a one-time buyer consent (`disputes/create`), the app can file disputes as the sandbox buyer by API. `npm run pool -- 4 unshipped` (or `delivered`) pays sandbox orders as the buyer in a headless browser and adds them to the desk's pool; the desk files them as disputes ahead of time. On an order with tracking, the sandbox opens the dispute as a chargeback under PayPal review; with no tracking, as an inquiry where the seller can message and offer. PayPal opens merchant actions 4 to 7 minutes after filing.

Without the consent, open one by hand: `npm run seed` creates an order and prints the buyer approval link, `npm run seed capture <order_id> [unshipped]` captures it, then log in to sandbox.paypal.com as the buyer and choose **Report a problem**.

## Agent mode

With `AGENT_MODE=on`, JUNCO handles new disputes by itself:

1. PayPal sends `CUSTOMER.DISPUTE.CREATED` / `UPDATED` / `RESOLVED`, `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` to `/webhooks/paypal`. Every event is checked with PayPal's `verify-webhook-signature` before anything runs. A dispute or refund event that touches the case or payment of a waiting hold marks it "re-check" on the desk and in Slack; a refund PayPal reports on a payment after a refund on it was held refuses that hold at approval.
2. The agent waits for PayPal to open merchant actions (new disputes have none for a few minutes), gets a recommendation, and carries it out through the gate. Messages and evidence go out; larger offers and concessions wait in the owner's queue.
3. It acts once per dispute state, never messages a buyer who hasn't answered the last seller message, and treats the update its own action causes as a no-op. A sweep every 10 minutes catches missed webhooks.
4. Every step lands in the activity log shown in the desk.
5. When the gate holds an action, JUNCO posts it to `HOLD_WEBHOOK_URL` (a Slack incoming webhook, or anything that accepts `{"text": ...}`) with the dispute, amount, reason and a signed one-tap link that approves or rejects that one hold for 48 hours. How each hold ended goes to the same channel.

```bash
npm run webhook https://your-desk.example.com   # register the sandbox webhook
npm run check-agent                             # loop guards against live sandbox disputes
```

## Carrier proof (USPS, UPS)

When carrier credentials are set, JUNCO looks up each tracking number on a disputed order with the carrier and adds the result as evidence labeled as carrier data: USPS through the [USPS APIs](https://developers.usps.com) (`USPS_CONSUMER_KEY`, `USPS_CONSUMER_SECRET`, Tracking product enabled) and UPS for `1Z` numbers through the [UPS Developer Portal](https://developer.ups.com) (`UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, Tracking API added). It only does that when the lookup succeeded; otherwise there is no carrier line, and a scan typed by the merchant is labeled "entered by merchant". Lookups are cached for 30 minutes. Check it with `npm run check-carrier -- <tracking number>`.

## Checks

```bash
npm run typecheck
npm run check        # tools through the MCP server against the sandbox (add -- --write to send a real message)
npm run check-gate   # policy decisions, holds, approve and reject, stale approvals, the hold lifecycle, the double refund
npm run check-gate-pkg  # junco-gate on its own: allowed, held, stale through a real MCP server and client
npm run check-ai     # validator, quote and message cases offline, then one real Claude call
npm run check-agent  # agent triage: acts once per state, no repeat messages
npm run check-lease  # case leases, who may approve where, the pre-filed pool
npm run check-challenge  # Break the mandate: the three cards, caps, owner-only holds, private messages
npm run check-onetap # one-tap links: signed per hold, no stretched expiry, GET never decides
npm run check-recheck   # webhook re-check flags and the reported-refund refusal, offline
npm run check-incident  # BLACK BOX: the incident join, missing facts, and a what-if that reaches no network, offline
npm run check-killswitch # the owner's kill switch signs every connector out; offline, on a fixture token store
npm run check-hosted-health # the self-check calls PayPal's hosted server, not just lists it; offline
npm run check-refund-mcp   # create_refund on /mcp: held, runs once on approval, double refunds refused; offline
npm run check-hosted    # PayPal's hosted MCP server behind the gate: every tool classified, a read, a hold
npm run check-connector # the Claude connector sign-in against a running desk (DESK_URL), reads only
npm run check-token     # a forced-expired PayPal token is renewed and the call retried once, reads only
npm run eval         # 43-scenario recommendation eval (about $2.50 with the support check)
```

CI (`.github/workflows/checks.yml`) runs the typecheck and every check that needs no PayPal, Claude or database credentials on each push. The rest run against the sandbox by hand.

## Security notes

- Sandbox only. The PayPal base URL is fixed to `api-m.sandbox.paypal.com`.
- The gate wraps every registered tool, so an agent cannot reach a stock money-moving tool around it. Tools the policy doesn't name are denied.
- Approving a hold marks it before running it, so a crash cannot run it twice. A rejected hold cannot be approved later. An approval is refused if the case moved on since the hold (resolved, new stage, new amount, or PayPal no longer allows the action).
- On the hosted desk, visitors share one password. Each visitor's own sandbox case is leased to their browser session for 30 minutes; only that session can act on it, and holds from Break the mandate wait for the owner.
- Buyer and merchant messages are passed to Claude as evidence and the prompt tells it to treat them as data. The desk escapes all text it displays.
- Credentials come from environment variables. `.env` is git-ignored.
- The hosted desk uses HTTP basic auth over HTTPS. It is a demo control, not multi-user auth. Claude connectors sign in with OAuth (dynamic client registration, PKCE S256, rotating refresh tokens, revocation): username `judge` and the desk password give visitor rights; only the owner token gives owner rights. Clients and token hashes are kept in Postgres, so a deploy doesn't sign anyone out.

## Known limits

- Holds and cached recommendations are JSON files in `.junco/`, mirrored to Postgres on the hosted desk. Fine for one process.
- PayPal's sandbox lets this app file disputes as the buyer and nothing else: buyer messages and offer replies by API return 403, and the consent scope for them is rejected.
- PayPal's tracker only stores "shipped". Carrier delivery scans are entered by the merchant, and Claude is told they are merchant-supplied.
- Transaction Search and the v1 trackers API return 403 without extra app permissions, so evidence comes from the Orders and Payments APIs, and the hosted `list_transactions` tool is hidden (as is `get_merchant_insights`, which PayPal doesn't support in sandbox).
- The toolkit's MCP server takes a fixed access token; JUNCO hands it the live token on every request and renews it before it expires, so the desk never restarts for a token.
- PayPal Agent Toolkit 1.11.0 validates `accept_dispute_claim`'s `note` with the dispute-ID pattern, so any note with a space is rejected. JUNCO works around it with a one-word note; the fix is proposed upstream as paypal/agent-toolkit#109 (open).
