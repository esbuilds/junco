# junco-gate

An owner's policy in front of any MCP server's tools. Each call an agent makes is allowed, held for the owner, or denied, and every decision goes to an action log. A buyer's message, a prompt injection or a confused model can change what the agent asks for. It can't change what the owner allowed.

It was built for JUNCO, a PayPal dispute agent, where it sits in front of PayPal's hosted MCP server and JUNCO's own dispute tools. Nothing in the package is specific to PayPal.

## What it does

- **Policy per tool.** `read` runs and changes nothing; `allow` is an allowed write; `hold` waits for the owner; `hidden` isn't listed and is denied if called; a limit (`{ "max_amount": 25, "over": "hold" }`) allows calls up to an amount. Tools the policy doesn't name get the default, usually `deny`.
- **Holds are bound to the exact call.** Approving a hold runs the stored method and arguments, nothing else.
- **A re-check before an approved call runs.** `beforeRun` can refuse if the world moved on since the hold (the case closed, the amount changed). The hold is marked stale and nothing runs.
- **Outcomes are tracked, never retried blind.** An approved hold goes executing, then completed, failed or unknown. Unknown (the call threw, or the upstream connection dropped) is settled by `landed`, a re-read of the world, and never by running the call again.
- **Guards** refuse before policy (for example, "this case belongs to another user"), on calls and on approvals.
- **Any server, any transport.** `mirror(client)` puts another server's tools on a local server so the gate can wrap it, with the upstream's own schemas in `tools/list`.

## Wrap someone else's server

```ts
const upstream = new Client({ name: 'gated-filesystem', version: '1.0.0' });
await upstream.connect(new StdioClientTransport({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', dir] }));
const { server } = await mirror(upstream);
const holds = gate(server, { default: 'deny', tools: { read_text_file: 'read', list_directory: 'read', write_file: 'hold' } }, {
  onHold: (h) => notifyOwner(h),
  log: (d) => console.error(`${d.verdict} ${d.method}: ${d.reason}`),
});
await server.connect(new StdioServerTransport());
// later, from the owner's side:
await holds.approve(holdId); // or holds.reject(holdId)
```

The full example is `examples/wrap-any-server.ts`. Point Claude Desktop or any MCP client at it instead of the filesystem server: reads go through, writes wait for you, everything else is refused.

## Your own server

Register your tools on an `McpServer` as usual, then call `gate(server, policy, options)` last so it wraps every tool.

## Options

| Option | What it's for |
|---|---|
| `store` | Where holds live. Default `jsonStore('.junco/holds.json')`. |
| `onHold(hold)` | Tell the owner: a webhook, a dashboard. |
| `log(decision)` | The action log: every allow, hold and deny with its reason. |
| `guards` | `(method, args, phase) => reason or null`, checked before policy (`call`) and at approval (`decide`). |
| `allow(method, args)` | A reason to allow before policy, such as a standing approval with its own limit. |
| `snapshot(hold)` | State stored with a new hold, such as what the owner will be shown. |
| `beforeRun(hold)` | Before an approved hold runs: `{ refuse }` to mark it stale, `{ trail }` to keep for settling. |
| `landed(hold)` | After an unknown outcome: did it land? `true`, `false`, or `null` to leave it for a person. |
| `unknownErrors` | Error types in a tool result that mean "may have landed". `mirror` reports `upstream_unavailable`. |

## Tests

`npm test` runs the three cases a gate has to get right, through a real MCP server and client: a call within the limit runs; a call over it is held and approval runs exactly that call, once; a hold whose world changed is refused at approval and nothing runs.

## Limits

It reads private state of `@modelcontextprotocol/sdk`'s `McpServer` (`_registeredTools`, and `_requestHandlers` in `mirror`), checked on 1.32. Holds live in one JSON file per store, written by one process. The gate checks what an agent is allowed to do; it doesn't check whether the agent's reasoning is right.

MIT licence.
