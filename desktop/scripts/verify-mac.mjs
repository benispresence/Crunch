import { execFileSync } from 'node:child_process';
import path from 'node:path';

const app = path.resolve(process.argv[2]);
const arch = process.argv[3] ?? process.arch;
const resources = path.join(app, 'Contents', 'Resources');
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...options }).trim();
}
run('codesign', ['--verify', '--deep', '--strict', app]);
const executable = path.join(app, 'Contents', 'MacOS', 'Crunch');
const architectures = run('lipo', ['-archs', executable]).split(/\s+/);
if (!architectures.includes(arch === 'x64' ? 'x86_64' : arch)) throw new Error('Wrong Electron architecture');
const node = path.join(resources, 'node', 'bin', 'node');
if (run(node, ['-p', 'process.arch']) !== arch) throw new Error('Wrong bundled Node architecture');
run(node, ['--input-type=module', '-e', `
  import { createRequire } from 'node:module';
  const require = createRequire(process.cwd() + '/package.json');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get(); db.close();
`], { cwd: path.join(resources, 'backend') });
run(path.join(resources, 'python', 'bin', 'python3'), ['-c', `
import platform
assert platform.machine() == ${JSON.stringify(arch === 'x64' ? 'x86_64' : 'arm64')}
import fastapi, uvicorn, pandas, numpy, duckdb, sqlalchemy, greenlet
`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: path.join(resources, 'pydeps') } });
console.log(`Verified signature and native runtimes: ${arch}`);
