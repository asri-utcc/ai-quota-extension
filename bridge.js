// Antigravity Local Quota Bridge for AI Usage Monitor
// Automatically reads active port and CSRF token from ~/.gemini/antigravity/daemon/hub_*.json
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const BRIDGE_PORT = 49111;

function getLatestHubInfo() {
  const possibleDirs = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'daemon'),
    path.join(os.homedir(), '.antigravity', 'daemon'),
    path.join(process.env.APPDATA || '', 'antigravity', 'daemon'),
    path.join(process.env.LOCALAPPDATA || '', 'antigravity', 'daemon')
  ];

  for (const dir of possibleDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('hub_') && f.endsWith('.json'))
        .map(f => {
          const full = path.join(dir, f);
          return { path: full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const raw = fs.readFileSync(files[0].path, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.httpPort || parsed.httpsPort)) {
          return parsed;
        }
      }
    } catch (_) {}
  }
  return null;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const hub = getLatestHubInfo();

  if (req.url === '/info' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: !!hub, ...hub }));
    return;
  }

  if (req.url === '/quota') {
    if (!hub || !hub.httpPort || !hub.csrfToken) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Antigravity IDE daemon not found' }));
      return;
    }

    const quotaReq = http.request({
      hostname: '127.0.0.1',
      port: hub.httpPort,
      path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': hub.csrfToken
      },
      timeout: 5000
    }, (quotaRes) => {
      let data = '';
      quotaRes.on('data', c => data += c);
      quotaRes.on('end', () => {
        res.writeHead(quotaRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });

    quotaReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    quotaReq.write(JSON.stringify({}));
    quotaReq.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[Antigravity Bridge] Listening on http://127.0.0.1:${BRIDGE_PORT}`);
  const hub = getLatestHubInfo();
  if (hub) {
    console.log(`[Antigravity Bridge] Connected to IDE on port ${hub.httpPort} (PID: ${hub.pid})`);
  } else {
    console.log('[Antigravity Bridge] Waiting for Antigravity IDE to start...');
  }
});
