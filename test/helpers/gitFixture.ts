import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { GitIdentity } from '../../src/core/model.js';
import { GitRunner, type GitResult } from '../../src/git/gitRunner.js';

export interface GitFixture {
  readonly root: string;
  readonly runner: GitRunner;
  readonly globalIdentity: GitIdentity;
  run(args: readonly string[], cwd?: string): Promise<GitResult>;
  writeText(relativePath: string, contents: string): Promise<void>;
  writeBytes(relativePath: string, contents: Buffer): Promise<void>;
  setLocalIdentity(identity: GitIdentity): Promise<void>;
  commit(subject: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const container = await mkdtemp(join(tmpdir(), 'my-code-git-'));
  const root = join(container, 'repository');
  const isolatedHome = join(container, 'home');
  await Promise.all([mkdir(root), mkdir(isolatedHome)]);

  const globalIdentity = { name: 'Me', email: 'me@example.com' } as const;
  const runner = new GitRunner({
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    GIT_CONFIG_GLOBAL: join(isolatedHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1'
  });

  const run = (args: readonly string[], cwd = root): Promise<GitResult> => runner.run(cwd, args);
  const write = async (relativePath: string, contents: string | Buffer): Promise<void> => {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  };

  const fixture: GitFixture = {
    root,
    runner,
    globalIdentity,
    run,
    writeText: (relativePath, contents) => write(relativePath, contents),
    writeBytes: (relativePath, contents) => write(relativePath, contents),
    setLocalIdentity: async (identity) => {
      await run(['config', 'user.name', identity.name]);
      await run(['config', 'user.email', identity.email]);
    },
    commit: async (subject) => {
      await run(['add', '--all']);
      await run(['commit', '-m', subject]);
    },
    cleanup: () => rm(container, { recursive: true, force: true })
  };

  await run(['init', '--initial-branch=main']);
  await run(['config', '--global', 'user.name', globalIdentity.name]);
  await run(['config', '--global', 'user.email', globalIdentity.email]);
  return fixture;
}
