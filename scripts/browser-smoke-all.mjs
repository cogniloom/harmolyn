import { spawnSync } from 'child_process';
import process from 'process';

function run(command, args, expectedExitCode, label) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== expectedExitCode) {
    throw new Error(`${label} exited with ${result.status}; expected ${expectedExitCode}.`);
  }
}

run('node', ['./scripts/browser-native-smoke.mjs'], 0, 'native browser smoke happy path');
run('node', ['./scripts/browser-native-smoke.mjs', 'no-peers'], 0, 'native browser smoke no-peer path');
