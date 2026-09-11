import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

for (const desktop of [true, false]) test(`production first run (desktop=${desktop})`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crunch-setup-'));
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  const env = { ...process.env, NODE_ENV: 'production', CRUNCH_DESKTOP: desktop ? '1' : '0',
    CRUNCH_DESKTOP_SETUP_TOKEN: 'test-private-capability', JWT_SECRET: 'test-jwt-secret',
    DATA_KEY: 'a'.repeat(64), PYTHON_ENGINE_TOKEN: 'test-engine-secret',
    PORT: String(port), BIND_HOST: '127.0.0.1', DATABASE_FILE: path.join(dir, 'db.sqlite'),
    NICEMETA_WORKSPACE_DIR: path.join(dir, 'workspace') };
  let child;
  async function start() {
    child = spawn(process.execPath, ['dist/index.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try { return await (await fetch(`http://127.0.0.1:${port}/api/auth/config`)).json(); } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Backend did not start');
  }
  async function stop() {
    const done = new Promise(r => child.once('exit', r)); child.kill(); await done;
  }
  async function post(route, data) {
    return fetch(`http://127.0.0.1:${port}/api/auth/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
  }
  try {
    let cfg = await start();
    assert.equal(cfg.default_admin_password, null);
    assert.equal(cfg.desktop_setup_required, desktop);
    const credentials = { email: 'owner@example.com', password: 'chosen-password' };
    assert.equal((await post('desktop-setup', credentials)).status, 403);
    // A previous failed launch must remain recoverable after restarting.
    await stop(); cfg = await start();
    assert.equal(cfg.desktop_setup_required, desktop);
    const response = await post('desktop-setup', { ...credentials, setup_token: env.CRUNCH_DESKTOP_SETUP_TOKEN });
    assert.equal(response.status, desktop ? 200 : 403);
    if (desktop) {
      const result = await response.json();
      assert.equal(result.user.role, 'admin');
      assert.equal(result.user.must_change_password, false);
      assert.ok(result.token);
      assert.equal((await post('desktop-setup', { ...credentials, setup_token: env.CRUNCH_DESKTOP_SETUP_TOKEN })).status, 409);
      assert.equal((await post('login', credentials)).status, 200);
      await stop(); cfg = await start();
      assert.equal(cfg.desktop_setup_required, false);
      assert.equal((await post('login', credentials)).status, 200);
    }
  } finally {
    if (child?.exitCode === null) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
