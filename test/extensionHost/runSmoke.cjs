const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { runTests } = require('@vscode/test-electron');

const root = resolve(__dirname, '..', '..');
const smokeRoot = mkdtempSync(join(tmpdir(), 'my-code-extension-host-'));
const userDataDir = join(smokeRoot, 'user-data');
const extensionsDir = join(smokeRoot, 'extensions');
const workspaceDir = join(smokeRoot, 'workspace');

async function main() {
  try {
    const exitCode = await runTests({
      version: '1.133.0',
      platform: 'win32-x64-archive',
      cachePath: join(root, '.vscode-test'),
      extensionDevelopmentPath: root,
      extensionTestsPath: join(__dirname, 'smokeSuite.cjs'),
      launchArgs: [
        workspaceDir,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-extensions'
      ]
    });
    if (exitCode !== 0) throw new Error(`Extension Host smoke exited with code ${exitCode}`);
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
