import { Socket } from 'node:net';

// Runs before application imports in every test worker. Never load .env, never reach a vendor.
process.env.EXPERT_ENV_FILE = '';
process.env.EXPERT_SANDBOX = 'scripted';
process.env.OPENAI_API_KEY = '';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.EXPERT_MCP_TOKEN = '';

// Intercept sockets, including fetch/undici and SDK transports, before DNS or I/O.
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...raw: unknown[]) {
  const args = Array.isArray(raw[0]) ? raw[0] : raw;
  const options = args[0];
  const host =
    typeof options === 'object' && options !== null
      ? (options as { host?: string }).host
      : typeof args[1] === 'string'
        ? args[1]
        : undefined;
  if (host && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`Tests forbid external network access: ${host}`);
  }
  return Reflect.apply(connect, this, raw) as Socket;
} as typeof connect;
