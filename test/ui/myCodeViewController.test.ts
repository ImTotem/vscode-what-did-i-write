import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    public fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
  }

  const executeCommand = vi.fn(async (..._args: unknown[]) => undefined);
  const configuration = { visualsEnabled: true, updates: [] as unknown[][], update: vi.fn() };
  return { EventEmitter, executeCommand, configuration };
});

vi.mock('vscode', () => ({
  commands: { executeCommand: mocks.executeCommand },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T) => key === 'visuals.enabled'
        ? mocks.configuration.visualsEnabled as T
        : fallback,
      update: (...args: unknown[]) => mocks.configuration.update(...args)
    })
  },
  ConfigurationTarget: { Workspace: 2 }
}));

import { MyCodeViewController, VisualModeController } from '../../src/ui/myCodeViewController.js';
import type { MyCodeNode } from '../../src/ui/myCodeTree.js';

describe('MyCodeViewController', () => {
  beforeEach(() => {
    mocks.executeCommand.mockReset();
    mocks.executeCommand.mockResolvedValue(undefined);
  });

  it('reveals every expandable node parent-first without stealing selection or focus', async () => {
    const fixture = treeFixture(['root', 'folder']);
    const controller = new MyCodeViewController(fixture.provider, fixture.view);
    await flush();
    mocks.executeCommand.mockClear();

    await controller.expandAll();

    expect(fixture.view.reveal).toHaveBeenNthCalledWith(1, fixture.nodes[0], { expand: true, select: false, focus: false });
    expect(fixture.view.reveal).toHaveBeenNthCalledWith(2, fixture.nodes[1], { expand: true, select: false, focus: false });
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'myCode.treeAllExpanded', true);
    controller.dispose();
  });

  it('uses VS Code collapse all only after focusing the provided tree view', async () => {
    const fixture = treeFixture(['root']);
    const controller = new MyCodeViewController(fixture.provider, fixture.view);
    await flush();
    mocks.executeCommand.mockClear();

    await controller.collapseAll();

    expect(mocks.executeCommand.mock.calls.slice(0, 3)).toEqual([
      ['myCode.explorer.focus'],
      ['list.collapseAll'],
      ['setContext', 'myCode.treeAllExpanded', false]
    ]);
    controller.dispose();
  });

  it('derives the title-action context from manual expansion and collapsed subtrees', async () => {
    const fixture = treeFixture(['root', 'folder']);
    const controller = new MyCodeViewController(fixture.provider, fixture.view);
    await flush();
    mocks.executeCommand.mockClear();

    fixture.expand(fixture.nodes[0]!);
    await flush();
    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.treeAllExpanded', false]);

    fixture.expand(fixture.nodes[1]!);
    await flush();
    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.treeAllExpanded', true]);

    fixture.collapse(fixture.nodes[0]!);
    await flush();
    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.treeAllExpanded', false]);
    controller.dispose();
  });

  it('resets derived expansion state on a tree rebuild without revealing the view', async () => {
    const fixture = treeFixture(['root']);
    const controller = new MyCodeViewController(fixture.provider, fixture.view);
    await controller.expandAll();
    fixture.view.reveal.mockClear();
    mocks.executeCommand.mockClear();

    fixture.rebuild();
    await flush();

    expect(fixture.view.reveal).not.toHaveBeenCalled();
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'myCode.treeAllExpanded', false);
    controller.dispose();
  });

  it('does not leave the all-expanded context set after a reveal fails', async () => {
    const fixture = treeFixture(['root', 'folder']);
    fixture.view.reveal.mockRejectedValueOnce(new Error('reveal failed'));
    const controller = new MyCodeViewController(fixture.provider, fixture.view);
    await flush();
    mocks.executeCommand.mockClear();

    await expect(controller.expandAll()).rejects.toThrow('reveal failed');

    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.treeAllExpanded', false]);
    controller.dispose();
  });
});

describe('VisualModeController', () => {
  beforeEach(() => {
    mocks.executeCommand.mockReset();
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.configuration.visualsEnabled = true;
    mocks.configuration.updates.splice(0);
    mocks.configuration.update.mockReset();
    mocks.configuration.update.mockImplementation(async (...args: unknown[]) => { mocks.configuration.updates.push(args); });
  });

  it('persists a toggle at Workspace scope and applies it to both decoration layers', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController(decorations, editors);
    await flush();
    decorations.setEnabled.mockClear();
    editors.setEnabled.mockClear();
    mocks.executeCommand.mockClear();

    await controller.toggle();

    expect(mocks.configuration.updates).toEqual([['visuals.enabled', false, 2]]);
    expect(decorations.setEnabled).toHaveBeenCalledWith(false);
    expect(editors.setEnabled).toHaveBeenCalledWith(false);
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'myCode.visualsEnabled', false);
  });

  it('applies external configuration changes through the same decoration path', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController(decorations, editors);
    await flush();
    decorations.setEnabled.mockClear();
    editors.setEnabled.mockClear();
    mocks.configuration.visualsEnabled = false;

    await controller.acceptConfigurationChange();

    expect(decorations.setEnabled).toHaveBeenCalledWith(false);
    expect(editors.setEnabled).toHaveBeenCalledWith(false);
  });

  it('restores visual state when the Workspace configuration write fails', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController(decorations, editors);
    await flush();
    decorations.setEnabled.mockClear();
    editors.setEnabled.mockClear();
    mocks.executeCommand.mockClear();
    mocks.configuration.update.mockRejectedValueOnce(new Error('configuration failed'));

    await expect(controller.toggle()).rejects.toThrow('configuration failed');

    expect(decorations.setEnabled.mock.calls).toEqual([[true]]);
    expect(editors.setEnabled.mock.calls).toEqual([[true]]);
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'myCode.visualsEnabled', true);
  });

  it('restores the configuration and both decoration layers when repainting fails', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async (enabled: boolean) => {
      if (!enabled) throw new Error('repaint failed');
    }) };
    const controller = new VisualModeController(decorations, editors);
    await flush();
    decorations.setEnabled.mockClear();
    editors.setEnabled.mockClear();
    mocks.executeCommand.mockClear();

    await expect(controller.toggle()).rejects.toThrow('repaint failed');

    expect(mocks.configuration.updates).toEqual([
      ['visuals.enabled', false, 2],
      ['visuals.enabled', true, 2]
    ]);
    expect(decorations.setEnabled.mock.calls).toEqual([[false], [true]]);
    expect(editors.setEnabled.mock.calls).toEqual([[false], [true]]);
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'myCode.visualsEnabled', true);
  });
});

function treeFixture(ids: readonly string[]) {
  const nodes = ids.map((id) => ({ id }) as unknown as MyCodeNode);
  const rebuildEmitter = new mocks.EventEmitter<MyCodeNode | undefined>();
  const expandedListeners = new Set<(event: { element: MyCodeNode }) => void>();
  const collapsedListeners = new Set<(event: { element: MyCodeNode }) => void>();
  const view = {
    reveal: vi.fn(async (_node: MyCodeNode, _options: unknown) => undefined),
    onDidExpandElement: (listener: (event: { element: MyCodeNode }) => void) => {
      expandedListeners.add(listener);
      return { dispose: () => expandedListeners.delete(listener) };
    },
    onDidCollapseElement: (listener: (event: { element: MyCodeNode }) => void) => {
      collapsedListeners.add(listener);
      return { dispose: () => collapsedListeners.delete(listener) };
    }
  } as unknown as vscode.TreeView<MyCodeNode> & { reveal: ReturnType<typeof vi.fn> };
  const provider = {
    expandableNodes: () => nodes,
    getParent: (node: MyCodeNode) => node.id === 'folder' ? nodes[0] : undefined,
    onDidChangeTreeData: rebuildEmitter.event
  };
  return {
    nodes,
    provider,
    view,
    expand: (node: MyCodeNode) => { for (const listener of expandedListeners) listener({ element: node }); },
    collapse: (node: MyCodeNode) => { for (const listener of collapsedListeners) listener({ element: node }); },
    rebuild: () => rebuildEmitter.fire(undefined)
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
