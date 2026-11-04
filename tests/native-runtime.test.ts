import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('emitted API handlers run in native Node and fail closed without authentication or configuration', async () => {
  const cache = path.join(root, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(path.join(cache, 'antty-runtime-'));
  try {
    // Compile the server graph without bundling or rewriting relative imports.
    // NodeNext also prevents newly introduced extensionless imports from shipping.
    await execute(
      process.execPath,
      [
        path.join(root, 'node_modules/typescript/bin/tsc'),
        '--project',
        'tsconfig.runtime.json',
        '--outDir',
        output,
      ],
      { cwd: root, timeout: 45_000, env: { NODE_ENV: 'test' } },
    );
    // A fresh process deliberately inherits neither tsx/NODE_OPTIONS nor credentials.
    await execute(
      process.execPath,
      [path.join(root, 'tests/fixtures/native-runtime.mjs'), output],
      { cwd: root, timeout: 30_000, env: { NODE_ENV: 'production' } },
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
