const MAX_MESSAGE_LENGTH = 200;

/**
 * Turns an unknown thrown value into a short, safe string. Every error that can reach a tool
 * result or a JSON-RPC error passes through here so stack traces and internals never leak.
 */
// OX Agent: javascript-server-hardening prevented (errors formatted, never forwarded raw)
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.length > 0) {
    return err.message.slice(0, MAX_MESSAGE_LENGTH);
  }
  return 'Unexpected error';
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
