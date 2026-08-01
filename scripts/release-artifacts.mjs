#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function filesBelow(root) {
  const out = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) out.push(filename);
    }
  };
  visit(root);
  return out;
}

function isReleaseAsset(filename) {
  const normalized = filename.split(path.sep).join('/');
  if (/\.app\//.test(normalized)) return false;
  return /(?:\.AppImage|\.deb|\.rpm|\.dmg|\.msi|\.exe|\.app\.tar\.gz|\.AppImage\.tar\.gz|\.nsis\.zip|\.sig)$/i.test(filename);
}

function collect(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`bundle directory does not exist: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  const assets = filesBelow(source).filter(isReleaseAsset);
  if (!assets.length) throw new Error(`no release assets found below ${source}`);
  for (const asset of assets) {
    const output = path.join(destination, path.basename(asset));
    if (fs.existsSync(output)) throw new Error(`duplicate release asset name: ${path.basename(asset)}`);
    fs.copyFileSync(asset, output, fs.constants.COPYFILE_EXCL);
  }
  process.stdout.write(`${assets.length} release assets collected\n`);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function single(files, pattern, label) {
  const found = files.filter(filename => pattern.test(path.basename(filename)));
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${label} updater archive, found ${found.length}`);
  }
  return found[0];
}

function updaterEntry(archive, repository, tag) {
  const signaturePath = `${archive}.sig`;
  if (!fs.existsSync(signaturePath)) throw new Error(`missing updater signature: ${path.basename(signaturePath)}`);
  const signature = fs.readFileSync(signaturePath, 'utf8').trim();
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(signature) || signature.length < 64) {
    throw new Error(`invalid updater signature: ${path.basename(signaturePath)}`);
  }
  const name = path.basename(archive);
  return {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}

function generate(source, destination, version, repository, gitSha) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid release version: ${version}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid GitHub repository');
  const files = filesBelow(source).filter(filename => !/latest\.json|release-manifest\.json|SHA256SUMS/.test(path.basename(filename)));
  const requireAsset = (pattern, label) => {
    if (!files.some(filename => pattern.test(path.basename(filename)))) throw new Error(`missing ${label} installer`);
  };
  requireAsset(/\.AppImage$/i, 'Linux AppImage');
  requireAsset(/\.deb$/i, 'Linux deb');
  requireAsset(/\.dmg$/i, 'macOS dmg');
  requireAsset(/\.msi$/i, 'Windows msi');
  requireAsset(/\.exe$/i, 'Windows NSIS');

  const linux = single(files, /\.AppImage\.tar\.gz$/i, 'Linux');
  const mac = single(files, /\.app\.tar\.gz$/i, 'macOS');
  const windows = single(files, /\.nsis\.zip$/i, 'Windows');
  const tag = `v${version}`;
  const publishedAt = new Date().toISOString();
  const latest = {
    version,
    notes: `Harmolyn ${version}`,
    pub_date: publishedAt,
    platforms: {
      'linux-x86_64': updaterEntry(linux, repository, tag),
      'darwin-x86_64': updaterEntry(mac, repository, tag),
      'darwin-aarch64': updaterEntry(mac, repository, tag),
      'windows-x86_64': updaterEntry(windows, repository, tag),
    },
  };
  const manifestAssets = files
    .map(filename => ({
      name: path.basename(filename),
      size: fs.statSync(filename).size,
      sha256: sha256(filename),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    schema: 1,
    product: 'Harmolyn',
    version,
    tag,
    git_sha: gitSha,
    built_at: publishedAt,
    repository,
    assets: manifestAssets,
  };
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  fs.writeFileSync(path.join(destination, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(destination, 'SHA256SUMS'),
    `${manifestAssets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n')}\n`,
  );
  process.stdout.write(`${manifestAssets.length} assets verified; update manifest generated\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'collect' && args.length === 2) collect(path.resolve(args[0]), path.resolve(args[1]));
else if (command === 'generate' && args.length === 5) {
  generate(path.resolve(args[0]), path.resolve(args[1]), args[2], args[3], args[4]);
} else {
  throw new Error('usage: release-artifacts.mjs collect <bundle-dir> <output-dir> | generate <asset-dir> <output-dir> <version> <owner/repo> <git-sha>');
}
