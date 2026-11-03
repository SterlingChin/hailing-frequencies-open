import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PostgresRepository } from '../crm/repo-postgres.mjs';
import { requireConfirmedDatabase } from '../crm/env.mjs';
import { DEMO, seedDemo } from '../crm/seed.mjs';

const PROJECT_ID = 'f099c9b8-27ed-4661-9998-67137ce6de84';

export async function ensureRailwayAvery({ env, confirmedHost, phone }) {
  if (env.RAILWAY_PROJECT_ID !== PROJECT_ID || env.RAILWAY_ENVIRONMENT !== 'production') {
    throw new Error('The expected Railway production project is required');
  }
  const connectionString = requireConfirmedDatabase(env.DATABASE_PUBLIC_URL, confirmedHost);
  const repo = new PostgresRepository({ connectionString });
  try {
    const result = await seedDemo(repo, { scenario: 'returning', phone, preserveExisting: true });
    const row = await repo.transaction(async tx => (await tx.find('crew_members', { id: DEMO.crewId }))[0]);
    if (!row || row.display_name !== 'Avery Chen' || !row.is_demo) throw new Error('Avery demo record missing');
    return result;
  } finally {
    await repo.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--remote-host' || args[2] !== '--phone') {
    throw new Error('Use --remote-host <exact-hostname> --phone <fictional-E164>');
  }
  const result = await ensureRailwayAvery({ env: process.env, confirmedHost: args[1], phone: args[3] });
  console.log(result.added ? 'Avery demo profile added.' : result.phraseUpdated ? 'Avery demo phrase rotated; history preserved.' : 'Avery demo profile already current.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Avery seed refused or failed; check the production project, exact database host, fictional phone, and existing demo record.'); process.exitCode = 1; });
}
