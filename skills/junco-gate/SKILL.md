---
name: junco-gate
description: What it means when JUNCO holds or refuses a PayPal call in this session, and how to propose a refund, a dispute accept or an offer through the owner's gate. Use when a PayPal tool call comes back held or refused by JUNCO, when asked to move money through PayPal, or when asked what JUNCO is.
---

# JUNCO's gate in this session

JUNCO is an owner's policy in front of PayPal's tools. In this session it runs as a hook on every call to PayPal's MCP server, before the call is made. The owner's `policy.json` (the project's, or the plugin's default) says, tool by tool, what happens:

- **read**: the call runs. `get_order`, `get_dispute`, `list_disputes`, `get_refund` and the other reads.
- **allow**: the call runs, within its limit and the owner's daily total. A dispute message, evidence, an offer of at most 25 USD.
- **hold**: the call does not run. It is stored exactly as asked, with a hold id, for the owner. `create_refund`, `accept_dispute_claim`, offers over the limit, anything that would pass the daily total.
- **deny** or not in the policy: refused. Nothing is sent.

## When a call comes back held

The hook refused the call and gave you a hold id. That means:

1. Nothing was sent to PayPal. No money moved.
2. The owner runs exactly that call, once, with `junco-gate approve <id> --toolkit` in the project folder, or rejects it with `junco-gate reject <id>`. You cannot approve it.
3. Do not call the same tool again for the same action. The gate would not make a second hold; it would point you back to the first.
4. Tell the user the hold id, what was held (tool, amount, capture or dispute) and that it is waiting for the owner. Quote the hold's reason.

Calling a held tool is the right way to propose the action to the owner. If the user asks for a refund, call `create_refund` with the exact capture id and amount; the hold is the proposal.

## What the gate does not do

It does not judge whether the action is right. It does not make PayPal answer: a read or an allowed call goes to PayPal's own server with the user's token, and PayPal's answer is PayPal's. If PayPal's hosted sandbox server answers an error on every call (it has, see paypal/agent-toolkit#119), say so plainly and do not report the call as done.

Records: `.junco/holds.json` (holds), `.junco/daily-total.json` (today's total approved in advance, UTC) and `.junco/gate-log.jsonl` (every allow, hold and deny with its reason), all in the project folder.
