import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createApplication } from './server.mjs';
import { createDecisionsClient } from '../decisions/client.mjs';
import { createCRMService } from '../crm/service.mjs';
import { PostgresRepository } from '../crm/repo-postgres.mjs';
import { loadConfig } from '../voice/config.mjs';

// Compatibility entry point with an injectable Decisions transport for fixtures.
// Both endpoints are mounted by createApplication and share one CRM service.
export function createContextApplication({ config, repository = null, decisionFetch = globalThis.fetch, ...options }) {
  const crmService = options.crmService ?? (repository ? createCRMService(repository) : null);
  const decisionsClient = options.decisionsClient ?? createDecisionsClient({
    apiKey: config.decisionsEnabled ? config.openaiKey : null, fetch: decisionFetch,
  });
  return createApplication({ ...options, config, repository, crmService, decisionsClient });
}

export async function main() {
  const config = loadConfig();
  const repository = config.databaseUrl ? new PostgresRepository({ connectionString: config.databaseUrl }) : null;
  const app = createContextApplication({ config, repository });
  app.server.listen(config.port, config.host);
  try { await once(app.server, 'listening'); }
  catch (error) { await repository?.close(); throw error; }
  console.log(`CRM and Decisions backend listening on ${config.host}:${config.port}; Decisions ${config.decisionsEnabled ? 'enabled' : 'disabled'}.`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
    void app.close().then(() => repository?.close()).then(() => { clearTimeout(deadline); process.exit(0); });
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('CRM and Decisions backend could not start. Check local configuration.'); process.exitCode = 1; });
}
