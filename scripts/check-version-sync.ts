#!/usr/bin/env node

/**
 * Version Synchronization Checker
 * 
 * Asserts that package.json, package-lock.json, and src/version.ts
 * are strictly in sync and conform to SemVer 2.0.0.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT_DIR = resolve(process.cwd());
const PACKAGE_JSON_PATH = resolve(ROOT_DIR, 'package.json');
const PACKAGE_LOCK_PATH = resolve(ROOT_DIR, 'package-lock.json');
const VERSION_TS_PATH = resolve(ROOT_DIR, 'src/version.ts');

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Terminal colors
const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function main(): void {
  console.log(`${COLOR.bold}${COLOR.cyan}Checking project version consistency...${COLOR.reset}`);

  // 1. Read package.json
  if (!existsSync(PACKAGE_JSON_PATH)) {
    console.error(`${COLOR.red}Error: package.json not found at ${PACKAGE_JSON_PATH}${COLOR.reset}`);
    process.exit(1);
  }
  const pkgJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { version?: string };
  const pkgVersion = pkgJson.version;

  if (!pkgVersion) {
    console.error(`${COLOR.red}Error: No version field found in package.json${COLOR.reset}`);
    process.exit(1);
  }

  if (!SEMVER_REGEX.test(pkgVersion)) {
    console.error(`${COLOR.red}Error: package.json version "${pkgVersion}" is not a valid SemVer format${COLOR.reset}`);
    process.exit(1);
  }

  // 2. Read package-lock.json
  let lockVersion: string | undefined;
  if (existsSync(PACKAGE_LOCK_PATH)) {
    const lockJson = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, 'utf-8')) as {
      version?: string;
      packages?: { ''?: { version?: string } };
    };
    lockVersion = lockJson.version || lockJson.packages?.['']?.version;
  }

  // 3. Read src/version.ts
  if (!existsSync(VERSION_TS_PATH)) {
    console.error(`${COLOR.red}Error: src/version.ts not found at ${VERSION_TS_PATH}${COLOR.reset}`);
    process.exit(1);
  }
  const versionTsContent = readFileSync(VERSION_TS_PATH, 'utf-8');
  const match = /export const APP_VERSION = ['"]([^'"]+)['"]/.exec(versionTsContent);
  const tsVersion = match ? match[1] : undefined;

  if (!tsVersion) {
    console.error(`${COLOR.red}Error: Unable to parse APP_VERSION in src/version.ts${COLOR.reset}`);
    process.exit(1);
  }

  console.log(`  • package.json:     ${COLOR.bold}${pkgVersion}${COLOR.reset}`);
  console.log(`  • package-lock.json: ${COLOR.bold}${lockVersion ?? 'N/A'}${COLOR.reset}`);
  console.log(`  • src/version.ts:   ${COLOR.bold}${tsVersion}${COLOR.reset}`);

  let hasError = false;

  if (lockVersion && lockVersion !== pkgVersion) {
    console.error(
      `${COLOR.red}Mismatch: package-lock.json version (${lockVersion}) does not match package.json (${pkgVersion})${COLOR.reset}`
    );
    hasError = true;
  }

  if (tsVersion !== pkgVersion) {
    console.error(
      `${COLOR.red}Mismatch: src/version.ts APP_VERSION (${tsVersion}) does not match package.json (${pkgVersion})${COLOR.reset}`
    );
    hasError = true;
  }

  if (hasError) {
    console.error(`\n${COLOR.red}Version check failed. Run "make version-set VERSION=<ver>" or "npm run version:bump" to fix.${COLOR.reset}\n`);
    process.exit(1);
  }

  console.log(`\n${COLOR.green}✓ All version declarations are synchronized to v${pkgVersion} (SemVer valid).${COLOR.reset}\n`);
}

main();
