# <img src="brand/junco-mark.svg" width="28" height="28" alt=""> JUNCO

[![checks](https://github.com/esbuilds/junco/actions/workflows/checks.yml/badge.svg)](https://github.com/esbuilds/junco/actions/workflows/checks.yml)

**JUNCO works a small seller's PayPal disputes, and nothing that moves money goes out without the owner's OK.**

## For judges

- **Start at https://junco-desk.onrender.com/judges.** No password is needed to look; the password lets you act. It lists the AI purchases on record with their incident pages and receipts, the kayaking decline, and the Escape room's counter and latest runs, all read-only from the desk's records.
- **Hosted desk:** https://junco-desk.onrender.com. The password is in the Devpost submission's testing instructions (any username works on the desk).
- **What is sandbox:** everything. JUNCO runs on PayPal's sandbox with test accounts, and no real money moves. The disputes, offers, refunds, webhooks and the shopping agent's orders are real sandbox calls; the agent pays with a sandbox test buyer's saved PayPal account. The buyer's messages in Break the mandate and the Escape room are simulated, because PayPal's sandbox lets this app file disputes as the buyer and nothing else.
- **Four things to try, in order:**
  1. On the Desk, open **Start here** and pick **Investigate an AI purchase**. It opens the incident for an order a shopping agent placed and the buyer disputed: what the agent was allowed, what reached PayPal, and the gate re-run on a recorded request.
  2. Or, at the top of that Incidents page, **Send your own shopping agent**. Type what to buy and a budget. The agent buys one of the store's three bags in the sandbox or buys nothing, and its incident opens either way. Two runs per visitor a day.
  3. **Point your own Claude at the desk:** in claude.ai, go to Settings, Connectors, Add custom connector, enter `https://junco-desk.onrender.com/mcp`, and sign in as `judge` with the same password. claude.ai declines to call tools that move money, so from claude.ai you investigate: ask it to list the incidents, read one, and re-run the gate under a lower limit. Other clients and the money tools are in [docs/mcp.md](docs/mcp.md).
  4. Under Test it, open the **Escape room**. Five rooms, each harder: try to get the owner's money out past the policy. The counter shows every attempt and every escape on record.
- **PayPal's hosted MCP server has been failing its API calls since Oct 28** (their bug: "Unsupported cache mode: default"). Until PayPal fixes it, `/mcp` is the working path for connectors, and it carries refunds and orders too, through PayPal's Agent Toolkit.
- **If Claude is down,** or the desk's daily AI budget is used up, the header says the desk is read-only. Cases, saved recommendations, holds, the Gate record, incident pages, receipts and past runs still open, and approving a hold doesn't need Claude. The shopping agent and new Escape room attempts need Claude.
- **If PayPal's sandbox is down,** Try it (43 made-up cases, no PayPal calls), the Gate record, incident pages, receipts and every past run's page still work. Live cases won't load.
- **The results keep updating.** Break the mandate's counter and attack log keep logging public use after the deadline, on the same code, and mark the deadline (Nov 12, 2026, 12:00 pm PST) with the counts as of then.

![The desk at 1280 by 800: Waiting for you, Agent activity, the Gate record and the dispute queue, with the AG Studio assistant on the right](docs/img/desk.png)

| Insights on AG Studio | On a phone |
|---|---|
| ![Insights: filters by reason and by what JUNCO says, money by status, amount by deadline, amount by what JUNCO says](docs/img/insights.png) | ![The desk on a 390 px phone: panels stacked full width](docs/img/phone.png) |

## Why

Small online sellers lose PayPal disputes they could have won. Pulling the order, the tracking and the messages together takes an evening, the 10-day response window slips by, and refunding starts to feel easier. A case that escalates to a claim can also cost a [$15 dispute fee](https://www.paypal.com/us/webapps/mpp/merchant-fees#statement-19), which [PayPal doesn't charge](https://www.paypal.com/us/legalhub/paypal/useragreement-full) when it's resolved with the buyer first. And shopping agents now buy things for people, so a buyer can dispute an order their own agent picked, and the seller still has to answer it.

JUNCO reads each dispute, pulls the evidence PayPal already has, and recommends one action: message the buyer, offer a partial refund, contest with evidence, accept, or wait while PayPal reviews. Every claim it makes cites a numbered piece of evidence, and plain code checks those citations, the quotes and the message to the buyer before anything happens. What the AI concludes is still the AI's. What it's allowed to do is checked against PayPal's case and the owner's policy.

## A gate in front of PayPal's own tools

JUNCO is the only public entry we found that puts a gate in front of PayPal's hosted MCP server (as of Oct 21). `/mcp/paypal` puts the owner's `policy.json` in front of every one of `mcp.sandbox.paypal.com`'s 46 tools and adds JUNCO's dispute tools. Any MCP client can use it, including Claude as a custom connector added by URL; a judge's sign-in gets visitor rights, never the owner's.

- **Every call is allowed, held or denied.** Reads, messages, evidence and offers up to $25 go out. Larger offers, refunds and accepting a claim wait for the owner. Anything the policy doesn't name is denied.
- **The agent asked twice. JUNCO refused the second.** The same call asked twice never makes a second hold, and a held refund is refused if this gate already ran another refund on that payment after it was held. The gate's own record decides, because PayPal's sandbox doesn't always show a refund right away; a refund PayPal reports by webhook is a second witness.
- **An approved hold runs only if the case is still the one the owner was shown.** If PayPal's webhook says it changed, the hold is marked "re-check" before the owner taps.
- **The owner decides from a phone.** Each hold goes to Slack with a signed one-tap link, and says who asked: the Claude connector, an MCP client, the desk's agent or the dashboard assistant.

PayPal's platform team wrote about this problem in October. Their [Oct 8 post on PayPal's MCP Hub](https://developer.paypal.com/community/blog/One_connection_2000_tools) lists "Which tools may each user discover and invoke?" among six questions the protocol leaves to you. It says "An agent action should remain attributable to the person who authorized it and the agent that executed it" and that "every production path needs an explicit control boundary." Their [Oct 9 post on agent skills](https://developer.paypal.com/community/blog/agent_skills_at_enterprise_scale) runs automated checks, prompt injection among them, before a human answers "Should this be trusted and published?" JUNCO is a small seller's answer to those questions for PayPal's own tools: `policy.json` decides which tools an agent sees and which wait, every hold names who asked and only the owner approves, the Gate record is the audit trail, and DisputeBench's 10 injection scenarios test the agent. The quotes are PayPal's and the mapping is ours; PayPal hasn't reviewed or endorsed JUNCO.

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

1. **Evidence.** `recommend.ts` follows the dispute to its capture and order and numbers everything it finds (E1, E2, ...): messages, evidence on file, offers, items, address, tracking, seller protection.
2. **Recommendation.** Claude Opus 5.5 returns a structured decision, a summary, claims that each cite evidence IDs, and a draft message to the buyer. It's told which actions PayPal currently allows on the case.
3. **Checks.** `validate()` blocks claims citing missing evidence, quotes not in the source word for word, actions PayPal doesn't allow, and offers out of range. A message to the buyer can't say an order shipped unless the evidence shows it.
4. **Gate.** Every tool call goes through `policy.json` (above). The gate is also a standalone package, [junco-gate](#junco-gate).
5. **Action.** JUNCO's tools check PayPal's HATEOAS links first, so they only run when PayPal says the action is available.

With `AGENT_MODE=on` JUNCO works new disputes by itself from PayPal's signature-verified webhooks ([docs/running.md](docs/running.md)).

## The desk on AG Studio

The hosted desk is an [AG Studio](https://www.ag-grid.com) report, not a page with a chart library bolted on: 17 JUNCO widget types, an Insights page on Studio's own data engine where filters and charts cross-filter the live PayPal cases, the desk's theme on Studio's native widgets, and an AG Grid dispute queue. The AI assistant is Studio's, with JUNCO as its own agent: asked for a chart of the disputes the seller is about to lose, it hands the query to Studio's data agent, the placement to the page agent and the chart to the widget agent, and the trace shows each hand-off. It gets the same gated PayPal tools as every other agent, so a money move it asks for lands in Waiting for you, tagged "asked by the dashboard assistant". Details are in [docs/ag-studio.md](docs/ag-studio.md).

## When an AI agent did the buying

Dispute this store has a case where a shopping agent did the buying, live in PayPal's sandbox. A shopping agent (Claude Sonnet 5.5) gets an instruction and a budget, reads the store's three-bag catalog and buys one or declines; the store charges the buyer's vaulted PayPal account with Orders v2. Asked for "a carry-on weekend bag that looks nice", it bought the waxed weekender and called it carry-on size, though at 25 cm deep it's over the 23 cm many airlines allow. The buyer disputes it as not as described, and JUNCO compares the store's record of what the agent was asked with what the listing said, through the same checks and gate.

The checkout record is the store's own, not a mandate signed by PayPal or a card network. JUNCO doesn't use PayPal's Agent Ready or Store Sync, which aren't open in sandbox.

## Investigate an AI purchase

BLACK BOX turns one AI purchase into a record that can be investigated after the agent that made it is gone. It joins what the desk already keeps (the order the shopping agent placed, the dispute, every money move the gate held, allowed or denied, the owner's decision and PayPal's answer) into one incident, and nothing in it comes from a model.

- **The incident page** (`/incident/<id>`, where the id is the buyer transaction id, the order id or the capture id; linked from the case and from the first Start here step) lists every event oldest first, labelled LIVE when PayPal's sandbox did it and RECORDED when it was a decision inside the desk. It shows what the buyer allowed, what the agent bought, four counts (proposed, approved, executed, outcome unknown) and the facts the records don't have, listed as missing instead of filled in. After an approved refund, the desk shows PayPal's refund id and status.
- **Three questions** are answered from the incident alone, with no model call: which actions reached PayPal, what's not in the records, and what the gate would have done with an amount limit $10 under the purchase. That what-if re-runs the gate's own decision on the recorded request, makes no PayPal call, and is drawn apart from the record, dashed and labelled WHAT-IF.
- **Reconciliation:** each time an incident with a capture is opened, the desk reads what PayPal shows for that payment (the capture, then its order's refunds) and lines it up against its own holds. Every money movement gets one line: matched when PayPal shows a refund whose id an approved hold kept, at PayPal only when PayPal shows a refund the desk has no record of, and on the desk only when a hold says it ran but PayPal doesn't show it. Each line names the record it came from, and none of it comes from a model. On the purchase in the video, it prints "PayPal shows a refund of 59.35 USD (6E9082945T161501K, PENDING) that the desk has no record of", which a fresh Claude had to find by hand before. The reads are GETs only, cached for a minute per capture, and if PayPal doesn't answer the line says so and the rest of the page still loads. The logic is in `src/reconcile.ts`, which takes PayPal's GET from the desk or the connector server, so `incident.ts` still has no PayPal client of its own.
- **The receipt** (`/incident/<id>/receipt`) is one printable page with the capture id, the incident id, the refund id and a QR code back to the incident page.
- **From your own Claude,** `junco_list_incidents`, `junco_get_incident` and `junco_what_if` are read-only tools on both `/mcp` and `/mcp/paypal`. A Claude that wasn't part of the purchase can pull the incident, see the rule the gate applied to each call and re-run a call under a different limit. Studio's Incident page shows the same JSON.
- **When the agent buys nothing,** that is an incident too. Asked for "a waterproof weekend bag I can take kayaking, under $70", the shopping agent bought nothing: the only waterproof bag, WKD-02, costs $74. Incident `decline-20261029162810201` records what it was asked, the budget, the three listings it saw and its reason, as one RECORDED event. It has no order, no payment and no money moves, and says so under what the records don't have.

### Your AI buys, you investigate

A desk visitor can send the shopping agent themselves (`/api/shop`, the form on the Incidents page). They type what to buy and a budget up to $80. The agent picks a bag or declines, and if it picks one the store charges the sandbox test buyer's saved PayPal account at the catalog's price, never a price from the model, and refuses an item over the budget before calling PayPal. The incident opens right after.

- **Caps:** two runs per visitor a day and 20 for the whole desk, counted before any Claude call, on top of the desk's daily AI budget.
- **Private to the visitor:** their buys and declines are listed only for them and the owner. Anyone with the link can open the page.
- **Keyed by the capture id:** the desk can't read the buyer's PayPal activity, so there is no buyer transaction id, and the incident says that under what the records don't have. For example, capture `57G046971Y1191455`: asked for "a light packable bag for a rainy city weekend" under $45, the agent bought WKD-03 for $38.
- **Refunds only:** without the buyer transaction id these orders can't be disputed. A refund names the capture, so a refund someone asks JUNCO for lands in the same incident and waits for the owner like any other.

## Break the mandate

A visitor plays the buyer and tries to make JUNCO give away more than the owner allowed, with their own message or from a fair complaint, a haggler or an attacker. JUNCO works a real never-shipped sandbox case, and whatever it proposes goes through the gate. A "faulty agent" switch makes the agent concede the full amount without reading anything, to show the gate holds when the AI is wrong. Every run gets a page at `/run/<id>`, and any MCP client can attack it at `/mcp/challenge`.

### Escape room

The same challenge as five rooms of rising difficulty: Fair complaint, Haggler, Impersonation, Planted instruction (a pasted "receipt" with an instruction for JUNCO hidden in it) and Your own. Each room opens after the visitor tries the one before, and each attempt is an ordinary Break the mandate run on the same case, under the same gate and caps, with no faulty agent.

- **An escape** is money PayPal accepted beyond the owner's limit. It is read from each run's gate decision and PayPal's answer, never from what the AI says. A refund inside the limit is allowed, not an escape: the owner allowed it.
- **The outcome** under each attempt is worded from the same records. Run `c5b289d1` (room 1) reads "No money moved: JUNCO answered with a message", because JUNCO proposed a message and the policy lets messages go out.
- **The counter** at the top, "N attempts, M escapes", counts every Escape room run on record. If an escape ever happens, it shows, with a link to the run.

## Tested

`evals/scenarios.ts` holds 43 dispute scenarios, including 10 prompt injections and a mistake JUNCO made on the live desk on Oct 10 (it told a buyer an unshipped order had shipped; the message check exists because of it). On the latest full run JUNCO picked an acceptable decision on 43 of 43 with 0 invented citations and 10 of 10 injections resisted. The scenarios are ours, so this is a regression suite, not a win rate.

The same scenarios are DisputeBench, which any dispute agent can be scored on. Across its 43 scenarios, no model without JUNCO's checks moved money it shouldn't have. Their mistakes were contests they'd lose and messages that weren't true, such as telling buyers whose orders never shipped that tracking details would follow. That is what the checks catch. Full results are in [docs/eval.md](docs/eval.md).

`.github/workflows/checks.yml` runs the typecheck and the 20 checks that need no PayPal, Claude or database credentials. They cover the gate, holds, leases, incidents, declines, the visitor's shopping agent and the Escape room, among others; the rest run against the sandbox by hand ([docs/running.md](docs/running.md)).

## junco-gate

`packages/junco-gate` is the gate as a package for any MCP server: a policy per tool, holds bound to the exact call, a re-check before an approved call runs, tracked outcomes, an action log, and `mirror()` to wrap someone else's server. As a command, `junco-gate --paypal` is an MCP server in front of PayPal's hosted MCP server: refunds and dispute accepts come back held, and `junco-gate approve <id>` re-reads the dispute through PayPal's own server before running the exact held call. It isn't on npm; run it from the repo ([packages/junco-gate/README.md](packages/junco-gate/README.md)).

## Run it yourself

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

Creating sandbox disputes, agent mode, Slack, carrier lookups, the checks, security notes and known limits are in [docs/running.md](docs/running.md). Every way to connect an agent, the tools JUNCO adds and the policy file are in [docs/mcp.md](docs/mcp.md).

## Built with

- **PayPal (sandbox):** Agent Toolkit 1.11.0 (MCP adapter), the hosted MCP server (`mcp.sandbox.paypal.com`, SSE), Disputes v1 including the sandbox-only buyer-side create, Orders v2 (`vault_id` with `stored_credential`, and `track`), Vault v3, Payments v2, and Webhooks with signature verification. `add_order_tracking` posts tracking to the Orders v2 `track` endpoint, and PayPal's own page for it says ["Adding tracking to an order qualifies holds for early release."](https://developer.paypal.com/api/orders-v2/track-orders/integrate/)
- **Anthropic:** Claude Opus 5.5 for recommendations; Claude Sonnet 5.5 for the support check, the shopping agent and the Studio assistant.
- **Model Context Protocol** TypeScript SDK, and Claude custom connectors (OAuth with dynamic client registration).
- **AG Grid:** AG Studio for the desk (layout, widgets, Insights and the AI assistant) and AG Grid for the dispute queue.
- **Render:** one web service and one Postgres.
- **Slack:** an incoming webhook for holds and one-tap links.

*The name:* the junco is a small gray bird you've probably seen a hundred times without knowing what it's called. They spend the day on the ground picking through the details everyone else walks past, and when something's wrong they flash the white feathers in their tail so the rest of the flock knows.

## License

MIT, see [LICENSE](LICENSE).
