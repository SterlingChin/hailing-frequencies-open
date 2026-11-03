import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createVoiceServer } from '../voice/server.mjs';
import { loadConfig } from '../voice/config.mjs';
import { PostgresRepository } from '../crm/repo-postgres.mjs';
import { createCRMService } from '../crm/service.mjs';
import { createSmsFollowup, createTwilioSender } from '../sms/followup.mjs';
import { createSmsCallback } from '../sms/callback.mjs';
import { createCompanion } from './companion.mjs';
import { createDecisionsClient } from '../decisions/client.mjs';
import { createDecisionStep } from '../decisions/step.mjs';
import { createSmsReply } from '../reply/sms.mjs';
import { createCallReply, createTwilioCaller } from '../reply/call.mjs';
import { createQueueWorker } from '../queue/worker.mjs';
import { createCallerContextApi } from './caller-context-api.mjs';
import { createReportingApi } from './reporting-api.mjs';
import { createDecisionsApi } from './decisions-api.mjs';

export function createApplication({ config, repository = null, ...options }) {
  const crmService = options.crmService ?? (repository ? createCRMService(repository) : null);
  const smsFollowup = crmService ? createSmsFollowup({ service: crmService, config,
    send: options.sendSms ?? (config.smsEnabled ? createTwilioSender(config) : null) }) : null;
  const smsCallback = createSmsCallback({ service: crmService, config });
  const companion = createCompanion(options.companionOptions);
  const callerContext = createCallerContextApi({ service: crmService, token: config.contextApiToken });
  const reportingApi = createReportingApi({ service: crmService, token: config.reportingApiToken ?? null });
  const sendSms = options.sendSms ?? (config.smsEnabled ? createTwilioSender(config) : null);
  const decisionsClient = options.decisionsClient ?? createDecisionsClient({ apiKey: config.decisionsEnabled ? config.openaiKey : null });
  const decisionStep = crmService ? createDecisionStep({ service: crmService, client: decisionsClient }) : null;
  let queue = null;
  const decisionsApi = createDecisionsApi({ decisionStep, token: config.reportingApiToken ?? null });
  const app = createVoiceServer({ ...options, config, crmService, smsFollowup, decisionStep,
    onReplyRequested: taskId => { if (queue) queue.reply(taskId).catch(() => {}); },
    handleRequest: async (req, res) => {
      if (await callerContext.handle(req, res)) return true;
      if (await reportingApi(req, res)) return true;
      if (await decisionsApi(req, res)) return true;
      if (await smsCallback(req, res)) return true;
      if (await companion.handle(req, res)) return true;
      if (req.method !== 'GET' || req.url !== '/health') return options.handleRequest?.(req, res) ?? false;
      let ready = true;
      if (repository) {
        try { await repository.pool.query('SELECT 1 FROM schema_migrations LIMIT 1'); }
        catch { ready = false; }
      }
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable', database: repository ? (ready ? 'ready' : 'unavailable') : 'not_configured',
        companion: 'fixture', voiceEnabled: config.voiceEnabled, smsEnabled: config.smsEnabled,
        decisionsEnabled: Boolean(config.decisionsEnabled), callbackEnabled: Boolean(config.callbackEnabled) }));
      return true;
    },
  });
  if (crmService) {
    const placeCall = options.placeCall ?? (config.callbackEnabled ? createTwilioCaller(config) : null);
    queue = createQueueWorker({ service: crmService, specialists: options.specialists ?? {}, replies: {
      sms: createSmsReply({ service: crmService, config, send: sendSms }),
      voice: createCallReply({ service: crmService, config, place: placeCall, registerCallback: config.voiceEnabled ? app.registerCallback : null }),
    } });
  }
  return { ...app, queue, registerCallback: app.registerCallback, get callsStarted() { return app.callsStarted; },
    async close() { companion.close(); await app.close(); await callerContext.close(); await queue?.close(); } };
}

export async function main() {
  const config = loadConfig();
  const repository = config.databaseUrl ? new PostgresRepository({ connectionString: config.databaseUrl }) : null;
  const app = createApplication({ config, repository, onSummary: summary => {
    console.log(JSON.stringify({ event: 'call_finished', finalized: summary.finalized, toolSuccesses: summary.toolSuccesses }));
  } });
  app.server.listen(config.port, config.host);
  try { await once(app.server, 'listening'); }
  catch (error) { await repository?.close(); throw error; }
  console.log(`Hailing Frequencies Open ready on ${config.host}:${config.port}; companion uses fixtures.`);
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
  main().catch(() => { console.error('Application could not start. Check environment configuration; private details are withheld.'); process.exitCode = 1; });
}
