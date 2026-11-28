/* 开发启动：先起 Vite，再起 Electron 指向 Vite 地址 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const PORT = 5174;
const url = `http://127.0.0.1:${PORT}`;

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'inherit', shell: true });

async function waitFor() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${url}/desktop.html`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('vite did not start');
}

await waitFor();
const electron = spawn(electronPath, ['desktop/main.cjs'], { stdio: 'inherit', env: { ...process.env, DESK_OASIS_DEV_URL: url } });
electron.on('exit', () => {
  vite.kill();
  process.exit(0);
});
