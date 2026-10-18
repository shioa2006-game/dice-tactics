// 依存なしの静的ファイルサーバー（ES Modules と Web Worker を使うため、http で配信する）
// usage: node serve.js [port] [--open] [--auto-port]
//   --open       起動後に既定のブラウザでゲームを開く（環境変数 BROWSER=none のときは開かない）
//   --auto-port  ポートが使用中なら、空いている次のポート（最大 +20）で起動する
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = process.argv.slice(2);
const openBrowser = args.includes('--open');
const autoPort = args.includes('--auto-port');
const basePort = +(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8130);
const MAX_TRIES = 20;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

let port = basePort;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && autoPort && port < basePort + MAX_TRIES) {
    port++;
    server.listen(port, '127.0.0.1');
    return;
  }
  console.error(err.code === 'EADDRINUSE' ? `ポート ${port} は使用中です。別のポートを指定してください（例: node serve.js 9000）。` : `サーバーを起動できませんでした: ${err.message}`);
  process.exit(1);
});
server.on('listening', () => {
  const url = `http://localhost:${port}/`;
  if (port !== basePort) console.log(`ポート ${basePort} は使用中のため、ポート ${port} で起動しました。`);
  console.log(`DICE TACTICS: ${url}`);
  if (openBrowser) {
    console.log('ブラウザでゲームを開きます。開かない場合は上のアドレスをブラウザで開いてください。');
    console.log('終了するときは、このウィンドウを閉じてください（または Ctrl+C）。');
    if (process.env.BROWSER !== 'none') {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, (e) => {
        if (e) console.log(`ブラウザを自動で開けませんでした。${url} を開いてください。`);
      });
    }
  }
});
server.listen(port, '127.0.0.1');
