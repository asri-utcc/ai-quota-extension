const GEMINI_ORIGIN = 'https://gemini.google.com';
const GEMINI_RPC_QUOTA = 'qpEbW';
const GEMINI_COMPUTE_ACTION = 2;
const GEMINI_ARGS_COMPUTE = JSON.stringify([[[1, 2]]]);
const GEMINI_ARGS_ALL = '[]';
const SHORT_WINDOW_MAX_MS = 6 * 60 * 60 * 1000;
const GEMINI_TOKENS_TTL_MS = 20 * 60 * 1000;

// Google Cloud Code / Antigravity OAuth constants (optional)
const GOOGLE_CLIENT_ID = '';
const GOOGLE_CLIENT_SECRET = '';
const DEFAULT_ANTIGRAVITY_PORT = 63071;
const DEFAULT_ANTIGRAVITY_CSRF = '322de770-01f9-4ce2-b342-a8240b626194';
const DEFAULT_ANTIGRAVITY_REFRESH_TOKEN = '';

let geminiReqSeq = Math.floor(Math.random() * 9000) + 1000;
const geminiTokensCache = new Map();
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function ensureGeminiOriginRule() {
  if (!chrome?.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [101],
      addRules: [{
        id: 101,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'origin', operation: 'set', value: GEMINI_ORIGIN },
            { header: 'referer', operation: 'set', value: `${GEMINI_ORIGIN}/app` }
          ]
        },
        condition: {
          urlFilter: '||gemini.google.com/',
          resourceTypes: ['xmlhttprequest']
        }
      }]
    });
  } catch (_) {}
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled?.addListener(() => { ensureGeminiOriginRule(); });
  chrome.runtime.onStartup?.addListener(() => { ensureGeminiOriginRule(); });
  ensureGeminiOriginRule();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_ALL_USAGE') {
      fetchAllUsage()
        .then((data) => sendResponse(data))
        .catch((err) => sendResponse({
          claude: { error: 'SYS_ERROR' },
          gemini: { error: 'SYS_ERROR' },
          minimax: { error: err?.message || 'SYS_ERROR' },
          codex: { error: 'SYS_ERROR' }
        }));
      return true;
    }

    if (request.action === 'AUTODETECT_ANTIGRAVITY') {
      (async () => {
        try {
          const storage = await chrome.storage.local.get(['antigravityPort']);
          const hint = Number(storage.antigravityPort) || DEFAULT_ANTIGRAVITY_PORT;
          const discovered = await discoverAntigravityLocalServer(hint);
          if (discovered && discovered.token) {
            await chrome.storage.local.set({
              antigravityPort: String(discovered.port),
              antigravityCsrf: discovered.token
            });
            sendResponse({ success: true, port: discovered.port, token: discovered.token });
          } else {
            sendResponse({ success: false, error: 'NOT_FOUND' });
          }
        } catch (e) {
          sendResponse({ success: false, error: e?.message || 'SCAN_FAILED' });
        }
      })();
      return true;
    }
  });
}

async function fetchAllUsage() {
  let showClaude = true;
  let showGemini = true;
  let showMinimax = true;
  let showCodex = true;

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const storage = await chrome.storage.local.get(['showClaude', 'showGemini', 'showMinimax', 'showCodex']);
      if (storage.showClaude !== undefined) showClaude = Boolean(storage.showClaude);
      if (storage.showGemini !== undefined) showGemini = Boolean(storage.showGemini);
      if (storage.showMinimax !== undefined) showMinimax = Boolean(storage.showMinimax);
      if (storage.showCodex !== undefined) showCodex = Boolean(storage.showCodex);
    } catch (_) {}
  }

  const [claudeData, geminiData, minimaxData, codexData] = await Promise.all([
    showClaude ? getClaudeUsage() : Promise.resolve({ disabled: true }),
    showGemini ? getGeminiUsage() : Promise.resolve({ disabled: true }),
    showMinimax ? getMinimaxUsage() : Promise.resolve({ disabled: true }),
    showCodex ? getCodexUsage() : Promise.resolve({ disabled: true })
  ]);

  return {
    claude: claudeData,
    gemini: geminiData,
    minimax: minimaxData,
    codex: codexData
  };
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 8000, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, {
      ...fetchOptions,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

function toValidEpochMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  let ms = null;
  if (typeof value === 'number') {
    ms = value < 1e11 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const num = Number(value);
    if (Number.isFinite(num) && value.trim() !== '') {
      ms = num < 1e11 ? num * 1000 : num;
    } else {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) ms = parsed;
    }
  }
  if (!ms || !Number.isFinite(ms) || ms <= now) return null;
  return ms;
}

function formatShortReset(epochMs, now = Date.now()) {
  if (!epochMs || epochMs <= now) return null;
  const totalSec = Math.max(0, Math.floor((epochMs - now) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const timeStr = new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  return `${durStr} (${timeStr})`;
}

function formatWeeklyReset(epochMs, now = Date.now()) {
  if (!epochMs || epochMs <= now) return null;
  const totalSec = Math.max(0, Math.floor((epochMs - now) / 1000));
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const dateStr = new Date(epochMs).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const durStr = days > 0 ? `${days}d ${hrs}h` : (hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`);
  return `${durStr} (${dateStr})`;
}

function buildUsageResult(fiveHourPct, fiveHourEpoch, weeklyPct, weeklyEpoch, forceExhausted = false, now = Date.now()) {
  const safe5h = Math.min(100, Math.max(0, Number(fiveHourPct) || 0));
  const safeWk = Math.min(100, Math.max(0, Number(weeklyPct) || 0));
  const valid5hEpoch = toValidEpochMs(fiveHourEpoch, now);
  const validWkEpoch = toValidEpochMs(weeklyEpoch, now);

  const is5hExhausted = forceExhausted || safe5h >= 100;
  const isWkExhausted = safeWk >= 100;
  const isExhausted = is5hExhausted || isWkExhausted;
  const exhaustedWindow = is5hExhausted ? '5H' : (isWkExhausted ? 'WEEKLY' : null);
  const targetResetEpoch = is5hExhausted
    ? (valid5hEpoch || validWkEpoch)
    : (isWkExhausted ? (validWkEpoch || valid5hEpoch) : valid5hEpoch);

  return {
    fiveHour: safe5h,
    weekly: safeWk,
    isExhausted,
    exhaustedWindow,
    targetResetEpoch,
    fiveHourResetEpoch: valid5hEpoch,
    weeklyResetEpoch: validWkEpoch,
    fiveHourResetText: formatShortReset(valid5hEpoch, now),
    weeklyResetText: formatWeeklyReset(validWkEpoch, now)
  };
}

// ============================================================================
// 1. CLAUDE.AI
// ============================================================================
function parseClaudeUsage(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;

  let fiveHourPct = null;
  let fiveHourEpoch = null;
  let weeklyPct = null;
  let weeklyEpoch = null;

  if (Array.isArray(data.limits) && data.limits.length > 0) {
    let scopedWeeklyBest = null;
    for (const entry of data.limits) {
      if (!entry || typeof entry !== 'object') continue;
      const rawPct = entry.percent ?? entry.utilization ?? entry.percentage;
      const rawReset = entry.resets_at ?? entry.resetsAt;
      const resetMs = toValidEpochMs(rawReset, now);
      const isExpired = rawReset && !resetMs;
      const pct = isExpired ? 0 : Math.max(0, Number(rawPct) || 0);

      if (entry.kind === 'session' || entry.kind === 'five_hour') {
        fiveHourPct = pct;
        fiveHourEpoch = resetMs;
      } else if (entry.kind === 'weekly_all' || entry.kind === 'seven_day') {
        weeklyPct = pct;
        weeklyEpoch = resetMs;
      } else if (entry.kind === 'weekly_scoped') {
        if (!scopedWeeklyBest || pct > scopedWeeklyBest.pct) {
          scopedWeeklyBest = { pct, resetMs };
        }
      }
    }
    if (weeklyPct === null && scopedWeeklyBest) {
      weeklyPct = scopedWeeklyBest.pct;
      weeklyEpoch = scopedWeeklyBest.resetMs;
    }
  }

  const root = data.rate_limits && typeof data.rate_limits === 'object' ? data.rate_limits : data;

  const extractNested = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const rawPct = obj.utilization ?? obj.percent ?? obj.used_percentage ?? obj.percentage;
    if (rawPct === undefined || rawPct === null) return null;
    const rawReset = obj.resets_at ?? obj.resetsAt;
    const resetMs = toValidEpochMs(rawReset, now);
    const isExpired = rawReset && !resetMs;
    return {
      pct: isExpired ? 0 : Math.max(0, Number(rawPct) || 0),
      resetMs
    };
  };

  if (fiveHourPct === null) {
    const fh = extractNested(root.five_hour || root.session);
    if (fh) {
      fiveHourPct = fh.pct;
      fiveHourEpoch = fh.resetMs;
    }
  }

  if (weeklyPct === null) {
    const wkCandidates = [
      extractNested(root.seven_day || root.weekly),
      extractNested(root.seven_day_sonnet),
      extractNested(root.seven_day_opus)
    ].filter(Boolean);

    if (wkCandidates.length > 0) {
      const primary = wkCandidates[0];
      const highest = wkCandidates.reduce((a, b) => (b.pct > a.pct ? b : a), primary);
      const chosen = primary.pct > 0 ? primary : highest;
      weeklyPct = chosen.pct;
      weeklyEpoch = chosen.resetMs;
    }
  }

  if (fiveHourPct === null && (data.session_percentage != null || data.five_hour_percent != null)) {
    const resetMs = toValidEpochMs(data.session_resets_at ?? data.five_hour_resets_at, now);
    fiveHourPct = Number(data.session_percentage ?? data.five_hour_percent) || 0;
    fiveHourEpoch = resetMs;
  }

  if (weeklyPct === null && (data.weekly_percentage != null || data.seven_day_percent != null)) {
    const resetMs = toValidEpochMs(data.weekly_resets_at ?? data.seven_day_resets_at, now);
    weeklyPct = Number(data.weekly_percentage ?? data.seven_day_percent) || 0;
    weeklyEpoch = resetMs;
  }

  const hasAnyLimitData = fiveHourPct !== null || weeklyPct !== null || Array.isArray(data.limits) || ('five_hour' in root) || ('seven_day' in root);
  if (!hasAnyLimitData) return null;

  return buildUsageResult(fiveHourPct ?? 0, fiveHourEpoch, weeklyPct ?? 0, weeklyEpoch, false, now);
}

async function getClaudeUsage() {
  try {
    const [sessionCookie, activeOrgCookie] = await Promise.all([
      chrome.cookies.get({ url: 'https://claude.ai', name: 'sessionKey' }),
      chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' })
    ]);

    if (!sessionCookie || !sessionCookie.value) {
      return { error: 'Not Logged In' };
    }

    const orgRes = await fetchWithTimeout('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (orgRes.status === 401 || orgRes.status === 403) {
      return { error: 'Auth / Cloudflare' };
    }
    if (!orgRes.ok) {
      return { error: `HTTP ${orgRes.status}` };
    }

    const orgText = await orgRes.text();
    if (/^\s*<(!doctype|html)/i.test(orgText)) {
      return { error: 'Cloudflare Block' };
    }

    const orgs = JSON.parse(orgText);
    if (!Array.isArray(orgs) || orgs.length === 0) {
      return { error: 'No Org' };
    }

    const preferredOrgUuid = activeOrgCookie?.value;
    const scoreOrg = (org) => {
      let score = 0;
      if (preferredOrgUuid && org?.uuid === preferredOrgUuid) score += 100;
      const caps = Array.isArray(org?.capabilities) ? org.capabilities.join(' ').toLowerCase() : '';
      if (caps.includes('claude_max') || caps.includes('max')) score += 40;
      if (caps.includes('claude_pro') || caps.includes('pro')) score += 30;
      if (caps.includes('chat')) score += 20;
      return score;
    };

    const sortedOrgs = [...orgs].sort((a, b) => scoreOrg(b) - scoreOrg(a));
    let fallbackParsed = null;
    let lastHttpError = null;

    for (const org of sortedOrgs.slice(0, 4)) {
      const orgId = org?.uuid;
      if (!orgId) continue;

      const usageRes = await fetchWithTimeout(`https://claude.ai/api/organizations/${orgId}/usage`, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (!usageRes.ok) {
        lastHttpError = `HTTP ${usageRes.status}`;
        continue;
      }

      const usageText = await usageRes.text();
      if (/^\s*<(!doctype|html)/i.test(usageText)) {
        lastHttpError = 'Cloudflare Block';
        continue;
      }

      const data = JSON.parse(usageText);
      const parsed = parseClaudeUsage(data);
      if (parsed) {
        if (parsed.fiveHour > 0 || parsed.weekly > 0 || parsed.fiveHourResetEpoch || parsed.weeklyResetEpoch) {
          return parsed;
        }
        if (!fallbackParsed) fallbackParsed = parsed;
      }
    }

    if (fallbackParsed) return fallbackParsed;
    return { error: lastHttpError || 'No Usage Data' };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'Timeout' : 'Net Error' };
  }
}

// ============================================================================
// 2. GEMINI PRO (Antigravity Multi-Pool Quota & Web Fallback)
// ============================================================================
function parseAntigravityGroups(groups, now = Date.now()) {
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const pools = [];
  let worstResetEpoch = null;
  let hasAnyExhausted = false;
  let exhaustedWindow = null;

  let highest5hPct = 0;
  let highestWkPct = 0;
  let best5hEpoch = null;
  let bestWkEpoch = null;

  for (const group of groups) {
    const groupName = group.displayName || 'Quota Pool';
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const metrics = [];

    for (const b of buckets) {
      const fraction = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1;
      const pct = Math.min(100, Math.max(0, Math.round((1 - fraction) * 100)));
      const resetMs = toValidEpochMs(b.resetTime, now);

      const is5h = b.window === '5h' || (b.bucketId && b.bucketId.includes('5h')) || (b.displayName && b.displayName.toLowerCase().includes('five hour'));
      const label = b.displayName || (is5h ? '5-Hour Limit' : 'Weekly Limit');

      const resetText = is5h ? formatShortReset(resetMs, now) : formatWeeklyReset(resetMs, now);

      if (is5h) {
        if (pct >= highest5hPct) {
          highest5hPct = pct;
          best5hEpoch = resetMs;
        }
      } else {
        if (pct >= highestWkPct) {
          highestWkPct = pct;
          bestWkEpoch = resetMs;
        }
      }

      if (pct >= 100) {
        hasAnyExhausted = true;
        if (!exhaustedWindow) exhaustedWindow = is5h ? '5H' : 'WEEKLY';
        if (resetMs && (!worstResetEpoch || resetMs < worstResetEpoch)) {
          worstResetEpoch = resetMs;
        }
      }

      metrics.push({
        id: b.bucketId || label,
        label,
        pct,
        resetEpoch: resetMs,
        resetText: resetText ? `in ${resetText}` : '-'
      });
    }

    pools.push({
      name: groupName,
      description: group.description || '',
      metrics
    });
  }

  return {
    pools,
    fiveHour: highest5hPct,
    weekly: highestWkPct,
    isExhausted: hasAnyExhausted,
    exhaustedWindow,
    targetResetEpoch: worstResetEpoch || best5hEpoch || bestWkEpoch,
    fiveHourResetEpoch: best5hEpoch,
    weeklyResetEpoch: bestWkEpoch,
    fiveHourResetText: formatShortReset(best5hEpoch, now),
    weeklyResetText: formatWeeklyReset(bestWkEpoch, now)
  };
}

const KNOWN_ANTIGRAVITY_CSRF = '322de770-01f9-4ce2-b342-a8240b626194';

async function probeAntigravityPort(p, timeoutMs = 250) {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${p}/`, { timeout: timeoutMs });
    if (!res.ok && res.status !== 200) return null;
    const html = await res.text();
    if (html && (html.includes('csrfToken') || html.includes('__APP_CONFIG__'))) {
      const m = html.match(/"csrfToken"\s*:\s*"([^"]+)"/);
      if (m && m[1]) {
        return { port: p, token: m[1] };
      }
    }
  } catch (_) {}
  return null;
}

async function discoverAntigravityLocalServer(hintPort) {
  const priorityPorts = [...new Set([
    Number(hintPort) || 0,
    62937, 63071, 63069, 63070, 62936, 62938, 62935, 63072, 63073, 63074, 63075
  ])].filter((p) => p > 0);

  // 1. Check priority ports first
  for (const p of priorityPorts) {
    const found = await probeAntigravityPort(p, 180);
    if (found && found.token) return found;
  }

  // 2. Scan window 62850 - 63200 in parallel batches of 30
  const range1 = [];
  for (let p = 62850; p <= 63200; p++) {
    if (!priorityPorts.includes(p)) range1.push(p);
  }
  for (let i = 0; i < range1.length; i += 30) {
    const batch = range1.slice(i, i + 30);
    const results = await Promise.all(batch.map((p) => probeAntigravityPort(p, 220)));
    const hit = results.find((r) => r && r.token);
    if (hit) return hit;
  }

  // 3. Scan secondary window 63201 - 63500
  const range2 = [];
  for (let p = 63201; p <= 63500; p++) range2.push(p);
  for (let i = 0; i < range2.length; i += 30) {
    const batch = range2.slice(i, i + 30);
    const results = await Promise.all(batch.map((p) => probeAntigravityPort(p, 220)));
    const hit = results.find((r) => r && r.token);
    if (hit) return hit;
  }

  return null;
}

async function callAntigravityQuotaRpc(port, token) {
  const url = `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      ...(token ? { 'X-Codeium-Csrf-Token': token } : {})
    },
    body: JSON.stringify({}),
    timeout: 3500
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}`);
  }

  const data = await res.json();
  const groups = data?.response?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('NO_GROUPS');
  }

  return parseAntigravityGroups(groups);
}

async function getAntigravityLocalUsage(port = DEFAULT_ANTIGRAVITY_PORT, csrfToken = DEFAULT_ANTIGRAVITY_CSRF) {
  const initialPort = Number(port) || DEFAULT_ANTIGRAVITY_PORT;
  const initialToken = (csrfToken || '').trim();

  // Attempt 1: Try current configured port and token
  if (initialToken) {
    try {
      return await callAntigravityQuotaRpc(initialPort, initialToken);
    } catch (_) {}
  }

  // Attempt 2: Auto-discover active Antigravity port and token dynamically
  const discovered = await discoverAntigravityLocalServer(initialPort);
  if (discovered && discovered.token) {
    // Persist discovered credentials so next request is instant
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({
        antigravityPort: String(discovered.port),
        antigravityCsrf: discovered.token
      }).catch(() => {});
    }

    try {
      return await callAntigravityQuotaRpc(discovered.port, discovered.token);
    } catch (_) {}
  }

  throw new Error('LOCAL_ANTIGRAVITY_UNAVAILABLE');
}

async function getAntigravityOAuthAccessToken(refreshToken) {
  if (!refreshToken) return null;
  let clientId = GOOGLE_CLIENT_ID;
  let clientSecret = GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const creds = await chrome.storage.local.get(['googleClientId', 'googleClientSecret']);
        if (creds.googleClientId) clientId = creds.googleClientId;
        if (creds.googleClientSecret) clientSecret = creds.googleClientSecret;
      } catch (_) {}
    }
  }
  if (!clientId || !clientSecret) return null;

  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    timeout: 8000
  });

  if (!res.ok) {
    throw new Error('OAuth Refresh Failed');
  }

  const data = await res.json();
  if (!data?.access_token) {
    throw new Error('No Access Token');
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(60000, ((data.expires_in || 3600) - 120) * 1000);
  return cachedAccessToken;
}

async function getAntigravityCloudCodeUsage(refreshToken) {
  const accessToken = await getAntigravityOAuthAccessToken(refreshToken);
  if (!accessToken) throw new Error('No Token');

  const sumRes = await fetchWithTimeout('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/2.29.0 windows/amd64'
    },
    body: JSON.stringify({}),
    timeout: 8000
  });

  if (!sumRes.ok) {
    throw new Error(`CloudCode HTTP ${sumRes.status}`);
  }

  const data = await sumRes.json();
  const groups = data?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('NO_GROUPS');
  }

  return parseAntigravityGroups(groups);
}

// Gemini Web Fallback (gemini.google.com)
function parseGeminiQuotaRow(r) {
  if (!Array.isArray(r)) return null;
  const ctx = Array.isArray(r[0]) ? r[0] : [];
  const action = Number(ctx[1]);
  if (!Number.isFinite(action)) return null;

  const unit = Number(r[1]);
  const rawPct = Number(r[2]);
  const remaining = Number(r[4]);
  const limit = Number(r[5]);

  let pct = Number.isFinite(rawPct) ? Math.max(0, rawPct) : null;
  if (pct === null && Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
    pct = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  }

  let resetsAt = null;
  if (Array.isArray(r[3]) && typeof r[3][0] === 'number') {
    resetsAt = r[3][0] * 1000 + Math.round((r[3][1] || 0) / 1e6);
  }

  return {
    mode: Number(ctx[0]),
    action,
    unit: Number.isFinite(unit) ? unit : 0,
    pct: pct ?? 0,
    resetsAt,
    remaining: Number.isFinite(remaining) ? remaining : null,
    limit: Number.isFinite(limit) ? limit : null
  };
}

function parseGeminiBatchText(text) {
  const rows = [];
  let sawQuota = false;
  let rpcError = null;

  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('[')) continue;
    let arr;
    try {
      arr = JSON.parse(s);
    } catch (_) {
      continue;
    }
    if (!Array.isArray(arr)) continue;

    for (const env of arr) {
      if (!Array.isArray(env) || env[0] !== 'wrb.fr' || env[1] !== GEMINI_RPC_QUOTA) continue;
      sawQuota = true;
      if (Array.isArray(env[5]) && env[5][0] != null) {
        rpcError = env[5][0];
        continue;
      }
      if (typeof env[2] === 'string') {
        try {
          const d = JSON.parse(env[2]);
          if (Array.isArray(d) && Array.isArray(d[0])) {
            rows.push(...d[0]);
          }
        } catch (_) {}
      }
    }
  }

  return { sawQuota, rows, rpcError };
}

function classifyGeminiRows(rawRows, now = Date.now()) {
  const parsedRows = (rawRows || []).map(parseGeminiQuotaRow).filter(Boolean);
  if (parsedRows.length === 0) return null;

  const compRows = parsedRows.filter((r) => r.action === GEMINI_COMPUTE_ACTION);
  let shortWin = null;
  let weeklyWin = null;

  if (compRows.length > 0) {
    const byUnit = new Map();
    for (const r of compRows) {
      byUnit.set(r.unit, r);
    }
    const list = [...byUnit.values()].sort((a, b) => (a.resetsAt || Infinity) - (b.resetsAt || Infinity));

    if (list.length >= 2) {
      shortWin = list[0];
      weeklyWin = list[list.length - 1];
    } else if (list.length === 1) {
      const only = list[0];
      const dist = only.resetsAt ? only.resetsAt - now : 0;
      if (dist > SHORT_WINDOW_MAX_MS || only.unit === 2) {
        weeklyWin = only;
      } else {
        shortWin = only;
      }
    }
  } else {
    const validCounters = parsedRows.filter((r) => r.limit && r.limit > 0);
    if (validCounters.length > 0) {
      const sorted = [...validCounters].sort((a, b) => b.pct - a.pct);
      shortWin = sorted[0];
    }
  }

  if (!shortWin && !weeklyWin) return null;

  const shortExpired = shortWin?.resetsAt && shortWin.resetsAt <= now;
  const weeklyExpired = weeklyWin?.resetsAt && weeklyWin.resetsAt <= now;

  const fiveHourPct = shortWin ? (shortExpired ? 0 : shortWin.pct) : 0;
  const fiveHourEpoch = shortWin && !shortExpired ? shortWin.resetsAt : null;

  const weeklyPct = weeklyWin ? (weeklyExpired ? 0 : weeklyWin.pct) : 0;
  const weeklyEpoch = weeklyWin && !weeklyExpired ? weeklyWin.resetsAt : null;

  return buildUsageResult(fiveHourPct, fiveHourEpoch, weeklyPct, weeklyEpoch, false, now);
}

function geminiPrefixFor(authuser) {
  const idx = Number(authuser);
  return Number.isFinite(idx) && idx > 0 ? `/u/${idx}` : '';
}

async function getGeminiTokens(authuser = 0, force = false) {
  const key = String(authuser || 0);
  const cached = geminiTokensCache.get(key);
  if (!force && cached && Date.now() - cached.at < GEMINI_TOKENS_TTL_MS) {
    return cached;
  }

  const res = await fetchWithTimeout(`${GEMINI_ORIGIN}${geminiPrefixFor(authuser)}/app`, {
    credentials: 'include',
    redirect: 'follow',
    timeout: 9000
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (/accounts\.google\.com/i.test(res.url)) {
    throw new Error('Not Logged In');
  }

  const html = await res.text();
  const grab = (k) => {
    const m = new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(html);
    return m ? m[1] : null;
  };

  const tokens = {
    at: Date.now(),
    xsrf: grab('SNlM0e'),
    bl: grab('cfb2h'),
    sid: grab('FdrFJe')
  };

  if (!tokens.xsrf) {
    throw new Error('Not Logged In');
  }

  geminiTokensCache.set(key, tokens);
  return tokens;
}

async function callGeminiBatchQuota(authuser, tokens, args) {
  const qs = new URLSearchParams({
    rpcids: GEMINI_RPC_QUOTA,
    'source-path': '/app',
    bl: tokens.bl || '',
    'f.sid': tokens.sid || '',
    hl: 'en',
    _reqid: String((geminiReqSeq += 100000)),
    rt: 'c'
  });

  const body = new URLSearchParams({
    'f.req': JSON.stringify([[[GEMINI_RPC_QUOTA, args, null, 'generic']]]),
    at: tokens.xsrf
  });

  const res = await fetchWithTimeout(
    `${GEMINI_ORIGIN}${geminiPrefixFor(authuser)}/_/BardChatUi/data/batchexecute?${qs.toString()}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1'
      },
      body: body.toString(),
      timeout: 9000
    }
  );

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error(`AUTH_${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return parseGeminiBatchText(await res.text());
}

async function fetchGeminiQuotaForAccount(authuser) {
  let tokens = await getGeminiTokens(authuser, false);

  const runBatch = async () => {
    const [compRes, allRes] = await Promise.allSettled([
      callGeminiBatchQuota(authuser, tokens, GEMINI_ARGS_COMPUTE),
      callGeminiBatchQuota(authuser, tokens, GEMINI_ARGS_ALL)
    ]);

    if (compRes.status === 'rejected' && allRes.status === 'rejected') {
      throw compRes.reason;
    }

    const rows = [];
    let sawAny = false;
    for (const r of [compRes, allRes]) {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.sawQuota) sawAny = true;
        if (Array.isArray(r.value.rows)) rows.push(...r.value.rows);
      }
    }

    if (!sawAny && rows.length === 0) {
      throw new Error('NO_QUOTA_ROWS');
    }
    return rows;
  };

  let rows;
  try {
    rows = await runBatch();
  } catch (err) {
    tokens = await getGeminiTokens(authuser, true);
    rows = await runBatch();
  }

  const classified = classifyGeminiRows(rows);
  if (classified) return classified;

  return buildUsageResult(0, null, 0, null, false);
}

async function getGeminiUsage() {
  try {
    const storage = await chrome.storage.local.get([
      'antigravityPort',
      'antigravityCsrf',
      'antigravityRefreshToken',
      'geminiAccountIndex',
      'geminiSourceMode',
      'lastAntigravityPools',
      'lastAntigravityTimestamp'
    ]);

    const sourceMode = storage.geminiSourceMode || 'auto'; // 'auto' | 'antigravity' | 'web'
    const port = Number(storage.antigravityPort) || DEFAULT_ANTIGRAVITY_PORT;
    const csrfToken = (storage.antigravityCsrf || DEFAULT_ANTIGRAVITY_CSRF).trim();
    const refreshToken = (storage.antigravityRefreshToken || DEFAULT_ANTIGRAVITY_REFRESH_TOKEN).trim();

    // 1. Primary: Try Local Antigravity Language Server (unless forced to 'web')
    if (sourceMode !== 'web') {
      try {
        const localResult = await getAntigravityLocalUsage(port, csrfToken);
        if (localResult && localResult.pools && localResult.pools.length > 0) {
          localResult.source = 'antigravity';
          // Cache pools for resilient fallback across IDE restarts
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.set({
              lastAntigravityPools: localResult.pools,
              lastAntigravityTimestamp: Date.now()
            }).catch(() => {});
          }
          return localResult;
        }
      } catch (_) {}

      // 2. Secondary: Try Google Cloud Code OAuth API with Refresh Token
      if (refreshToken) {
        try {
          const cloudResult = await getAntigravityCloudCodeUsage(refreshToken);
          if (cloudResult && cloudResult.pools && cloudResult.pools.length > 0) {
            cloudResult.source = 'antigravity_cloud';
            return cloudResult;
          }
        } catch (_) {}
      }

      // Resilient Cache: If Antigravity was running recently (within 48 hours),
      // DO NOT erase the pools to 0%! Return cached pools with isCached flag
      if (Array.isArray(storage.lastAntigravityPools) && storage.lastAntigravityPools.length > 0) {
        const ageMs = Date.now() - (storage.lastAntigravityTimestamp || 0);
        if (ageMs < 48 * 3600 * 1000) {
          return {
            pools: storage.lastAntigravityPools,
            source: 'antigravity',
            isCached: true,
            cachedTimestamp: storage.lastAntigravityTimestamp || Date.now()
          };
        }
      }

      // If source mode is strictly 'antigravity', do not fall through to Gemini Web
      if (sourceMode === 'antigravity') {
        return { error: 'กรุณาเปิด Antigravity IDE (ไม่พบการเชื่อมต่อ)' };
      }
    }

    // 3. Fallback: Try Gemini Web session cookies
    await ensureGeminiOriginRule();
    const rawIdx = (storage.geminiAccountIndex ?? '').toString().trim();
    const candidates = rawIdx !== '' && Number.isFinite(Number(rawIdx))
      ? [Number(rawIdx)]
      : [0, 1];

    let lastError = null;
    let zeroFallback = null;

    for (const authuser of candidates) {
      try {
        const result = await fetchGeminiQuotaForAccount(authuser);
        if (result) {
          result.source = 'gemini_web';
          if (result.fiveHour > 0 || result.weekly > 0 || result.fiveHourResetEpoch || result.weeklyResetEpoch || candidates.length === 1) {
            return result;
          }
          if (!zeroFallback) zeroFallback = result;
        }
      } catch (e) {
        const msg = e?.message || 'Net Error';
        if (msg === 'Not Logged In' || msg.startsWith('AUTH_')) {
          lastError = 'Not Logged In';
        } else {
          lastError = msg;
        }
      }
    }

    if (zeroFallback) {
      zeroFallback.source = 'gemini_web';
      return zeroFallback;
    }
    return { error: lastError || 'เชื่อมต่อไม่ได้ (กรุณาเปิด Antigravity หรือล็อกอินเว็บ Gemini)' };
  } catch (err) {
    return { error: err?.message || 'Net Error' };
  }
}

// ============================================================================
// 3. MINIMAX (Coding Plan & Token Plan)
// ============================================================================
async function getMinimaxUsage() {
  try {
    const storage = await chrome.storage.local.get(['minimaxApiKey', 'minimaxGroupId', 'minimaxHost']);
    const apiKey = (storage.minimaxApiKey || '').trim();
    const groupId = (storage.minimaxGroupId || '').trim();
    const host = (storage.minimaxHost || 'https://api.minimax.io').trim().replace(/\/+$/, '');

    if (!apiKey) return { error: 'Missing Key' };

    const authHeader = apiKey.replace(/^Bearer\s+/i, '');
    const headers = {
      'Authorization': `Bearer ${authHeader}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Referer': 'https://platform.minimax.io/user-center/payment/coding-plan'
    };

    const groupQuery = groupId ? `?GroupId=${encodeURIComponent(groupId)}` : '';
    // Preserve endpoint order: token_plan first without query param, then coding_plan, etc.
    const endpoints = [
      `${host}/v1/token_plan/remains`,
      `${host}/v1/api/openplatform/coding_plan/remains${groupQuery}`,
      `${host}/v1/token_plan/remains${groupQuery}`,
      `${host}/v1/coding_plan/remains${groupQuery}`
    ];

    let lastError = null;

    for (const url of endpoints) {
      try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers });

        if (res.status === 401 || res.status === 403) {
          lastError = 'Invalid Key';
          continue;
        }

        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }

        const payload = await res.json();
        const baseStatus = payload?.base_resp?.status_code;
        const baseMsg = (payload?.base_resp?.status_msg || '').toLowerCase();

        if (baseStatus !== undefined && baseStatus !== 0) {
          if (baseStatus === 1004 || baseStatus === 1002 || baseMsg.includes('key') || baseMsg.includes('auth') || baseMsg.includes('login') || baseMsg.includes('token')) {
            lastError = 'Invalid Key';
          } else {
            lastError = payload?.base_resp?.status_msg || `Code ${baseStatus}`;
          }
          continue;
        }

        const parsed = parseMinimaxPayload(payload);
        if (parsed) {
          return parsed;
        }
        lastError = 'Invalid Format';
      } catch (e) {
        lastError = e?.name === 'AbortError' ? 'Timeout' : 'Net Error';
      }
    }

    return { error: lastError || 'Endpoint Error' };
  } catch (err) {
    return { error: err?.message || 'SYS_ERROR' };
  }
}

function parseMinimaxPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;

  const root = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  let target = root;

  if (Array.isArray(root.model_remains) && root.model_remains.length > 0) {
    const general = root.model_remains.find((item) => item?.model_name === 'general' || item?.model === 'general');
    target = general || root.model_remains[0];
  } else if (Array.isArray(payload.model_remains) && payload.model_remains.length > 0) {
    const general = payload.model_remains.find((item) => item?.model_name === 'general' || item?.model === 'general');
    target = general || payload.model_remains[0];
  }

  if (!target || typeof target !== 'object') return null;

  const intervalStatus = Number(target.current_interval_status); // 2=exhausted, 3=available
  const remPct5hRaw = target.current_interval_remaining_percent;
  const total5h = Number(target.current_interval_total_count);
  const count5h = Number(target.current_interval_usage_count);

  let remaining5h = 100;
  if (remPct5hRaw !== undefined && remPct5hRaw !== null && remPct5hRaw !== '') {
    remaining5h = parseFloat(remPct5hRaw);
  } else if (Number.isFinite(total5h) && total5h > 0 && Number.isFinite(count5h) && count5h >= 0) {
    remaining5h = (Math.min(total5h, count5h) / total5h) * 100;
  } else if (intervalStatus === 2) {
    remaining5h = 0;
  } else if (intervalStatus === 3) {
    remaining5h = 100;
  }

  const isExhausted5h = (intervalStatus === 2) || (remaining5h <= 0);
  const usage5h = isExhausted5h ? 100 : Math.min(100, Math.max(0, 100 - remaining5h));

  // 5-hour reset epoch calculation
  const rawRemTime5h = Number(target.remains_time);
  const rawEndTime5h = Number(target.end_time);
  let fiveHourEpoch = null;
  if (Number.isFinite(rawEndTime5h) && rawEndTime5h > now) {
    fiveHourEpoch = rawEndTime5h < 1e11 ? rawEndTime5h * 1000 : rawEndTime5h;
  } else if (Number.isFinite(rawRemTime5h) && rawRemTime5h > 0) {
    const durationMs = rawRemTime5h <= 18000 ? rawRemTime5h * 1000 : rawRemTime5h;
    fiveHourEpoch = now + durationMs;
  }

  // Weekly usage calculation
  const remPctWkRaw = target.current_weekly_remaining_percent;
  const totalWk = Number(target.current_weekly_total_count);
  const countWk = Number(target.current_weekly_usage_count);

  let remainingWk = 100;
  if (remPctWkRaw !== undefined && remPctWkRaw !== null && remPctWkRaw !== '') {
    remainingWk = parseFloat(remPctWkRaw);
  } else if (Number.isFinite(totalWk) && totalWk > 0 && Number.isFinite(countWk) && countWk >= 0) {
    remainingWk = (Math.min(totalWk, countWk) / totalWk) * 100;
  }
  const usageWk = Math.min(100, Math.max(0, 100 - remainingWk));

  // Weekly reset epoch calculation
  const rawRemTimeWk = Number(target.weekly_remains_time);
  const rawEndTimeWk = Number(target.weekly_end_time);
  let weeklyEpoch = null;
  if (Number.isFinite(rawEndTimeWk) && rawEndTimeWk > now) {
    weeklyEpoch = rawEndTimeWk < 1e11 ? rawEndTimeWk * 1000 : rawEndTimeWk;
  } else if (Number.isFinite(rawRemTimeWk) && rawRemTimeWk > 0) {
    const durationMs = rawRemTimeWk <= 7 * 86400 ? rawRemTimeWk * 1000 : rawRemTimeWk;
    weeklyEpoch = now + durationMs;
  }

  return buildUsageResult(usage5h, fiveHourEpoch, usageWk, weeklyEpoch, isExhausted5h, now);
}

// ============================================================================
// 4. OPENAI CODEX (ChatGPT / Codex CLI wham/usage)
// ============================================================================
function parseCodexUsage(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;

  const rateLimits = data.rate_limits || data;
  let fiveHourPct = null;
  let fiveHourEpoch = null;
  let weeklyPct = null;
  let weeklyEpoch = null;

  const extractRateLimit = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const rawPct = obj.used_percent ?? obj.utilization ?? obj.percentage ?? obj.percent;
    const rawReset = obj.resets_at ?? obj.resetsAt ?? obj.reset_at;
    const resetMs = toValidEpochMs(rawReset, now);
    const isExpired = rawReset && !resetMs;
    return {
      pct: isExpired ? 0 : Math.max(0, Number(rawPct) || 0),
      resetMs
    };
  };

  const fh = extractRateLimit(rateLimits.five_hour || rateLimits.primary_window || rateLimits.session);
  if (fh) {
    fiveHourPct = fh.pct;
    fiveHourEpoch = fh.resetMs;
  }

  const wk = extractRateLimit(rateLimits.seven_day || rateLimits.weekly || rateLimits.secondary_window);
  if (wk) {
    weeklyPct = wk.pct;
    weeklyEpoch = wk.resetMs;
  }

  const planType = (data.plan_type || '').toUpperCase() || 'CODEX';

  if (fiveHourPct === null && weeklyPct === null) {
    return null;
  }

  const res = buildUsageResult(fiveHourPct ?? 0, fiveHourEpoch, weeklyPct ?? 0, weeklyEpoch, false, now);
  res.planType = planType;
  return res;
}

async function getCodexUsage() {
  try {
    let accessToken = null;

    // 1. Check user-provided token from storage (e.g. from Settings)
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const storage = await chrome.storage.local.get(['codexAccessToken']);
        if (storage.codexAccessToken && storage.codexAccessToken.trim() !== '') {
          accessToken = storage.codexAccessToken.trim();
        }
      } catch (_) {}
    }

    // 2. If no custom token, try ChatGPT web session endpoint
    if (!accessToken) {
      try {
        const sessionRes = await fetchWithTimeout('https://chatgpt.com/api/auth/session', {
          credentials: 'include',
          timeout: 6000
        });

        if (sessionRes.ok) {
          const sessionData = await sessionRes.json();
          if (sessionData && sessionData.accessToken) {
            accessToken = sessionData.accessToken;
          }
        }
      } catch (_) {}
    }

    // 3. If we have a token, fetch wham/usage
    if (accessToken) {
      const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      };

      const usageRes = await fetchWithTimeout('https://chatgpt.com/backend-api/wham/usage', {
        headers,
        credentials: 'include',
        timeout: 8000
      });

      if (usageRes.ok) {
        const usageData = await usageRes.json();
        const parsed = parseCodexUsage(usageData);
        if (parsed) return parsed;
      } else if (usageRes.status === 401 || usageRes.status === 403) {
        return { error: 'Token Expired (Log in to ChatGPT)' };
      } else if (usageRes.status === 429) {
        return { error: 'Rate Limited (HTTP 429)' };
      }
    }

    // 4. Fallback check: Did user log in to ChatGPT?
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const sessionCookie = await chrome.cookies.get({
        url: 'https://chatgpt.com',
        name: '__Secure-next-auth.session-token'
      }).catch(() => null);

      if (!sessionCookie && !accessToken) {
        return { error: 'Not Logged In (ChatGPT)' };
      }
    }

    return { error: 'No Quota Data' };
  } catch (err) {
    return { error: err.message || 'Connection Error' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseClaudeUsage,
    parseGeminiQuotaRow,
    parseGeminiBatchText,
    classifyGeminiRows,
    parseAntigravityGroups,
    getAntigravityLocalUsage,
    getAntigravityCloudCodeUsage,
    parseMinimaxPayload,
    parseCodexUsage,
    getCodexUsage,
    formatShortReset,
    formatWeeklyReset,
    buildUsageResult
  };
}
