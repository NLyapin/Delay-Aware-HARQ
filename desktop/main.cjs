const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');

let backend, window, baseURL, stopping = false;
const token = randomBytes(32).toString('hex');
const root = path.resolve(__dirname, '..');
if (process.env.HARQ_USER_DATA) app.setPath('userData', process.env.HARQ_USER_DATA);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startBackend() {
  const port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  const python = process.env.HARQ_PYTHON || path.join(root, '.venv', 'bin', 'python');
  try { await fs.access(python); } catch {
    throw new Error(`Не найден Python: ${python}\nВ папке проекта выполните: uv sync --python 3.12 --extra dev\nДля сборки приложения задайте HARQ_PYTHON.`);
  }
  let logs = '', failed;
  backend = spawn(python, ['-m', 'harq_lab.cli', 'serve', '--port', String(port)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: root, PYTHONUNBUFFERED: '1', HARQ_API_TOKEN: token,
      HARQ_DB: path.join(app.getPath('userData'), 'harq.sqlite3') }
  });
  backend.stdout.on('data', data => { logs = (logs + data).slice(-6000); });
  backend.stderr.on('data', data => { logs = (logs + data).slice(-6000); });
  backend.on('error', error => { failed = error.message; });
  backend.on('exit', code => {
    failed = `Python завершился с кодом ${code}\n${logs}`;
    if (window && !stopping) {
      dialog.showErrorBox('Симулятор остановлен', failed);
      app.quit();
    }
  });
  for (let i = 0; i < 120; i++) {
    if (failed) throw new Error(failed);
    try {
      const response = await fetch(`${baseURL}/api/health`, { headers: { 'X-HARQ-Token': token } });
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Python API не запустился за 30 секунд.\n${logs}`);
}

function validPath(endpoint, method) {
  if (method === 'GET') return /^\/api\/(health|bootstrap|jobs(?:\/[a-f0-9]{32}(?:\/export\/(json|csv|md))?)?)$/.test(endpoint);
  return method === 'POST' && /^\/api\/jobs(?:\/[a-f0-9]{32}\/cancel)?$/.test(endpoint);
}

ipcMain.handle('harq:request', async (event, endpoint, method = 'GET', body = null) => {
  if (event.sender !== window?.webContents || !validPath(endpoint, method)) throw new Error('Недопустимый запрос');
  const response = await fetch(`${baseURL}${endpoint}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-HARQ-Token': token },
    ...(body !== null ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(await response.text());
  return endpoint.includes('/export/') ? response.text() : response.json();
});

ipcMain.handle('harq:save', async (event, format, content) => {
  if (event.sender !== window?.webContents || !['json', 'csv', 'md', 'svg'].includes(format)
      || typeof content !== 'string' || content.length > 100_000_000) throw new Error('Недопустимый экспорт');
  const result = await dialog.showSaveDialog(window, {
    defaultPath: `harq-experiment.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });
  if (result.canceled) return false;
  await fs.writeFile(result.filePath, content, 'utf8');
  return true;
});

app.whenReady().then(async () => {
  try {
    await startBackend();
    window = new BrowserWindow({ width: 1500, height: 980, minWidth: 760, minHeight: 600,
      title: 'HARQ Lab · Research workspace', backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  } catch (error) {
    dialog.showErrorBox('Не удалось запустить HARQ Lab', error.message);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { stopping = true; backend?.kill('SIGTERM'); });
