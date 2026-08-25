import { afterEach, describe, expect, it } from 'vitest';

import type { GitIdentity } from '../../src/core/model.js';
import { GitRepository } from '../../src/git/repository.js';
import { createGitFixture, type GitFixture } from '../helpers/gitFixture.js';

const alice: GitIdentity = { name: 'Alice', email: 'alice@example.com' };
const binaryContents = Buffer.from([0, 255, 1, 2, 128]);
const fixtures: GitFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.cleanup()));
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

  it('preserves staged, unstaged, untracked, and Unicode paths in the working fingerprint', async () => {
    const fixture = await createScenario();
    const repository = await GitRepository.discover(fixture.root, fixture.runner);
    const clean = await repository.getFingerprint();

    await fixture.writeText('staged file.txt', 'staged\n');
    await fixture.run(['add', '--', 'staged file.txt']);
    await fixture.writeText('tracked.txt', 'alice one\nme survives\nalice three\nalice overwrote\nunstaged\n');
    await fixture.writeText('새 작업.txt', 'untracked\n');

    expect(await repository.getWorkingChanges()).toEqual(expect.arrayContaining([
      { status: 'A.', path: 'staged file.txt' },
      { status: '.M', path: 'tracked.txt' },
      { status: '?', path: '새 작업.txt' }
    ]));
    const changed = await repository.getFingerprint();
    expect(changed.head).toBe(clean.head);
    expect(changed.status).not.toBe(clean.status);
  });
});

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
