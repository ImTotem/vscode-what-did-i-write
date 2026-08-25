import { spawn } from 'node:child_process';

export interface GitRunOptions {
  readonly signal?: AbortSignal;
  readonly maxBufferBytes?: number;
  readonly allowExitCodes?: readonly number[];
}

export interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitCommandError extends Error {
  public constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
    reason: string
  ) {
    super(`git ${args.map(sanitizeArgument).join(' ')}: ${reason}${stderr ? `: ${stderr}` : ''}`);
    this.name = 'GitCommandError';
  }
}

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_GIT_PROCESSES = 4;

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('command aborted');
    if (this.active >= MAX_CONCURRENT_GIT_PROCESSES) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(continueAcquire);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error('command aborted'));
        };
        const continueAcquire = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(continueAcquire);
      });
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

const semaphore = new Semaphore();

export class GitRunner {
  public constructor(private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  public async run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    let release: (() => void);
    try {
      release = await semaphore.acquire(options.signal);
    } catch {
      throw new GitCommandError(args, '', null, 'command aborted');
    }
    try {
      return await this.runProcess(cwd, args, options);
    } finally {
      release();
    }
  }

  private runProcess(cwd: string, args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new GitCommandError(args, '', null, 'command aborted'));
        return;
      }
      const child = spawn('git', [...args], {
        cwd,
        env: this.baseEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const limit = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutLength = 0;
      let settled = false;
      let terminationError: GitCommandError | undefined;
      const finish = (callback: () => void): void => {
        if (!settled) {
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          callback();
        }
      };
      const onAbort = (): void => {
        terminationError ??= new GitCommandError(args, Buffer.concat(stderr).toString('utf8'), null, 'command aborted');
        child.kill();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLength += chunk.length;
        if (stdoutLength > limit) {
          terminationError ??= new GitCommandError(args, Buffer.concat(stderr).toString('utf8'), null, `stdout exceeded ${limit} bytes`);
          child.kill();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error: Error) => finish(() => reject(new GitCommandError(args, Buffer.concat(stderr).toString('utf8'), null, error.message))));
      child.on('close', (exitCode) => finish(() => {
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (terminationError !== undefined) {
          reject(terminationError);
          return;
        }
        const allowed = options.allowExitCodes ?? [0];
        if (exitCode === null || !allowed.includes(exitCode)) {
          reject(new GitCommandError(args, stderrText, exitCode, `exited with code ${String(exitCode)}`));
        } else {
          resolve({ stdout: Buffer.concat(stdout), stderr: stderrText, exitCode });
        }
      }));
    });
  }
}

function sanitizeArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(argument) ? argument : '<redacted>';
}
