#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOvuServer } from './app.mjs';

/**
 * OVU as an MCP server, over stdio.
 *
 * It is meant to sit alongside `binance-mcp-server` rather than replace it:
 * Binance's server executes and asks the user to confirm every write, OVU does
 * the reading and the arithmetic. OVU holds no credentials of any kind, and
 * there is no code path from here to a Binance trading endpoint.
 */

const server = createOvuServer();

const transport = new StdioServerTransport();
await server.connect(transport);
