import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// src/ and dist/ have the same depth, so this resolves to mcp/ from either.
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const ENV_FILE_SETTING = process.env.EXPERT_ENV_FILE;

export const envFile =
  ENV_FILE_SETTING === '' ? null : resolve(projectRoot, ENV_FILE_SETTING ?? '.env');

if (envFile) config({ path: envFile });
