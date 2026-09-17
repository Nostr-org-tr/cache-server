#!/usr/bin/env node

/**
 * Automated Version Bumping & Synchronization Tool
 * 
 * Supports SemVer 2.0.0 increments (patch, minor, major, prepatch, preminor, premajor, prerelease)
 * or explicit target version setting.
 * Synchronizes package.json, package-lock.json, and src/version.ts in lockstep.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  gray: '\x1b[90m',
};

interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

function parseSemVer(version: string): ParsedSemVer {
  const match = SEMVER_REGEX.exec(version);
  if (!match) {
    throw new Error(`Invalid SemVer format: "${version}"`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
    build: match[5],
  };
}

function stringifySemVer(parsed: ParsedSemVer): string {
  let result = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (parsed.prerelease) {
    result += `-${parsed.prerelease}`;
  }
  if (parsed.build) {
    result += `+${parsed.build}`;
  }
  return result;
}

function calculateNextVersion(
  current: string,
  bumpType: string,
  preId: string = 'beta'
): string {
  const parsed = parseSemVer(current);

  switch (bumpType.toLowerCase()) {
    case 'major':
      return `${parsed.major + 1}.0.0`;
    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case 'patch':
      if (parsed.prerelease) {
        // If coming from prerelease e.g. 1.0.1-beta.0, patch resolves to 1.0.1
        return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
      }
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    case 'premajor':
      return `${parsed.major + 1}.0.0-${preId}.0`;
    case 'preminor':
      return `${parsed.major}.${parsed.minor + 1}.0-${preId}.0`;
    case 'prepatch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-${preId}.0`;
    case 'prerelease': {
      if (!parsed.prerelease) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-${preId}.0`;
      }
      // Increment existing prerelease sequence
      const parts = parsed.prerelease.split('.');
      const lastPart = parts[parts.length - 1];
      const lastNum = parseInt(lastPart, 10);
      if (!Number.isNaN(lastNum)) {
        parts[parts.length - 1] = String(lastNum + 1);
        return `${parsed.major}.${parsed.minor}.${parsed.patch}-${parts.join('.')}`;
      }
      return `${parsed.major}.${parsed.minor}.${parsed.patch}-${parsed.prerelease}.1`;
    }
    default:
      // If an explicit version string is passed, validate and return it
      if (SEMVER_REGEX.test(bumpType)) {
        return bumpType;
      }
      throw new Error(
        `Unknown bump type or invalid SemVer string: "${bumpType}". Supported: patch, minor, major, prepatch, preminor, premajor, prerelease, or X.Y.Z`
      );
  }
}

function updatePackageJson(newVersion: string): void {
  const content = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  content.version = newVersion;
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  console.log(`  ${COLOR.green}✓${COLOR.reset} Updated package.json -> ${COLOR.bold}${newVersion}${COLOR.reset}`);
}

function updatePackageLock(newVersion: string): void {
  if (!existsSync(PACKAGE_LOCK_PATH)) {
    return;
  }
  const content = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, 'utf-8'));
  content.version = newVersion;
  if (content.packages && content.packages['']) {
    content.packages[''].version = newVersion;
  }
  writeFileSync(PACKAGE_LOCK_PATH, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  console.log(`  ${COLOR.green}✓${COLOR.reset} Updated package-lock.json -> ${COLOR.bold}${newVersion}${COLOR.reset}`);
}

function updateVersionTs(newVersion: string): void {
  let content = readFileSync(VERSION_TS_PATH, 'utf-8');
  const replaced = content.replace(
    /export const APP_VERSION = ['"][^'"]+['"];/,
    `export const APP_VERSION = '${newVersion}';`
  );
  if (content === replaced && !content.includes(`APP_VERSION = '${newVersion}'`)) {
    throw new Error('Failed to update APP_VERSION in src/version.ts');
  }
  writeFileSync(VERSION_TS_PATH, replaced, 'utf-8');
  console.log(`  ${COLOR.green}✓${COLOR.reset} Updated src/version.ts -> ${COLOR.bold}${newVersion}${COLOR.reset}`);
}

function printUsage(): void {
  console.log(`
${COLOR.bold}${COLOR.cyan}Version Bump CLI${COLOR.reset}
Usage:
  npm run version:bump [patch | minor | major | prepatch | preminor | premajor | prerelease | <semver>]
  make version-patch
  make version-minor
  make version-major
  make version-set VERSION=<semver>

Options:
  --preid=<identifier>   Prerelease identifier (default: "beta", e.g. "rc", "alpha")
  --dry-run              Calculate and display new version without modifying files
  --help, -h             Show this help message
`);
}

function main(): void {
  const args = process.argv.slice(2);
  let bumpType = 'patch';
  let preId = 'beta';
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--preid=')) {
      preId = arg.split('=')[1] || 'beta';
    } else if (!arg.startsWith('--')) {
      bumpType = arg;
    }
  }

  if (!existsSync(PACKAGE_JSON_PATH)) {
    console.error(`${COLOR.red}Error: package.json not found.${COLOR.reset}`);
    process.exit(1);
  }

  const pkgJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { version: string };
  const currentVersion = pkgJson.version;

  if (!currentVersion) {
    console.error(`${COLOR.red}Error: package.json has no version field.${COLOR.reset}`);
    process.exit(1);
  }

  let nextVersion: string;
  try {
    nextVersion = calculateNextVersion(currentVersion, bumpType, preId);
  } catch (err: unknown) {
    console.error(`${COLOR.red}Error:${COLOR.reset} ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`\n${COLOR.bold}${COLOR.cyan}=== Version Bump: ${currentVersion} -> ${nextVersion} ===${COLOR.reset}`);

  if (dryRun) {
    console.log(`\n${COLOR.yellow}[Dry Run] Target version would be: ${nextVersion}${COLOR.reset}\n`);
    process.exit(0);
  }

  try {
    updatePackageJson(nextVersion);
    updatePackageLock(nextVersion);
    updateVersionTs(nextVersion);
    console.log(`\n${COLOR.bold}${COLOR.green}Version successfully bumped to v${nextVersion}!${COLOR.reset}\n`);
  } catch (err: unknown) {
    console.error(`\n${COLOR.red}Failed to apply version update:${COLOR.reset}`, (err as Error).message);
    process.exit(1);
  }
}

main();
