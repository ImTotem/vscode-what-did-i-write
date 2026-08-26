const assert = require('node:assert/strict');

const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('local-only.what-did-i-write');
  assert.ok(extension, 'local-only.what-did-i-write must be discoverable in the Extension Host');

  await extension.activate();
  assert.equal(extension.isActive, true, 'local-only.what-did-i-write must activate');

  const commands = await vscode.commands.getCommands(true);
  const requiredCommands = ['myCode.refresh', 'myCode.focusFileHistory', 'myCode.focusLineHistory', 'myCode.expandAll', 'myCode.collapseAll', 'myCode.hideDecorations', 'myCode.showDecorations', 'myCode.openToSide', 'myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.cut', 'myCode.copy', 'myCode.paste', 'myCode.newFile', 'myCode.newFolder', 'myCode.rename', 'myCode.delete'];
  for (const command of requiredCommands) {
    assert.ok(commands.includes(command), `${command} must be registered after activation`);
  }
  assert.ok(commands.includes('list.collapseAll'), 'VS Code must provide list.collapseAll');

  const activityBarContainers = extension.packageJSON?.contributes?.viewsContainers?.activitybar ?? [];
  assert.ok(
    activityBarContainers.some((container) => container.id === 'myCode'),
    'MY CODE Activity Bar container contribution must be present'
  );
  const myCodeViews = extension.packageJSON?.contributes?.views?.myCode ?? [];
  assert.ok(
    myCodeViews.some((view) => view.id === 'myCode.explorer'),
    'MY CODE view must belong to its independent Activity Bar container'
  );
  assert.ok(
    myCodeViews.some((view) => view.id === 'myCode.pastActivity' && view.visibility === 'collapsed'),
    'PAST ACTIVITY must be a collapsed sibling view in the MY CODE container'
  );
  assert.ok(
    myCodeViews.some((view) => view.id === 'myCode.history' && view.type === 'webview'),
    'FILE HISTORY webview must belong to the MY CODE container'
  );
  const explorerViews = extension.packageJSON?.contributes?.views?.explorer ?? [];
  assert.equal(
    explorerViews.some((view) => view.id === 'myCode.explorer'),
    false,
    'MY CODE view must not be contributed to Explorer'
  );

  await vscode.commands.executeCommand('myCode.refresh');
  await vscode.commands.executeCommand('myCode.focusFileHistory');
  await vscode.commands.executeCommand('myCode.focusLineHistory');
  await vscode.commands.executeCommand('myCode.explorer.focus');
  await vscode.commands.executeCommand('list.collapseAll');
  await vscode.commands.executeCommand('myCode.pastActivity.focus');
}

module.exports = { run };
