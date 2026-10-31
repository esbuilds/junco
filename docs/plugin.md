# The gate inside PayPal's own plugin (Claude Code)

PayPal ships a plugin for coding agents, [paypal/AI-Toolkit](https://github.com/paypal/AI-Toolkit), on Anthropic's official marketplace (`/plugin install paypal@claude-plugins-official`). It connects Claude Code to PayPal's sandbox MCP server with a bearer token, so `create_refund`, `accept_dispute_claim` and `pay_order` are one sentence away, and its only hook is on file edits and describes itself as "Informational only". JUNCO's plugin installs next to it and puts the owner's `policy.json` in front of every call to PayPal's server, in the editor, with no JUNCO server at all. Back to the [README](../README.md).

## What a judge does

1. Install PayPal's plugin and set the sandbox token it asks for (`PAYPAL_SANDBOX_ACCESS_TOKEN`).
2. Load JUNCO's plugin from a checkout of this repo: `claude --plugin-dir /path/to/junco` (the marketplace path, `/plugin marketplace add esbuilds/junco` then `/plugin install junco@junco`, needs the repo public; see Open).
3. In any folder, ask Claude Code to refund a sandbox capture. The call comes back held with an id. Nothing reached PayPal.
4. At your own terminal, run `junco-gate approve <id> --toolkit` in that folder (from the repo: `cd packages/junco-gate && npm run build && npm link`). It shows the exact call and asks you to type the hold id. Then the gate re-reads the payment, runs exactly the held call through PayPal's own local MCP server (`@paypal/mcp`), and prints PayPal's refund id.

Reads (`get_order`, `get_dispute`, `list_disputes`) and allowed writes within their limits (a dispute message, an offer of at most 25 USD, within the 100 USD day) get no decision from JUNCO: Claude Code's own permission prompt still applies, and the call goes to PayPal's server exactly as it would without JUNCO.

## PayPal's server today

PayPal's hosted sandbox MCP server, the one PayPal's plugin connects to, has failed every `tools/call` with `PAYPAL_API_SETUP_ERROR: Unsupported cache mode: default` since Oct 29 2026 ([paypal/agent-toolkit#119](https://github.com/paypal/agent-toolkit/issues/119), open). So an allowed read or write through PayPal's plugin can fail for PayPal's reasons, not JUNCO's. JUNCO never reports such a call as done: on an allowed call it says nothing and PayPal's answer is what Claude sees, and the skill tells Claude to say so plainly. Holds don't depend on that server, because the hook runs before the call, and approvals don't either: `--toolkit` runs `@paypal/mcp` locally with the same token.

## How it works

`hooks/hooks.json` registers one `PreToolUse` and one `PostToolUse` hook on `^mcp__(plugin_paypal_paypal-sandbox|paypal)__`, which is how Claude Code names PayPal's plugin's tools (plugin `paypal`, server `paypal-sandbox`) and a server someone added by hand as `paypal`. Both run `hooks/gate.mjs`, a dependency-free bundle of `hooks/gate.ts` built with `npm run build:plugin`, because the plugin cache has no `node_modules`. `check-plugin` fails if the bundle is stale or carries anything but Node built-ins, and runs it from a clean copy of the plugin.

Every hook run is its own process. State is files in the project folder, the same files the `junco-gate` command uses:

| File | Holds |
|---|---|
| `.junco/holds.json` | each held call exactly as asked: method, args, reason, when, status, `origin: claude-code-plugin` |
| `.junco/daily-total.json` | today's total approved in advance (UTC), and this hook's open reservations by tool call |
| `.junco/gate-log.jsonl` | every allow, hold, deny and release with its reason and which policy file decided |

- **The policy.** `policy.json` in the project folder if there is one, else the plugin's own (the repo's default). A tool the policy doesn't name is refused.
- **Holds, once.** The same call asked again gets the first hold's id back, never a second hold. A call that already ran is refused.
- **The daily total across processes.** Two hooks can run at once, so the check and the reservation happen under a lock (`mkdir`, atomic) around `.junco/daily-total.json`; `check-plugin` fires eight offers at once and exactly as many pass as fit under 100 USD. A reservation is given back only when PayPal definitely refused the call (a 4xx, by the same rule the desk uses); a 5xx, no answer, or a success keeps it. The total is what was approved in advance, never money out.
- **Slack.** With `HOLD_WEBHOOK_URL` set in the shell that runs Claude Code, each new hold posts one line with the id and the approve command.
- **The skill.** `skills/junco-gate/SKILL.md` tells Claude what a hold means: nothing moved, the owner decides, don't ask again, tell the user the id.

## The boundary

What this stops: the model's PayPal tool calls, and its plain routes around the gate. `junco-gate approve` refuses, before it reads a token or connects to anything, unless a person is at a terminal (stdin and stdout are a TTY) and types the hold id; Claude Code's Bash tool has no TTY. The same hook refuses, from the editor, a Bash command that runs the approve command or could change `policy.json` or `.junco/`, and a Write, Edit, MultiEdit or NotebookEdit on those files. That string match is a speed bump, not a boundary; the TTY rule is the line.

This is not an OS boundary. PayPal's plugin needs `PAYPAL_SANDBOX_ACCESS_TOKEN` in the environment the agent runs in, so anything running as the same user with that token can call PayPal's REST API directly, fake a terminal, or write a script that does either. The hook sees tool calls, not processes. A stronger setup keeps the write token away from the agent: give the agent a read-only token, or none, and keep the token that refunds with the owner's own `junco-gate`.

What fails open: Claude Code treats a hook's non-2 exit and a timed-out hook as non-blocking, so a crash before the bundle's main() runs (a broken bundle; `check-plugin` rebuilds and runs it) or a run past the 20 s timeout (the hook waits at most 3 s for its lock and 3 s for Slack) would let a call through. Everything inside main() fails closed: hook input that isn't JSON, a missing or unreadable policy, a thrown error.

## Limits

- Tested in Claude Code. PayPal's plugin also installs in Cursor and Codex; whether their hooks run this one is not checked.
- The gate checks what the agent may do, not whether it should.
- The hosted desk's reconciliation lists a refund approved this way as one the desk didn't make, because it ran outside the desk's gate and inside the plugin's. The plugin's own record is `.junco/gate-log.jsonl`.
- Open: the marketplace install path needs the repository public, which is the owner's call. Until then, `--plugin-dir`.
