import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class Uri {
    public constructor(public readonly scheme: string, public readonly fsPath: string) {}
    public static file(path: string): Uri { return new Uri('file', path); }
  }
  return { Uri };
});

vi.mock('vscode', () => ({ Uri: mocks.Uri }));

import type { HistoryTimelineModel } from '../../src/ui/historyController.js';
import { HistoryTimelineViewProvider, renderTimelineHtml } from '../../src/ui/historyTimeline.js';

const ROOT = 'C:/repo';

describe('renderTimelineHtml', () => {
  it('renders working changes before a visible newest-to-oldest commit rail and escapes Git text', () => {
    const html = renderTimelineHtml({ kind: 'ready', model: timelineModel() }, 'nonce-1', 'vscode-resource:');

    expect(html.indexOf('Current changes')).toBeLessThan(html.indexOf('LATEST'));
    expect(html).toContain('aria-label="Newest to oldest"');
    expect(html).toContain('timeline-rail');
    expect(html).toContain('LATEST');
    expect(html).toContain('Older');
    expect(html).toContain('default-src &#39;none&#39;');
    expect(html).toContain("script-src &#39;nonce-nonce-1&#39;");
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders explicit loading, empty, and error states', () => {
    expect(renderTimelineHtml({ kind: 'loading' }, 'n', 'vscode-resource:')).toContain('Loading history');
    expect(renderTimelineHtml({ kind: 'empty', path: 'src/empty.ts' }, 'n', 'vscode-resource:')).toContain('No matching commits');
    expect(renderTimelineHtml({ kind: 'error', message: '<bad>' }, 'n', 'vscode-resource:')).toContain('&lt;bad&gt;');
  });
});

describe('HistoryTimelineViewProvider', () => {
  it('focuses file or line history, ignores generated diffs, and validates selection ids', async () => {
    const model = timelineModel();
    const history = {
      getTimeline: vi.fn(async () => model),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const provider = new HistoryTimelineViewProvider(history);
    const view = fakeView();
    provider.resolveWebviewView(view.value);

    await provider.focus('C:/repo/src/time.h', 4);
    expect(history.getTimeline).toHaveBeenCalledWith('C:/repo/src/time.h', 4);
    expect(view.webview.html).toContain('LINE 5');

    const callsBeforeDiff = history.getTimeline.mock.calls.length;
    provider.followEditor(editor('my-code-git', '/revision'));
    await flush();
    expect(history.getTimeline).toHaveBeenCalledTimes(callsBeforeDiff);

    provider.followEditor(editor('file', 'C:/repo/src/other.h'));
    await flush();
    expect(history.getTimeline).toHaveBeenLastCalledWith('C:/repo/src/other.h', undefined);

    view.receive({ type: 'select', id: 'unknown' });
    await flush();
    expect(history.openTimelineEntry).not.toHaveBeenCalled();
    view.receive({ type: 'select', id: model.entries[1]?.id });
    await flush();
    expect(history.openTimelineEntry).toHaveBeenCalledWith(model, model.entries[1]?.id);
    provider.dispose();
  });

  it('does not let an older async refresh overwrite the newest target', async () => {
    const first = deferred<HistoryTimelineModel | undefined>();
    const second = deferred<HistoryTimelineModel | undefined>();
    const newer = { ...timelineModel(), relativePath: 'src/newer.h', sourcePath: 'C:/repo/src/newer.h' };
    const history = {
      getTimeline: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const provider = new HistoryTimelineViewProvider(history);
    const view = fakeView();
    provider.resolveWebviewView(view.value);

    const oldRefresh = provider.focus('C:/repo/src/old.h');
    const newRefresh = provider.focus('C:/repo/src/newer.h');
    second.resolve(newer);
    await newRefresh;
    first.resolve(timelineModel());
    await oldRefresh;

    expect(view.webview.html).toContain('src/newer.h');
    expect(view.webview.html).not.toContain('class="path">src/time.h');
    provider.dispose();
  });

  it('invalidates the previous model while a new target is loading', async () => {
    const next = deferred<HistoryTimelineModel | undefined>();
    const history = {
      getTimeline: vi.fn()
        .mockResolvedValueOnce(timelineModel())
        .mockReturnValueOnce(next.promise),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const provider = new HistoryTimelineViewProvider(history);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');

    const switching = provider.focus('C:/repo/src/newer.h');
    expect(view.webview.html).toContain('Loading history');
    view.receive({ type: 'select', id: 'commit:newest' });
    await flush();
    expect(history.openTimelineEntry).not.toHaveBeenCalled();

    next.resolve({ ...timelineModel(), relativePath: 'src/newer.h', sourcePath: 'C:/repo/src/newer.h' });
    await switching;
    expect(view.webview.html).toContain('src/newer.h');
    provider.dispose();
  });

  it('reports message-triggered diff failures instead of leaving an unhandled rejection', async () => {
    const failure = new Error('cannot open <diff>');
    const onError = vi.fn();
    const history = {
      getTimeline: vi.fn(async () => timelineModel()),
      openTimelineEntry: vi.fn(async () => { throw failure; })
    };
    const provider = new HistoryTimelineViewProvider(history, onError);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');

    view.receive({ type: 'select', id: 'commit:newest' });
    await flush();

    expect(onError).toHaveBeenCalledWith(failure, 'open-history-diff', 'src/time.h');
    expect(view.webview.html).toContain('History unavailable');
    expect(view.webview.html).toContain('cannot open &lt;diff&gt;');
    provider.dispose();
  });
  it('detaches a disposed view and safely refreshes, follows, and resolves a replacement', async () => {
    const newer = { ...timelineModel(), relativePath: 'src/newer.h', sourcePath: 'C:/repo/src/newer.h' };
    const history = {
      getTimeline: vi.fn()
        .mockResolvedValueOnce(timelineModel())
        .mockResolvedValueOnce(timelineModel())
        .mockResolvedValueOnce(newer),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const provider = new HistoryTimelineViewProvider(history);
    const first = fakeView();
    provider.resolveWebviewView(first.value);
    await provider.focus('C:/repo/src/time.h');

    first.dispose();
    await expect(provider.refresh()).resolves.toBeUndefined();
    provider.followEditor(editor('file', 'C:/repo/src/newer.h'));
    await flush();

    const second = fakeView();
    provider.resolveWebviewView(second.value);
    expect(second.webview.html).toContain('src/newer.h');
    first.receive({ type: 'select', id: 'commit:newest' });
    await flush();
    expect(history.openTimelineEntry).not.toHaveBeenCalled();
    second.receive({ type: 'select', id: 'commit:newest' });
    await flush();
    expect(history.openTimelineEntry).toHaveBeenCalledTimes(1);
    provider.dispose();
  });
});

function timelineModel(): HistoryTimelineModel {
  const newest = {
    hash: 'bbbbbbb22222222', authorName: 'Me <script>', authorEmail: 'me@example.com',
    authoredAt: 1_700_000_100, subject: '<script>alert(1)</script>'
  };
  const older = {
    hash: 'aaaaaaa11111111', authorName: 'Me', authorEmail: 'me@example.com',
    authoredAt: 1_700_000_000, subject: 'Older change'
  };
  return {
    root: ROOT,
    head: 'f'.repeat(40),
    sourcePath: 'C:/repo/src/time.h',
    sourceExists: true,
    relativePath: 'src/time.h',
    mode: 'line',
    line: 4,
    commitLine: 4,
    entries: [
      {
        id: 'working', kind: 'working', title: 'Current changes', detail: 'M src/time.h',
        headPath: 'src/time.h', workingPath: 'src/time.h', exists: true, headExists: true
      },
      {
        id: 'commit:newest', kind: 'commit', title: newest.subject, relativeDate: '2 minutes ago',
        authoredAt: newest.authoredAt, latest: true, commit: newest, path: 'src/time.h', parentPath: 'src/time.h'
      },
      {
        id: 'commit:older', kind: 'commit', title: older.subject, relativeDate: '1 day ago',
        authoredAt: older.authoredAt, latest: false, commit: older, path: 'src/time.h', parentPath: 'src/time.h'
      }
    ]
  };
}

function fakeView() {
  let listener: ((message: unknown) => unknown) | undefined;
  let disposeListener: (() => unknown) | undefined;
  let disposed = false;
  let html = '';
  const webview = {
    get html() { return html; },
    set html(value: string) {
      if (disposed) throw new Error('disposed webview cannot render');
      html = value;
    },
    options: {} as vscode.WebviewOptions,
    cspSource: 'vscode-resource:',
    onDidReceiveMessage: (next: (message: unknown) => unknown) => {
      listener = next;
      return { dispose: () => { listener = undefined; } };
    }
  };
  return {
    webview,
    value: {
      webview,
      onDidDispose: (next: () => unknown) => {
        disposeListener = next;
        return { dispose: () => { disposeListener = undefined; } };
      }
    } as unknown as vscode.WebviewView,
    receive: (message: unknown) => listener?.(message),
    dispose: () => {
      disposed = true;
      disposeListener?.();
    }
  };
}

function editor(scheme: string, fsPath: string): vscode.TextEditor {
  return { document: { uri: new mocks.Uri(scheme, fsPath) } } as unknown as vscode.TextEditor;
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value: T) => resolvePromise?.(value) };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
