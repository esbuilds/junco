// Put an owner's policy in front of someone else's MCP server: here the official filesystem server. Reads run, writes wait
// for the owner, anything not listed is denied. Point Claude Desktop (or any MCP client) at this script instead of the server.
//   npx tsx examples/wrap-any-server.ts /path/to/folder
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { gate, mirror } from '../src/index.js';

const upstream = new Client({ name: 'gated-filesystem', version: '1.0.0' });
await upstream.connect(new StdioClientTransport({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', process.argv[2] ?? '.'] }));
const { server } = await mirror(upstream);
gate(server, { default: 'deny', tools: {
  read_text_file: 'read', list_directory: 'read', list_allowed_directories: 'read', search_files: 'read', get_file_info: 'read',
  write_file: 'hold', edit_file: 'hold', create_directory: 'hold', move_file: 'hold',
} }, {
  onHold: (h) => console.error(`held ${h.id}: ${h.method} ${JSON.stringify(h.args)} (${h.reason})`), // stdout is the MCP channel
  log: (d) => console.error(`${d.verdict} ${d.method}: ${d.reason}`),
});
await server.connect(new StdioServerTransport());
// Holds are in .junco/holds.json. Approve from your own code with the object gate() returns: await holds.approve(id).
