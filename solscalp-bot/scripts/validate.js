#!/usr/bin/env node

/**
 * ASTRA Session Validator
 *
 * Phase 1: Discover all .js files in project (excludes node_modules/, scripts/)
 * Phase 2: Syntax check via `node --check`
 * Phase 3: Runtime boot test via dynamic import() (skips index.js)
 *
 * Output: JSON to stdout. Exit code 0 = PASS, 1 = FAIL.
 */

import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Directories to scan for .js files
const SCAN_DIRS = [
  '.',
  'strategies',
  'monitor',
  'analysis',
  'utils',
  'config',
  'store',
  'jupiter',
  'wallet',
  'dexscreener',
  'pumpfun',
  'api',
];

const SKIP_DIRS = new Set(['node_modules', 'scripts', 'logs', 'data', '.claude']);
const SKIP_BOOT = new Set(['index.js']); // index.js calls main() at module level

// ── Phase 1: File Discovery ──

function discoverFiles() {
  const files = new Set();

  for (const dir of SCAN_DIRS) {
    const fullDir = join(PROJECT_ROOT, dir);
    try {
      const entries = readdirSync(fullDir);
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const fullPath = join(fullDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && entry.endsWith('.js')) {
            files.add(relative(PROJECT_ROOT, fullPath).replace(/\\/g, '/'));
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch { /* dir doesn't exist, skip */ }
  }

  return [...files].sort();
}

// ── Phase 2: Syntax Check ──

function syntaxCheck(files) {
  const result = { passed: 0, failed: 0, errors: [] };

  for (const file of files) {
    const fullPath = join(PROJECT_ROOT, file);
    try {
      execSync(`node --check "${fullPath}"`, {
        stdio: 'pipe',
        timeout: 10_000,
      });
      result.passed++;
    } catch (err) {
      result.failed++;
      const stderr = err.stderr?.toString().trim() || err.message;
      result.errors.push({ file, error: stderr });
    }
  }

  return result;
}

// ── Phase 3: Runtime Boot Test ──

async function bootTest(files) {
  const result = { passed: 0, failed: 0, skipped: [], errors: [] };

  // Load dotenv before boot tests so env vars are available
  try {
    process.chdir(PROJECT_ROOT);
    await import(pathToFileURL(join(PROJECT_ROOT, 'node_modules', 'dotenv', 'config.js')).href);
  } catch {
    // dotenv not available or .env missing — continue anyway
  }

  for (const file of files) {
    if (SKIP_BOOT.has(file)) {
      result.skipped.push(file);
      continue;
    }

    const fullPath = join(PROJECT_ROOT, file);
    try {
      // Use unique query string to bust module cache on re-runs
      await import(pathToFileURL(fullPath).href + '?t=' + Date.now());
      result.passed++;
    } catch (err) {
      result.failed++;
      const msg = err.message || String(err);
      // Extract the useful part of the error
      const code = err.code || '';
      result.errors.push({ file, error: msg, code });
    }
  }

  return result;
}

// ── Main ──

async function main() {
  const files = discoverFiles();
  const syntax = syntaxCheck(files);
  const boot = await bootTest(files);

  const hasFail = syntax.failed > 0 || boot.failed > 0;
  const status = hasFail ? 'FAIL' : 'PASS';

  const output = {
    timestamp: new Date().toISOString(),
    filesChecked: files.length,
    syntax,
    boot,
    status,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(hasFail ? 1 : 0);
}

main();
