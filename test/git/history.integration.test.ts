import { afterEach, describe, expect, it } from 'vitest';

import { GitRepository } from '../../src/git/repository.js';
import { createGitFixture, type GitFixture } from '../helpers/gitFixture.js';

const fixtures: GitFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.cleanup()));
});

describe('GitRepository file history paths', () => {
  it('preserves argv-safe special paths across a root add, rename, and deletion', async () => {
    const fixture = await createGitFixture();
    fixtures.push(fixture);
    const originalPath = 'src/-old # [한글].ts';
    const renamedPath = 'src/new name # [한글].ts';
    await fixture.setLocalIdentity(fixture.globalIdentity);
    await fixture.writeText(originalPath, 'root\n');
    await fixture.commit('Root add');
    await fixture.run(['mv', '--', originalPath, renamedPath]);
    await fixture.commit('Rename file');
    await fixture.run(['rm', '--', renamedPath]);
    await fixture.commit('Delete file');

    const repository = await GitRepository.discover(fixture.root, fixture.runner);
    const history = await repository.getFileHistoryEntries(renamedPath);

    expect(history.map(({ commit }) => commit.subject)).toEqual([
      'Delete file', 'Rename file', 'Root add'
    ]);
    expect(history.map(({ path, parentPath }) => ({ path, parentPath }))).toEqual([
      { path: renamedPath, parentPath: renamedPath },
      { path: renamedPath, parentPath: originalPath },
      { path: originalPath, parentPath: undefined }
    ]);
    expect(await repository.showFile(`${history[0]?.commit.hash}^`, renamedPath))
      .toEqual(Buffer.from('root\n'));
    expect(await repository.showFile(history[0]?.commit.hash ?? '', renamedPath)).toBeUndefined();
  });
});
