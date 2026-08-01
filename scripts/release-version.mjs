#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');
const tauriPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(value) {
  const match = semverPattern.exec(value);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

function nextVersion(current, bump) {
  const version = parseVersion(current);
  if (bump === 'stable') {
    if (!version.prerelease) throw new Error(`${current} is already stable; choose patch, minor, or major`);
    return `${version.major}.${version.minor}.${version.patch}`;
  }
  if (bump === 'patch') return `${version.major}.${version.minor}.${version.patch + 1}`;
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`;
  if (bump === 'major') return `${version.major + 1}.0.0`;
  throw new Error(`unsupported release bump: ${bump}`);
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function cargoVersion() {
  const source = fs.readFileSync(cargoPath, 'utf8');
  const packageBlock = source.match(/\[package\][\s\S]*?(?=\n\[|$)/)?.[0];
  const version = packageBlock?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('could not read src-tauri/Cargo.toml package version');
  return version;
}

function cargoLockVersion() {
  const source = fs.readFileSync(cargoLockPath, 'utf8');
  const version = source.match(/\[\[package\]\]\nname = "harmolyn"\nversion = "([^"]+)"/)?.[1];
  if (!version) throw new Error('could not read src-tauri/Cargo.lock package version');
  return version;
}

function setCargoVersion(version) {
  const source = fs.readFileSync(cargoPath, 'utf8');
  let replaced = false;
  const next = source.replace(/(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m, (_all, before, _old, after) => {
    replaced = true;
    return `${before}${version}${after}`;
  });
  if (!replaced) throw new Error('could not update src-tauri/Cargo.toml package version');
  fs.writeFileSync(cargoPath, next);

  const lockSource = fs.readFileSync(cargoLockPath, 'utf8');
  let lockReplaced = false;
  const lockNext = lockSource.replace(/(\[\[package\]\]\nname = "harmolyn"\nversion = ")([^"]+)(")/, (_all, before, _old, after) => {
    lockReplaced = true;
    return `${before}${version}${after}`;
  });
  if (!lockReplaced) throw new Error('could not update src-tauri/Cargo.lock package version');
  fs.writeFileSync(cargoLockPath, lockNext);
}

function versions() {
  const pkg = readJson(packagePath);
  const lock = readJson(lockPath);
  const tauri = readJson(tauriPath);
  return {
    package: pkg.version,
    lock: lock.version,
    lockRoot: lock.packages?.['']?.version,
    cargo: cargoVersion(),
    cargoLock: cargoLockVersion(),
    tauri: tauri.version,
  };
}

function assertSynchronized() {
  const found = versions();
  const unique = new Set(Object.values(found));
  if (unique.size !== 1 || [...unique][0] === undefined) {
    throw new Error(`release versions are inconsistent: ${JSON.stringify(found)}`);
  }
  parseVersion(found.package);
  return found.package;
}

function update(version) {
  parseVersion(version);
  const pkg = readJson(packagePath);
  pkg.name = 'harmolyn';
  pkg.version = version;
  writeJson(packagePath, pkg);

  const lock = readJson(lockPath);
  lock.name = 'harmolyn';
  lock.version = version;
  if (!lock.packages?.['']) throw new Error('package-lock.json has no root package');
  lock.packages[''].name = 'harmolyn';
  lock.packages[''].version = version;
  writeJson(lockPath, lock);

  const tauri = readJson(tauriPath);
  tauri.version = version;
  writeJson(tauriPath, tauri);
  setCargoVersion(version);
  return assertSynchronized();
}

const command = process.argv[2] ?? '--check';
if (command === '--check') {
  process.stdout.write(`${assertSynchronized()}\n`);
} else if (command === '--set') {
  const requested = process.argv[3];
  if (!requested) throw new Error('--set requires a semantic version');
  process.stdout.write(`${update(requested)}\n`);
} else {
  const current = readJson(packagePath).version;
  process.stdout.write(`${update(nextVersion(current, command))}\n`);
}
