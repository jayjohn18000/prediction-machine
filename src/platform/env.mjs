import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

let loaded = false;

/**
 * Load environment variables from the repo's .env file into process.env.
 * Uses dotenv under the hood; does not overwrite existing variables by default.
 *
 * @param {object} [options]
 * @param {string} [options.path] - Optional explicit path to an env file.
 * @param {boolean} [options.reload] - If true, re-run dotenv even if already loaded.
 */
export function loadEnv(options = {}) {
  if (loaded && !options.reload) return;

  const envPath = options.path ?? path.join(PROJECT_ROOT, '.env');

  dotenv.config({
    path: envPath,
    override: false,
  });

  loaded = true;
}

