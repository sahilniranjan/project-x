import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

export const AGENT_CLIS = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'grok', 'qwen', 'kimi', 'copilot', 'gemini', 'hermes', 'omp'];

/**
 * The agent CLI the user chose: PROJECT_X_CLI from the shell, else from the
 * data root's .env. Reads .env without loading it into process.env.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function readRememberedCli(root, env = process.env) {
  if (env.PROJECT_X_CLI) return env.PROJECT_X_CLI;
  const file = join(root, '.env');
  if (!existsSync(file)) return null;
  return dotenv.parse(readFileSync(file, 'utf8')).PROJECT_X_CLI || null;
}
