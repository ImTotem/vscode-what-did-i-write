import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { GitCommandError, GitRunner } from '../../src/git/gitRunner.js';

interface FakeChild extends ChildProcessWithoutNullStreams {
  readonly killMock: ReturnType<typeof vi.fn>;
  close(code?: number | null): void;
  fail(error: Error): void;
  writeStdout(chunk: string): void;
}

function createChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killMock = vi.fn(() => true);
  Object.assign(child, { stdout, stderr, kill: killMock, killMock });
  child.close = (code: number | null = 0) => child.emit('close', code);
  child.fail = (error: Error) => child.emit('error', error);
  child.writeStdout = (chunk: string) => stdout.emit('data', Buffer.from(chunk));
  return child;
}

describe('GitRunner', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('holds process slots until output-limit kills have closed', async () => {
    const children = Array.from({ length: 5 }, createChild);
    spawnMock.mockImplementation(() => children[spawnMock.mock.calls.length - 1] as FakeChild);
    const runner = new GitRunner();
    const limited = Array.from({ length: 4 }, () => runner.run(process.cwd(), ['version'], { maxBufferBytes: 0 }));
    const queued = runner.run(process.cwd(), ['version']);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(4));
    for (const child of children.slice(0, 4)) child.writeStdout('x');
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(4);

    for (const child of children.slice(0, 4)) child.close(null);
    await expect(Promise.all(limited)).rejects.toBeInstanceOf(GitCommandError);
    expect(spawnMock).toHaveBeenCalledTimes(5);
    children[4]?.close(0);
    await expect(queued).resolves.toMatchObject({ exitCode: 0 });
  });

  it('holds process slots when a kill reports an error before close', async () => {
    const children = Array.from({ length: 5 }, createChild);
    spawnMock.mockImplementation(() => children[spawnMock.mock.calls.length - 1] as FakeChild);
    const runner = new GitRunner();
    const limited = Array.from({ length: 4 }, () => runner.run(process.cwd(), ['version'], { maxBufferBytes: 0 }));
    const queued = runner.run(process.cwd(), ['version']);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(4));
    for (const child of children.slice(0, 4)) {
      child.writeStdout('x');
      child.fail(new Error('kill failed'));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(spawnMock).toHaveBeenCalledTimes(4);

    for (const child of children.slice(0, 4)) child.close(null);
    await expect(Promise.all(limited)).rejects.toBeInstanceOf(GitCommandError);
    expect(spawnMock).toHaveBeenCalledTimes(5);
    children[4]?.close(0);
    await expect(queued).resolves.toMatchObject({ exitCode: 0 });
  });

  it('rejects a spawn error without waiting indefinitely for close', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const runner = new GitRunner();
    const running = runner.run(process.cwd(), ['version']);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.fail(new Error('spawn failed'));

    await expect(running).rejects.toMatchObject({ message: expect.stringContaining('spawn failed') });
  });

  it('rejects a queued request immediately when its signal aborts', async () => {
    const children = Array.from({ length: 4 }, createChild);
    spawnMock.mockImplementation(() => children[spawnMock.mock.calls.length - 1] as FakeChild);
    const runner = new GitRunner();
    const active = Array.from({ length: 4 }, () => runner.run(process.cwd(), ['version']));
    const controller = new AbortController();
    const queued = runner.run(process.cwd(), ['version'], { signal: controller.signal });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(4));
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(GitCommandError);
    expect(spawnMock).toHaveBeenCalledTimes(4);

    for (const child of children) child.close(0);
    await expect(Promise.all(active)).resolves.toHaveLength(4);
  });
});
