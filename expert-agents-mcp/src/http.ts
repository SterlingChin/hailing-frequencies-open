import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { bearerTokenMatches } from './config.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface HttpServerOptions {
  handler: McpHttpHandler;
  host: string;
  port: number;
  /** When true every request must carry a bearer token matching EXPERT_MCP_TOKEN. */
  requireToken: boolean;
  allowedHosts?: string[];
  log?: (message: string) => void;
}

export interface RunningHttpServer {
  server: HttpServer;
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const nodeHandler = toNodeHandler(options.handler);
  const loopback = LOOPBACK_HOSTS.has(options.host);
  // OX Agent: javascript-server-hardening prevented (Host/Origin validation against DNS rebinding)
  const validateHost = loopback
    ? localhostHostValidation()
    : hostHeaderValidation([options.host, ...(options.allowedHosts ?? [])]);
  const validateOrigin = loopback ? localhostOriginValidation() : () => true;

  const server = createServer((req, res) => {
    setBaselineHeaders(res);
    const path = pathOf(req);
    if (path === HEALTH_PATH && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (options.requireToken && !authorized(req)) {
      // OX Agent: javascript-server-hardening prevented (generic 401, token compared in constant time)
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const hostForUrl = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${hostForUrl}:${address.port}${MCP_PATH}`;
  options.log?.(`listening on ${url}`);

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function setBaselineHeaders(res: ServerResponse): void {
  // OX Agent: javascript-server-hardening prevented (hardened response headers, static values only)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const end = raw.indexOf('?');
  return end === -1 ? raw : raw.slice(0, end);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const [scheme, token] = header.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) return false;
  return bearerTokenMatches(token);
}
