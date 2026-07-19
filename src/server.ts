// SPIKE: prototype quality — see hardening list before reuse
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChats, getMessages, searchMessages, getStats } from './store.js';
import { getCurrentQR, getCurrentPairingCode, getConnectionStatus } from './connection.js';
import { auditRouter } from './auditor/auditRoute.js';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer(port = 3000, opts: { offline?: boolean } = {}): void {
  const offline = Boolean(opts.offline);
  const app = express();

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(auditRouter);

  app.get('/api/chats', (_req, res) => {
    res.json(getChats());
  });

  app.get('/api/chats/:jid/messages', (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    res.json(getMessages(req.params.jid, limit, offset));
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    res.json(searchMessages(q));
  });

  app.get('/api/stats', (_req, res) => {
    res.json(getStats());
  });

  app.get('/api/qr', (_req, res) => {
    res.json({ qr: getCurrentQR(), connected: getConnectionStatus(), offline });
  });

  app.get('/api/pairing-code', (_req, res) => {
    res.json({ pairingCode: getCurrentPairingCode(), connected: getConnectionStatus(), offline });
  });

  app.get('/qr.png', async (_req, res) => {
    const qr = getCurrentQR();
    if (!qr) {
      res.status(404).send('No QR code available');
      return;
    }
    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 320, margin: 1 });
    res.type('png').send(buffer);
  });

  app.get('/qr', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp QR — Link Device</title>
<style>
  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    gap: 20px;
  }
  #qr-img { background: #fff; padding: 12px; border-radius: 8px; }
  #status { font-size: 14px; }
  #status.connected { color: #2ea043; font-size: 20px; font-weight: bold; }
  #pairing-code {
    display: none;
    font-size: 36px;
    font-weight: bold;
    letter-spacing: 6px;
    color: #58a6ff;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 16px 24px;
  }
  #pairing-hint { display: none; font-size: 13px; color: #8b949e; max-width: 420px; text-align: center; }
</style>
</head>
<body>
  <h1 style="font-size:16px;color:#2ea043;">Scan with WhatsApp → Linked Devices</h1>
  <img id="qr-img" style="display:none;" width="320" height="320" alt="WhatsApp QR code">
  <div id="pairing-code"></div>
  <div id="pairing-hint">Pairing code: in WhatsApp go to Linked Devices → Link a Device → "Link with phone number instead" and enter this code.</div>
  <div id="status">Waiting for QR code…</div>
<script>
  async function refresh() {
    try {
      const [qrRes, pairRes] = await Promise.all([
        fetch('/api/qr'),
        fetch('/api/pairing-code'),
      ]);
      const data = await qrRes.json();
      const pairing = await pairRes.json();
      const img = document.getElementById('qr-img');
      const status = document.getElementById('status');
      const codeEl = document.getElementById('pairing-code');
      const hintEl = document.getElementById('pairing-hint');
      if (data.connected) {
        img.style.display = 'none';
        codeEl.style.display = 'none';
        hintEl.style.display = 'none';
        status.textContent = 'Connected!';
        status.className = 'connected';
        return;
      }
      status.className = '';
      if (pairing.pairingCode) {
        img.style.display = 'none';
        codeEl.textContent = pairing.pairingCode;
        codeEl.style.display = 'block';
        hintEl.style.display = 'block';
        status.textContent = 'Enter the pairing code in WhatsApp.';
      } else if (data.qr) {
        codeEl.style.display = 'none';
        hintEl.style.display = 'none';
        img.src = '/qr.png?t=' + Date.now();
        img.style.display = 'block';
        status.textContent = 'QR refreshes automatically every 5 seconds.';
      } else {
        img.style.display = 'none';
        codeEl.style.display = 'none';
        hintEl.style.display = 'none';
        status.textContent = 'Waiting for QR or pairing code… (already linked, or still starting up)';
      }
    } catch (e) {
      document.getElementById('status').textContent = 'Failed to reach server. Retrying…';
    }
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`);
  });

  app.listen(port, () => {
    console.log(`[web] UI available at http://localhost:${port}`);
  });
}
