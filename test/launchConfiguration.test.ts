import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Extension Development Host launch configuration', () => {
  it('launches this workspace as the extension development path', () => {
    const launch = JSON.parse(readFileSync('.vscode/launch.json', 'utf8')) as {
      readonly configurations?: readonly { readonly type?: string; readonly args?: readonly string[] }[];
    };

    expect(launch.configurations?.[0]?.type).toBe('extensionHost');
    expect(launch.configurations?.[0]?.args).toContain('--extensionDevelopmentPath=${workspaceFolder}');
  });
});
