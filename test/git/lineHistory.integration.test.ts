import { afterEach, describe, expect, it } from 'vitest';

import { GitRunner, type GitResult, type GitRunOptions } from '../../src/git/gitRunner.js';
import { GitRepository } from '../../src/git/repository.js';
import { createGitFixture, type GitFixture } from '../helpers/gitFixture.js';

const fixtures: GitFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.cleanup()));
});

describe('GitRepository line history', () => {
  it('returns empty history for paths and lines missing from HEAD', async () => {
    const fixture = await createGitFixture();
    fixtures.push(fixture);
    await fixture.setLocalIdentity(fixture.globalIdentity);
    await fixture.writeText('tracked.ts', 'head line\n');
    await fixture.commit('Tracked base');
    await fixture.writeText('tracked.ts', 'head line\nappended working line\n');
    await fixture.writeText('untracked.ts', 'working only\n');
    await fixture.writeText('staged-new.ts', 'staged only\n');
    await fixture.run(['add', '--', 'staged-new.ts']);
    const repository = await GitRepository.discover(fixture.root, fixture.runner);

    expect(await repository.getLineHistory('untracked.ts', 1)).toEqual([]);
    expect(await repository.getLineHistory('staged-new.ts', 1)).toEqual([]);
    expect(await repository.getLineHistory('tracked.ts', 2)).toEqual([]);
    expect((await repository.getLineHistory('tracked.ts', 1)).map(({ subject }) => subject))
      .toContain('Tracked base');
  });

  it('suppresses patch output for delimiter-safe line metadata', async () => {
    const runner = new RecordingLineRunner(process.cwd());
    const repository = await GitRepository.discover(process.cwd(), runner);

    expect(await repository.getLineHistory('src/a.ts', 1)).toEqual([]);
    expect(runner.lineArgs).toContain('--no-patch');
  });
});

class RecordingLineRunner extends GitRunner {
  public lineArgs: readonly string[] = [];

  public constructor(private readonly root: string) {
    super();
  }

  public override async run(
    _cwd: string,
    args: readonly string[],
    _options: GitRunOptions = {}
  ): Promise<GitResult> {
    if (args[0] === 'rev-parse') {
      return { stdout: Buffer.from(`${this.root}\n`), stderr: '', exitCode: 0 };
    }
    this.lineArgs = args;
    return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
  }
}
