import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitIdentity } from '../../src/core/model.js';
import {
  GitCommandError,
  GitRunner,
  type GitResult,
  type GitRunOptions
} from '../../src/git/gitRunner.js';
import { GitRepository } from '../../src/git/repository.js';
import { createGitFixture, type GitFixture } from '../helpers/gitFixture.js';

const alice: GitIdentity = { name: 'Alice', email: 'alice@example.com' };
const binaryContents = Buffer.from([0, 255, 1, 2, 128]);
const fixtures: GitFixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map(async (fixture) => fixture.cleanup()),
    ...temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))
  ]);
});

describe('GitRepository', () => {
  it('discovers a clean multi-author repository and uses only reachable HEAD history', async () => {
    const fixture = await createScenario();
    const repository = await GitRepository.discover(fixture.root, fixture.runner);

    expect(repository.root).toBe(fixture.root);
    expect(await repository.getGlobalIdentity()).toEqual(fixture.globalIdentity);
    const head = await repository.getHead();
    expect(head).toMatch(/^[0-9a-f]{40,64}$/);

    const index = await repository.getUserIndex(fixture.globalIdentity);
    expect(index.commits.map((commit) => commit.subject)).toEqual(['my work']);
    expect(index.commits.map((commit) => commit.subject)).not.toContain('unreachable work');
    expect(index.entries.flatMap((entry) => entry.changes.map((change) => change.path)))
      .toContain('한글 파일.txt');
    expect(await repository.getWorkingChanges()).toEqual([]);

    const blame = await repository.blame('tracked.txt');
    expect(new Set(blame.flatMap((line) => line.commit?.authorName ?? []))).toEqual(new Set(['Alice', 'Me']));
    expect((await repository.getFileHistory('한글 파일.txt')).map((commit) => commit.subject))
      .toEqual(['my work']);
    expect((await repository.getLineHistory('tracked.txt', 2)).map((commit) => commit.subject))
      .toContain('my work');
    expect(await repository.showFile(head as string, 'assets/data.bin')).toEqual(binaryContents);
    expect(await repository.showFile(head as string, 'absent.bin')).toBeUndefined();
    expect(await repository.showFile('f'.repeat(40), 'assets/data.bin')).toBeUndefined();
  });

  it('preserves staged rename sources, unstaged, untracked, and Unicode paths', async () => {
    const fixture = await createScenario();
    const repository = await GitRepository.discover(fixture.root, fixture.runner);
    const clean = await repository.getFingerprint();

    await fixture.writeText('staged file.txt', 'staged\n');
    await fixture.run(['add', '--', 'staged file.txt']);
    await fixture.run(['mv', '--', 'mine.ts', 'renamed mine.ts']);
    await fixture.writeText('tracked.txt', 'alice one\nme survives\nalice three\nalice overwrote\nunstaged\n');
    await fixture.writeText('새 작업.txt', 'untracked\n');

    expect(await repository.getWorkingChanges()).toEqual(expect.arrayContaining([
      { status: 'A.', path: 'staged file.txt' },
      { status: 'R.', path: 'renamed mine.ts', originalPath: 'mine.ts' },
      { status: '.M', path: 'tracked.txt' },
      { status: '?', path: '새 작업.txt' }
    ]));
    const changed = await repository.getFingerprint();
    expect(changed.head).toBe(clean.head);
    expect(changed.status).not.toBe(clean.status);

    await fixture.writeText(
      'tracked.txt',
      'alice one\nme survives\nalice three\nalice overwrote\nexternal\n'
    );
    const sameStatusReplacement = await repository.getFingerprint();

    expect((await repository.getWorkingChanges()).find(({ path }) => path === 'tracked.txt')?.status)
      .toBe('.M');
    expect(sameStatusReplacement.head).toBe(changed.head);
    expect(sameStatusReplacement.status).not.toBe(changed.status);
  });

  it('indexes a matching-author merge conflict resolution against its first parent', async () => {
    const fixture = await createGitFixture();
    fixtures.push(fixture);
    await fixture.setLocalIdentity(alice);
    await fixture.writeText('conflict.txt', 'base\n');
    await fixture.commit('base');
    await fixture.run(['switch', '-c', 'feature']);
    await fixture.writeText('conflict.txt', 'feature side\n');
    await fixture.commit('feature work');
    await fixture.run(['switch', 'main']);
    await fixture.writeText('conflict.txt', 'main side\n');
    await fixture.commit('main work');
    await fixture.setLocalIdentity(fixture.globalIdentity);
    const merge = await fixture.run(['merge', 'feature']).catch((error: unknown) => error);
    expect(merge).toMatchObject({ exitCode: 1 });
    await fixture.writeText('conflict.txt', 'resolved only by me\n');
    await fixture.commit('resolve conflict');
    const repository = await GitRepository.discover(fixture.root, fixture.runner);

    const index = await repository.getUserIndex(fixture.globalIdentity);

    expect(index.entries).toEqual([
      expect.objectContaining({
        commit: expect.objectContaining({ subject: 'resolve conflict' }),
        changes: [expect.objectContaining({ status: 'M', path: 'conflict.txt' })]
      })
    ]);
  });

  it('integrates control-byte and empty commit subjects through NUL-framed index and history', async () => {
    const fixture = await createGitFixture();
    fixtures.push(fixture);
    await fixture.setLocalIdentity(fixture.globalIdentity);
    const controlSubject = `control ${String.fromCharCode(0x1e)} ${String.fromCharCode(0x1f)}`;
    await fixture.writeText('control-subject.ts', 'control\n');
    await fixture.commit(controlSubject);
    await fixture.writeText('empty-subject.ts', 'empty\n');
    await fixture.run(['add', '--all']);
    await fixture.run(['commit', '--allow-empty-message', '-m', '']);
    const repository = await GitRepository.discover(fixture.root, fixture.runner);

    const index = await repository.getUserIndex(fixture.globalIdentity);

    expect(index.entries.map(({ commit }) => commit.subject)).toEqual(['', controlSubject]);
    expect((await repository.getFileHistory('control-subject.ts'))[0]?.subject).toBe(controlSubject);
    expect((await repository.getFileHistory('empty-subject.ts'))[0]?.subject).toBe('');
  });

  it.runIf(process.platform !== 'win32')(
    'preserves a literal POSIX backslash path through index, status, and blame',
    async () => {
      const fixture = await createGitFixture();
      fixtures.push(fixture);
      await fixture.setLocalIdentity(fixture.globalIdentity);
      const path = 'src/literal\\backslash.ts';
      await fixture.writeText(path, 'owned\n');
      await fixture.commit('literal backslash');
      const repository = await GitRepository.discover(fixture.root, fixture.runner);

      const index = await repository.getUserIndex(fixture.globalIdentity);

      expect(index.entries[0]?.changes).toContainEqual({ status: 'A', path });
      expect((await repository.blame(path))[0]?.commit?.authorEmail)
        .toBe(fixture.globalIdentity.email);
      await fixture.writeText(path, 'owned externally\n');
      expect(await repository.getWorkingChanges()).toContainEqual({ status: '.M', path });
    }
  );

  it('rejects show failures whose exit code is not the expected absence code', async () => {
    const fixture = await createScenario();
    const repository = await GitRepository.discover(fixture.root, new Non128ShowRunner(fixture.root));

    await expect(repository.showFile('HEAD', 'tracked.txt')).rejects.toMatchObject({
      name: 'GitCommandError',
      exitCode: 129
    });
  });

  it('leaves a surrogate outer global Git identity unchanged', async () => {
    const outerHome = await mkdtemp(join(tmpdir(), 'my-code-outer-git-'));
    temporaryDirectories.push(outerHome);
    const outerConfig = join(outerHome, '.gitconfig');
    const outerEnv = {
      ...process.env,
      HOME: outerHome,
      USERPROFILE: outerHome,
      GIT_CONFIG_GLOBAL: outerConfig,
      GIT_CONFIG_NOSYSTEM: '1'
    };
    const outerRunner = new GitRunner(outerEnv);
    await outerRunner.run(process.cwd(), ['config', '--global', 'user.name', 'Outer Canary']);
    await outerRunner.run(process.cwd(), ['config', '--global', 'user.email', 'outer-canary@example.com']);

    const originalEnvironment = saveEnvironment([
      'HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'
    ]);
    let fixture: GitFixture;
    try {
      Object.assign(process.env, outerEnv);
      fixture = await createGitFixture();
      fixtures.push(fixture);
    } finally {
      restoreEnvironment(originalEnvironment);
    }

    expect(await readGlobalConfig(outerRunner, 'user.name')).toBe('Outer Canary');
    expect(await readGlobalConfig(outerRunner, 'user.email')).toBe('outer-canary@example.com');
  });
});

class Non128ShowRunner extends GitRunner {
  public constructor(private readonly repositoryRoot: string) {
    super();
  }

  public override async run(
    _cwd: string,
    args: readonly string[],
    options: GitRunOptions = {}
  ): Promise<GitResult> {
    if (args[0] === 'rev-parse') {
      return { stdout: Buffer.from(`${this.repositoryRoot}\n`), stderr: '', exitCode: 0 };
    }

    const exitCode = 129;
    const stderr = 'controlled non-absence failure';
    if (!(options.allowExitCodes ?? [0]).includes(exitCode)) {
      throw new GitCommandError(args, stderr, exitCode, `exited with code ${exitCode}`);
    }
    return { stdout: Buffer.alloc(0), stderr, exitCode };
  }
}

async function createScenario(): Promise<GitFixture> {
  const fixture = await createGitFixture();
  fixtures.push(fixture);

  await fixture.setLocalIdentity(alice);
  await fixture.writeText('tracked.txt', 'alice one\nshared\nalice three\n');
  await fixture.commit('upstream');

  await fixture.setLocalIdentity(fixture.globalIdentity);
  await fixture.writeText('tracked.txt', 'alice one\nme survives\nalice three\nme overwritten\n');
  await fixture.writeText('mine.ts', 'export const mine = true;\n');
  await fixture.writeText('한글 파일.txt', '내 코드\n');
  await fixture.writeBytes('assets/data.bin', binaryContents);
  await fixture.commit('my work');

  await fixture.setLocalIdentity(alice);
  await fixture.writeText('tracked.txt', 'alice one\nme survives\nalice three\nalice overwrote\n');
  await fixture.commit('overwrite user line');

  await fixture.run(['switch', '-c', 'unrelated']);
  await fixture.setLocalIdentity(fixture.globalIdentity);
  await fixture.writeText('unreachable.txt', 'not on main\n');
  await fixture.commit('unreachable work');
  await fixture.run(['switch', 'main']);
  return fixture;
}

function saveEnvironment(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(environment: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function readGlobalConfig(runner: GitRunner, key: string): Promise<string> {
  const result = await runner.run(process.cwd(), ['config', '--global', '--get', key]);
  return result.stdout.toString('utf8').replace(/[\r\n]+$/, '');
}
