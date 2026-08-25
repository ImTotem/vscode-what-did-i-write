const assert = require('node:assert/strict');

const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('local-only.my-code');
  assert.ok(extension, 'local-only.my-code must be discoverable in the Extension Host');

  await extension.activate();
  assert.equal(extension.isActive, true, 'local-only.my-code must activate');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('myCode.refresh'), 'myCode.refresh must be registered after activation');

  const explorerViews = extension.packageJSON?.contributes?.views?.explorer ?? [];
  assert.ok(
    explorerViews.some((view) => view.id === 'myCode.explorer'),
    'MY CODE Explorer view contribution must be present'
  );

  await vscode.commands.executeCommand('myCode.refresh');
}

module.exports = { run };
