import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class Uri {
    public constructor(public readonly scheme: string, public readonly fsPath: string) {}
    public static file(path: string): Uri { return new Uri('file', path); }
  }
  const translate = vi.fn((message: string) => message);
  return { Uri, translate };
});

vi.mock('vscode', () => ({
  Uri: mocks.Uri,
  env: { language: 'en' },
  l10n: { t: mocks.translate }
}));

import type { HistoryTimelineModel } from '../../src/ui/historyController.js';
import { HistoryTimelineViewProvider, renderTimelineHtml } from '../../src/ui/historyTimeline.js';

const ROOT = 'C:/repo';

beforeEach(() => mocks.translate.mockImplementation((message: string) => message));

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

  it('renders file comparison guidance, an ORIGINAL state, and the selected BASE entry', () => {
    const html = renderTimelineHtml(
      { kind: 'ready', model: fileTimelineModel(), baseId: 'commit:older' },
      'nonce-1',
      'vscode-resource:'
    );

    expect(html).toContain('Right-click a history entry to set it as BASE');
    expect(html).toContain('Set as comparison base');
    expect(html).toContain('role="menu"');
    expect(html).toContain('ORIGINAL');
    expect(html).toContain('Before your first change');
    expect(html).toContain('BASE');
    expect(html).toContain('entry base');
    expect(html).toContain('data-base-badge');
    expect(html).toContain("window.addEventListener('message'");
  });

  it('positions the comparison menu through the nonce-authorized stylesheet instead of inline styles', () => {
    const html = renderTimelineHtml(
      { kind: 'ready', model: fileTimelineModel() },
      'nonce-1',
      'vscode-resource:'
    );

    expect(html).toContain('id="context-menu-position"');
    expect(html).toContain('positionSheet.sheet.cssRules[0]');
    expect(html).toContain('window.innerWidth - bounds.width');
    expect(html).toContain('window.innerHeight - bounds.height');
    expect(html).not.toContain('menu.style.left');
    expect(html).not.toContain('menu.style.top');
  });

  it('renders explicit loading, empty, and error states', () => {
    expect(renderTimelineHtml({ kind: 'loading' }, 'n', 'vscode-resource:')).toContain('Loading history');
    expect(renderTimelineHtml({ kind: 'empty', path: 'src/empty.ts' }, 'n', 'vscode-resource:')).toContain('No matching commits');
    expect(renderTimelineHtml({ kind: 'error', message: '<bad>' }, 'n', 'vscode-resource:')).toContain('&lt;bad&gt;');
  });

  it('renders the timeline chrome through the VS Code Korean localizer', () => {
    const translations: Record<string, string> = {
      'Current changes': '현재 변경 사항',
      'Newest to oldest': '최신에서 과거순',
      LATEST: '최신',
      Older: '과거',
      'Loading history...': '히스토리를 불러오는 중...',
      'Reading local Git history.': '로컬 Git 히스토리를 읽고 있습니다.'
    };
    mocks.translate.mockImplementation((message: string) => translations[message] ?? message);

    const ready = renderTimelineHtml({ kind: 'ready', model: timelineModel() }, 'n', 'vscode-resource:');
    const loading = renderTimelineHtml({ kind: 'loading' }, 'n', 'vscode-resource:');

    expect(ready).toContain('현재 변경 사항');
    expect(ready).toContain('aria-label="최신에서 과거순"');
    expect(ready).toContain('최신');
    expect(ready).toContain('과거');
    expect(loading).toContain('히스토리를 불러오는 중...');
  });
});

describe('HistoryTimelineViewProvider', () => {
  it('coalesces a burst of registry publications into one visible refresh', async () => {
    const history = {
      getTimeline: vi.fn(async () => timelineModel()),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');
    history.getTimeline.mockClear();

    provider.scheduleRegistryRefresh();
    provider.scheduleRegistryRefresh();
    provider.scheduleRegistryRefresh();

    expect(scheduler.pending).toBe(1);
    scheduler.runNext();
    await flush();
    expect(history.getTimeline).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('keeps registry refresh dirty while hidden and runs it when the view becomes visible', async () => {
    const history = {
      getTimeline: vi.fn(async () => timelineModel()),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');
    history.getTimeline.mockClear();
    view.setVisible(false);

    provider.scheduleRegistryRefresh();

    expect(scheduler.pending).toBe(0);
    expect(history.getTimeline).not.toHaveBeenCalled();
    view.setVisible(true);
    expect(scheduler.pending).toBe(1);
    scheduler.runNext();
    await flush();
    expect(history.getTimeline).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('runs at most one in-flight registry refresh and one trailing refresh', async () => {
    const inFlight = deferred<HistoryTimelineModel | undefined>();
    let active = 0;
    let maximumActive = 0;
    const history = {
      getTimeline: vi.fn(async () => {
        const call = history.getTimeline.mock.calls.length;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return call === 2 ? await inFlight.promise : timelineModel();
        } finally {
          active -= 1;
        }
      }),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');

    provider.scheduleRegistryRefresh();
    scheduler.runNext();
    await flush();
    provider.scheduleRegistryRefresh();
    provider.scheduleRegistryRefresh();
    expect(history.getTimeline).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(0);

    inFlight.resolve(timelineModel());
    await flush();
    expect(scheduler.pending).toBe(1);
    scheduler.runNext();
    await flush();

    expect(history.getTimeline).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(1);
    provider.dispose();
  });

  it('cancels scheduled registry work and suppresses trailing work when disposed', async () => {
    const history = {
      getTimeline: vi.fn(async () => timelineModel()),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');
    history.getTimeline.mockClear();
    provider.scheduleRegistryRefresh();

    provider.dispose();
    provider.scheduleRegistryRefresh();
    scheduler.runAll();
    await flush();

    expect(history.getTimeline).not.toHaveBeenCalled();
  });

  it('loads an explicitly focused target before resolve and while the resolved view is hidden', async () => {
    const beforeResolve = { ...timelineModel(), relativePath: 'src/before.ts' };
    const whileHidden = { ...timelineModel(), relativePath: 'src/hidden.ts' };
    const history = {
      getTimeline: vi.fn()
        .mockResolvedValueOnce(beforeResolve)
        .mockResolvedValueOnce(whileHidden),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);

    await provider.focus('C:/repo/src/before.ts');
    const view = fakeView(false);
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/hidden.ts');

    expect(history.getTimeline).toHaveBeenNthCalledWith(1, 'C:/repo/src/before.ts', undefined, expect.anything());
    expect(history.getTimeline).toHaveBeenNthCalledWith(2, 'C:/repo/src/hidden.ts', undefined, expect.anything());
    expect(scheduler.pending).toBe(0);
    provider.dispose();
  });

  it('runs a dirty refresh after the hidden view is disposed and re-resolved visibly', async () => {
    const history = {
      getTimeline: vi.fn(async () => timelineModel()),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);
    const first = fakeView();
    provider.resolveWebviewView(first.value);
    await provider.focus('C:/repo/src/time.h');
    history.getTimeline.mockClear();
    first.setVisible(false);
    provider.scheduleRegistryRefresh();
    first.dispose();

    const second = fakeView();
    provider.resolveWebviewView(second.value);
    expect(scheduler.pending).toBe(1);
    scheduler.runNext();
    await flush();

    expect(history.getTimeline).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

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
    expect(history.getTimeline).toHaveBeenCalledWith(
      'C:/repo/src/time.h',
      4,
      expect.anything()
    );
    expect(view.webview.html).toContain('LINE 5');

    const callsBeforeDiff = history.getTimeline.mock.calls.length;
    provider.followEditor(editor('my-code-git', '/revision'));
    await flush();
    expect(history.getTimeline).toHaveBeenCalledTimes(callsBeforeDiff);

    provider.followEditor(editor('file', 'C:/repo/src/other.h'));
    await flush();
    expect(history.getTimeline).toHaveBeenLastCalledWith(
      'C:/repo/src/other.h',
      undefined,
      expect.anything()
    );

    view.receive({ type: 'select', id: 'unknown' });
    await flush();
    expect(history.openTimelineEntry).not.toHaveBeenCalled();
    view.receive({ type: 'select', id: model.entries[1]?.id });
    await flush();
    expect(history.openTimelineEntry).toHaveBeenCalledWith(model, model.entries[1]?.id);
    provider.dispose();
  });

  it('does not schedule history work for an intermediate scanning publication', async () => {
    const history = {
      getTimeline: vi.fn(async () => timelineModel()),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const scheduler = new FakeTimelineScheduler();
    const provider = new HistoryTimelineViewProvider(history, undefined, scheduler);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');
    history.getTimeline.mockClear();

    provider.scheduleRegistryRefresh(true);

    expect(scheduler.pending).toBe(0);
    expect(history.getTimeline).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('requires a right-click BASE before a file-history click opens a direct comparison', async () => {
    const model = fileTimelineModel();
    const history = {
      getTimeline: vi.fn(async () => model),
      openTimelineEntry: vi.fn(async () => undefined),
      openTimelineComparison: vi.fn(async () => undefined)
    };
    const provider = new HistoryTimelineViewProvider(history);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');

    view.receive({ type: 'select', id: 'commit:newest' });
    await flush();
    expect(history.openTimelineEntry).not.toHaveBeenCalled();
    expect(history.openTimelineComparison).not.toHaveBeenCalled();

    view.receive({ type: 'setBase', id: 'commit:older' });
    await flush();
    const htmlAfterBase = view.webview.html;
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: 'setBase', id: 'commit:older'
    });

    history.getTimeline.mockClear();
    provider.followEditor(editor('file', model.sourcePath));
    await flush();
    expect(history.getTimeline).not.toHaveBeenCalled();
    expect(view.webview.html).toBe(htmlAfterBase);

    view.receive({ type: 'select', id: 'working' });
    await flush();
    expect(history.openTimelineComparison).toHaveBeenCalledWith(
      model,
      'commit:older',
      'working'
    );
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

  it('keeps the current timeline visible with a refresh indicator until replacement history is ready', async () => {
    const replacement = deferred<HistoryTimelineModel | undefined>();
    const newer = { ...timelineModel(), relativePath: 'src/newer.h', sourcePath: 'C:/repo/src/newer.h' };
    const history = {
      getTimeline: vi.fn()
        .mockResolvedValueOnce(timelineModel())
        .mockReturnValueOnce(replacement.promise),
      openTimelineEntry: vi.fn(async () => undefined)
    };
    const provider = new HistoryTimelineViewProvider(history);
    const view = fakeView();
    provider.resolveWebviewView(view.value);
    await provider.focus('C:/repo/src/time.h');

    const refreshing = provider.refresh();

    expect(view.webview.html).toContain('src/time.h');
    expect(view.webview.html).toContain('Refreshing history');
    expect(view.webview.html).not.toContain('Loading history...');
    replacement.resolve(newer);
    await refreshing;
    expect(view.webview.html).toContain('src/newer.h');
    expect(view.webview.html).not.toContain('Refreshing history');
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
    await flush();
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

function fileTimelineModel(): HistoryTimelineModel {
  const { line: _line, commitLine: _commitLine, ...model } = timelineModel();
  return {
    ...model,
    mode: 'file',
    entries: [
      ...model.entries,
      {
        id: 'original:oldest',
        kind: 'original',
        title: 'ORIGINAL',
        detail: 'Before your first change',
        revision: 'aaaaaaa11111111^',
        path: 'src/time.h',
        exists: true
      }
    ]
  };
}

function fakeView(initiallyVisible = true) {
  let listener: ((message: unknown) => unknown) | undefined;
  let disposeListener: (() => unknown) | undefined;
  let visibilityListener: (() => unknown) | undefined;
  let disposed = false;
  let visible = initiallyVisible;
  let html = '';
  const webview = {
    get html() { return html; },
    set html(value: string) {
      if (disposed) throw new Error('disposed webview cannot render');
      html = value;
    },
    options: {} as vscode.WebviewOptions,
    cspSource: 'vscode-resource:',
    postMessage: vi.fn(async () => true),
    onDidReceiveMessage: (next: (message: unknown) => unknown) => {
      listener = next;
      return { dispose: () => { listener = undefined; } };
    }
  };
  return {
    webview,
    value: {
      webview,
      get visible() { return visible; },
      onDidDispose: (next: () => unknown) => {
        disposeListener = next;
        return { dispose: () => { disposeListener = undefined; } };
      },
      onDidChangeVisibility: (next: () => unknown) => {
        visibilityListener = next;
        return { dispose: () => { visibilityListener = undefined; } };
      }
    } as unknown as vscode.WebviewView,
    receive: (message: unknown) => listener?.(message),
    setVisible: (next: boolean) => {
      visible = next;
      visibilityListener?.();
    },
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

class FakeTimelineScheduler {
  private readonly tasks: Array<{ active: boolean; callback: () => void }> = [];

  public get pending(): number {
    return this.tasks.filter(({ active }) => active).length;
  }

  public schedule(callback: () => void): vscode.Disposable {
    const task = { active: true, callback };
    this.tasks.push(task);
    return {
      dispose: () => {
        task.active = false;
      }
    };
  }

  public runNext(): void {
    const task = this.tasks.find(({ active }) => active);
    if (task === undefined) return;
    task.active = false;
    task.callback();
  }

  public runAll(): void {
    while (this.pending > 0) this.runNext();
  }
}
