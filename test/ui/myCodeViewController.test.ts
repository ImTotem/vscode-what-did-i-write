import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  const executeCommand = vi.fn(async (..._args: unknown[]) => undefined);
  const configuration = {
    visualsEnabled: true,
    updates: [] as unknown[][],
    update: vi.fn(),
    scmWorkspaceValue: 'gutter' as string | undefined,
    scmUpdates: [] as unknown[][],
    scmUpdate: vi.fn()
  };
  return { executeCommand, configuration };
});

vi.mock('vscode', () => ({
  commands: { executeCommand: mocks.executeCommand },
  workspace: {
    getConfiguration: (section: string) => section === 'scm' ? ({
      inspect: () => ({ workspaceValue: mocks.configuration.scmWorkspaceValue }),
      update: (...args: unknown[]) => mocks.configuration.scmUpdate(...args)
    }) : ({
      get: <T>(key: string, fallback: T) => key === 'visuals.enabled'
        ? mocks.configuration.visualsEnabled as T
        : fallback,
      update: (...args: unknown[]) => mocks.configuration.update(...args)
    })
  },
  ConfigurationTarget: { Workspace: 2 }
}));

import { MyCodeViewController, VisualModeController } from '../../src/ui/myCodeViewController.js';

describe('MyCodeViewController', () => {
  beforeEach(() => {
    mocks.executeCommand.mockReset();
    mocks.executeCommand.mockResolvedValue(undefined);
  });

  it('always collapses MY CHANGES through the focused VS Code tree', async () => {
    const controller = new MyCodeViewController();
    mocks.executeCommand.mockClear();

    await controller.collapseAll();

    expect(mocks.executeCommand.mock.calls).toEqual([
      ['myCode.explorer.focus'],
      ['list.collapseAll']
    ]);
    controller.dispose();
  });

  it('surfaces a VS Code collapse failure without issuing expansion or context commands', async () => {
    const controller = new MyCodeViewController();
    mocks.executeCommand.mockClear();
    mocks.executeCommand.mockRejectedValueOnce(new Error('focus failed'));

    await expect(controller.collapseAll()).rejects.toThrow('focus failed');

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
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
    mocks.configuration.scmWorkspaceValue = 'gutter';
    mocks.configuration.scmUpdates.splice(0);
    mocks.configuration.scmUpdate.mockReset();
    mocks.configuration.scmUpdate.mockImplementation(async (...args: unknown[]) => {
      mocks.configuration.scmUpdates.push(args);
      mocks.configuration.scmWorkspaceValue = args[1] as string | undefined;
    });
  });

  it('toggles file, background, and native quick diff visuals without changing built-in SCM settings', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const quickDiff = { setEnabled: vi.fn(async () => undefined) };
    const state = memoryState();
    const controller = new VisualModeController(decorations, editors, state, quickDiff);
    await flush();

    expect(mocks.configuration.scmUpdates).toEqual([]);
    expect(quickDiff.setEnabled).toHaveBeenCalledWith(true);

    await controller.setEnabled(false);

    expect(mocks.configuration.scmUpdates).toEqual([]);
    expect(decorations.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(editors.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(quickDiff.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.visualsEnabled', false]);
  });

  it('restores a legacy SCM setting snapshot once after upgrading from custom gutter mode', async () => {
    mocks.configuration.scmWorkspaceValue = 'none';
    const state = memoryState();
    await state.update('myCode.visuals.previousScmDiffDecorations', {
      hasWorkspaceValue: false
    });
    new VisualModeController(
      { setEnabled: vi.fn() },
      { setEnabled: vi.fn(async () => undefined) },
      state
    );
    await flush();

    expect(mocks.configuration.scmUpdates).toEqual([['diffDecorations', undefined, 2]]);
    expect(state.get('myCode.visuals.previousScmDiffDecorations')).toBeUndefined();
  });

  it('does not restore a stale crash snapshot over a newer SCM setting when starting OFF', async () => {
    mocks.configuration.visualsEnabled = false;
    mocks.configuration.scmWorkspaceValue = 'overview';
    const state = memoryState();
    await state.update('myCode.visuals.previousScmDiffDecorations', {
      hasWorkspaceValue: true,
      value: 'gutter'
    });
    new VisualModeController(
      { setEnabled: vi.fn() },
      { setEnabled: vi.fn(async () => undefined) },
      state
    );
    await flush();

    expect(mocks.configuration.scmWorkspaceValue).toBe('overview');
    expect(mocks.configuration.scmUpdates).toEqual([]);
    expect(state.get('myCode.visuals.previousScmDiffDecorations')).toBeUndefined();
  });

  it('keeps native quick diff enabled when a newer ON overtakes an in-flight OFF repaint', async () => {
    const offRepaint = deferred<void>();
    const state = memoryState();
    const editors = { setEnabled: vi.fn((enabled: boolean) => enabled ? Promise.resolve() : offRepaint.promise) };
    const quickDiff = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController({ setEnabled: vi.fn() }, editors, state, quickDiff);
    await controller.setEnabled(true);

    const off = controller.setEnabled(false);
    await flush();
    const on = controller.setEnabled(true);
    await on;
    offRepaint.resolve();
    await off;

    expect(quickDiff.setEnabled.mock.calls.at(-1)).toEqual([true]);
    expect(mocks.configuration.scmUpdates).toEqual([]);
    expect(state.get('myCode.visuals.previousScmDiffDecorations')).toBeUndefined();
  });

  it('persists a toggle at Workspace scope and applies it to every visual layer', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const quickDiff = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController(decorations, editors, undefined, quickDiff);
    await flush();
    decorations.setEnabled.mockClear();
    editors.setEnabled.mockClear();
    quickDiff.setEnabled.mockClear();
    mocks.executeCommand.mockClear();

    await controller.toggle();

    expect(mocks.configuration.updates).toEqual([['visuals.enabled', false, 2]]);
    expect(decorations.setEnabled).toHaveBeenCalledWith(false);
    expect(editors.setEnabled).toHaveBeenCalledWith(false);
    expect(quickDiff.setEnabled).toHaveBeenCalledWith(false);
    expect(mocks.executeCommand).toHaveBeenCalledWith('setContext', 'myCode.visualsEnabled', false);
  });

  it('applies external configuration changes through the same decoration path', async () => {
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const quickDiff = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController(decorations, editors, undefined, quickDiff);
    await flush();
    decorations.setEnabled.mockClear();
    editors.setEnabled.mockClear();
    quickDiff.setEnabled.mockClear();
    mocks.configuration.visualsEnabled = false;

    await controller.acceptConfigurationChange();

    expect(decorations.setEnabled).toHaveBeenCalledWith(false);
    expect(editors.setEnabled).toHaveBeenCalledWith(false);
    expect(quickDiff.setEnabled).toHaveBeenCalledWith(false);
  });


  it('keeps an immediate OFF toggle after a deferred initial repaint settles', async () => {
    const initialRepaint = deferred<void>();
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn((enabled: boolean) => enabled
      ? initialRepaint.promise
      : Promise.resolve()) };
    const controller = new VisualModeController(decorations, editors);
    await flush();

    const toggle = controller.toggle();
    await flush();
    initialRepaint.resolve();
    await toggle;
    await flush();

    expect(decorations.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(editors.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.visualsEnabled', false]);
  });

  it('keeps a newer OFF toggle after an in-flight initial context write settles', async () => {
    const staleContext = deferred<void>();
    const completedContexts: boolean[] = [];
    mocks.executeCommand.mockImplementation((command, _key, value) => {
      if (command !== 'setContext') return Promise.resolve(undefined);
      if (value === true) return staleContext.promise.then(() => { completedContexts.push(true); return undefined; });
      completedContexts.push(value as boolean);
      return Promise.resolve(undefined);
    });
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const controller = new VisualModeController(decorations, editors);
    await flush();

    const toggle = controller.toggle();
    await flush();
    staleContext.resolve();
    await toggle;
    await flush();

    expect(decorations.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(editors.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(completedContexts.at(-1)).toBe(false);
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

  it('keeps configured visuals OFF when legacy SCM restoration fails', async () => {
    mocks.configuration.visualsEnabled = false;
    mocks.configuration.scmWorkspaceValue = 'none';
    const state = memoryState();
    await state.update('myCode.visuals.previousScmDiffDecorations', {
      hasWorkspaceValue: true,
      value: 'gutter'
    });
    const failure = new Error('SCM update failed');
    mocks.configuration.scmUpdate.mockRejectedValueOnce(failure);
    const decorations = { setEnabled: vi.fn() };
    const editors = { setEnabled: vi.fn(async () => undefined) };
    const quickDiff = { setEnabled: vi.fn(async () => undefined) };
    const onError = vi.fn();

    new VisualModeController(decorations, editors, state, quickDiff, onError);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

    expect(decorations.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(editors.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(quickDiff.setEnabled.mock.calls.at(-1)).toEqual([false]);
    expect(mocks.executeCommand.mock.calls.at(-1)).toEqual(['setContext', 'myCode.visualsEnabled', false]);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(state.get('myCode.visuals.previousScmDiffDecorations')).toEqual({
      hasWorkspaceValue: true,
      value: 'gutter'
    });
  });
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();

}
function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value),
    reject: (reason: unknown) => rejectPromise?.(reason)
  };
}

function memoryState(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    }
  };
}
