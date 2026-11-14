let countdownInterval = null;
const targetResetTimes = {
  claude: null,
  gemini: null,
  minimax: null,
  codex: null
};

const PROVIDER_PREFIX = {
  claude: 'cl',
  gemini: 'gm',
  minimax: 'mm',
  codex: 'cx'
};

const SLOT_COUNT = 7;
const SLOT_SIZE = 100 / SLOT_COUNT; // ~14.2857%

document.addEventListener('DOMContentLoaded', () => {
  // 1. Detect if running inside Chrome Side Panel
  const urlParams = new URLSearchParams(window.location.search);
  const isSidepanel = urlParams.get('view') === 'sidepanel';
  if (isSidepanel) {
    document.body.classList.add('is-sidepanel');
    const btnSidebar = document.getElementById('btn-open-sidebar');
    if (btnSidebar) {
      btnSidebar.innerHTML = '<span class="btn-icon">📌</span> SIDEBAR ACTIVE';
      btnSidebar.classList.add('btn-active-sidepanel');
      btnSidebar.disabled = true;
      btnSidebar.title = 'กำลังเปิดใช้งานในโหมด Sidebar';
    }
  }

  // 2. Button "Move to Sidebar"
  const btnOpenSidebar = document.getElementById('btn-open-sidebar');
  if (btnOpenSidebar) {
    btnOpenSidebar.addEventListener('click', () => {
      if (chrome?.sidePanel?.open) {
        chrome.windows.getCurrent((win) => {
          chrome.sidePanel.open({ windowId: win.id }, () => {
            window.close();
          });
        });
      } else {
        alert('บราวเซอร์นี้ไม่รองรับ Chrome Side Panel');
      }
    });
  }

  // 3. Settings Elements
  const settingsPanel = document.getElementById('settings-panel');
  const btnToggleSettings = document.getElementById('btn-toggle-settings');
  const btnSaveKey = document.getElementById('btn-save-key');

  const selectTheme = document.getElementById('theme-select');
  const toggleClaude = document.getElementById('toggle-claude');
  const toggleGemini = document.getElementById('toggle-gemini');
  const toggleMinimax = document.getElementById('toggle-minimax');
  const toggleCodex = document.getElementById('toggle-codex');

  const inputAgPort = document.getElementById('antigravity-port');
  const inputAgCsrf = document.getElementById('antigravity-csrf');
  const inputAgRefresh = document.getElementById('antigravity-refresh-token');
  const inputGmAccount = document.getElementById('gemini-account');
  const selectGmSourceMode = document.getElementById('gemini-source-mode');
  const btnAutoDetectAg = document.getElementById('btn-autodetect-antigravity');
  const autoDetectStatus = document.getElementById('autodetect-status');
  const inputMmKey = document.getElementById('minimax-key');
  const inputMmGroup = document.getElementById('minimax-group');
  const inputMmHost = document.getElementById('minimax-host');
  const inputCodexToken = document.getElementById('codex-token');
  const saveMsg = document.getElementById('save-msg');
  const btnRefresh = document.getElementById('btn-refresh');

  if (btnToggleSettings && settingsPanel) {
    btnToggleSettings.addEventListener('click', () => {
      const isHidden = window.getComputedStyle(settingsPanel).display === 'none';
      settingsPanel.style.display = isHidden ? 'block' : 'none';
    });
  }

  // Apply provider card visibility
  function applyProviderVisibility(provider, isVisible) {
    const card = document.getElementById(`card-${provider}`);
    if (card) {
      if (isVisible) {
        card.classList.remove('card-hidden');
      } else {
        card.classList.add('card-hidden');
        applyExhaustedState(provider, false, null, null);
      }
    }
  }

  function applyTheme(themeName) {
    const isMinimal = themeName === 'minimal';
    document.body.classList.toggle('theme-minimal', isMinimal);
    if (selectTheme) selectTheme.value = isMinimal ? 'minimal' : 'default';
  }

  // Load saved preferences
  chrome.storage.local.get([
    'theme',
    'showClaude',
    'showGemini',
    'showMinimax',
    'showCodex',
    'geminiSourceMode',
    'antigravityPort',
    'antigravityCsrf',
    'antigravityRefreshToken',
    'geminiAccountIndex',
    'minimaxApiKey',
    'minimaxGroupId',
    'minimaxHost',
    'codexAccessToken'
  ], (res) => {
    applyTheme(res.theme || 'default');

    const showClaude = res.showClaude !== false;
    const showGemini = res.showGemini !== false;
    const showMinimax = res.showMinimax !== false;
    const showCodex = res.showCodex !== false;

    if (toggleClaude) toggleClaude.checked = showClaude;
    if (toggleGemini) toggleGemini.checked = showGemini;
    if (toggleMinimax) toggleMinimax.checked = showMinimax;
    if (toggleCodex) toggleCodex.checked = showCodex;

    applyProviderVisibility('claude', showClaude);
    applyProviderVisibility('gemini', showGemini);
    applyProviderVisibility('minimax', showMinimax);
    applyProviderVisibility('codex', showCodex);

    if (selectGmSourceMode) selectGmSourceMode.value = res.geminiSourceMode || 'auto';
    if (inputAgPort) inputAgPort.value = res.antigravityPort || '49496';
    if (inputAgCsrf) inputAgCsrf.value = res.antigravityCsrf || '';
    if (inputAgRefresh) inputAgRefresh.value = res.antigravityRefreshToken || '';
    if (res.geminiAccountIndex !== undefined && inputGmAccount) {
      inputGmAccount.value = res.geminiAccountIndex;
    }
    if (res.minimaxApiKey && inputMmKey) inputMmKey.value = res.minimaxApiKey;
    if (res.minimaxGroupId && inputMmGroup) inputMmGroup.value = res.minimaxGroupId;
    if (inputMmHost) inputMmHost.value = res.minimaxHost || 'https://api.minimax.io';
    if (inputCodexToken) inputCodexToken.value = res.codexAccessToken || '';

    loadAllUsage();
  });

  // Antigravity Port Auto-Detect Button Listener
  if (btnAutoDetectAg) {
    btnAutoDetectAg.addEventListener('click', () => {
      if (autoDetectStatus) {
        autoDetectStatus.style.color = '#fbbf24';
        autoDetectStatus.textContent = '⏳ กำลังสแกนพอร์ตและดึง CSRF Token จาก IDE...';
      }
      chrome.runtime.sendMessage({ action: 'AUTODETECT_ANTIGRAVITY' }, (res) => {
        if (res && res.success) {
          if (inputAgPort) inputAgPort.value = String(res.port);
          if (inputAgCsrf) inputAgCsrf.value = res.token;
          if (autoDetectStatus) {
            autoDetectStatus.style.color = 'var(--status-ok)';
            autoDetectStatus.textContent = `✓ ตรวจพบ Antigravity ที่พอร์ต ${res.port} (เชื่อมต่อสำเร็จ!)`;
          }
          loadAllUsage();
        } else {
          if (autoDetectStatus) {
            autoDetectStatus.style.color = 'var(--status-alarm)';
            autoDetectStatus.textContent = '✗ ไม่พบ Antigravity IDE ที่กำลังเปิดอยู่ (กรุณาเปิด IDE ก่อน)';
          }
        }
      });
    });
  }

  // Real-time toggle change listeners
  const setupToggle = (checkbox, provider) => {
    if (!checkbox) return;
    checkbox.addEventListener('change', () => {
      const isVisible = checkbox.checked;
      applyProviderVisibility(provider, isVisible);
      const key = `show${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
      chrome.storage.local.set({ [key]: isVisible }, () => {
        if (isVisible) loadAllUsage();
      });
    });
  };

  setupToggle(toggleClaude, 'claude');
  setupToggle(toggleGemini, 'gemini');
  setupToggle(toggleMinimax, 'minimax');
  setupToggle(toggleCodex, 'codex');

  // Real-time Theme Switcher Listener
  if (selectTheme) {
    selectTheme.addEventListener('change', () => {
      const chosenTheme = selectTheme.value;
      applyTheme(chosenTheme);
      chrome.storage.local.set({ theme: chosenTheme });
    });
  }

  if (btnSaveKey) {
    btnSaveKey.addEventListener('click', () => {
      chrome.storage.local.set({
        theme: selectTheme ? selectTheme.value : 'default',
        showClaude: toggleClaude ? toggleClaude.checked : true,
        showGemini: toggleGemini ? toggleGemini.checked : true,
        showMinimax: toggleMinimax ? toggleMinimax.checked : true,
        showCodex: toggleCodex ? toggleCodex.checked : true,
        geminiSourceMode: selectGmSourceMode ? selectGmSourceMode.value : 'auto',
        antigravityPort: inputAgPort ? inputAgPort.value.trim() : '49496',
        antigravityCsrf: inputAgCsrf ? inputAgCsrf.value.trim() : '',
        antigravityRefreshToken: inputAgRefresh ? inputAgRefresh.value.trim() : '',
        geminiAccountIndex: inputGmAccount ? inputGmAccount.value.trim() : '',
        minimaxApiKey: inputMmKey ? inputMmKey.value.trim() : '',
        minimaxGroupId: inputMmGroup ? inputMmGroup.value.trim() : '',
        minimaxHost: (inputMmHost && inputMmHost.value.trim()) || 'https://api.minimax.io',
        codexAccessToken: inputCodexToken ? inputCodexToken.value.trim() : ''
      }, () => {
        if (saveMsg) {
          saveMsg.textContent = 'บันทึกการตั้งค่าเรียบร้อย!';
          setTimeout(() => { saveMsg.textContent = ''; }, 2000);
        }
        loadAllUsage();
      });
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', loadAllUsage);
  }

  // Start periodic live countdown timer
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateLiveCountdowns, 1000);

  // Initialize Magnetic & 3D Tilt Physics
  initMagneticEffects();
});

// ============================================================================
// MAGNETIC & 3D TILT PHYSICS (Subtle & Ergonomic)
// ============================================================================
function initMagneticEffects() {
  const elements = document.querySelectorAll('.magnetic-card, .magnetic-btn');
  elements.forEach((el) => {
    if (el.dataset.magneticBound === 'true') return;
    el.dataset.magneticBound = 'true';

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const normX = (x - centerX) / centerX;
      const normY = (y - centerY) / centerY;

      const isCard = el.classList.contains('provider-card');
      const maxTilt = isCard ? 1.5 : 3;
      const rotateX = -normY * maxTilt;
      const rotateY = normX * maxTilt;

      el.style.transform = `perspective(800px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-1px)`;
    });

    el.addEventListener('mouseleave', () => {
      el.style.transition = 'transform 0.35s ease';
      el.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg) translateY(0px)';
    });

    el.addEventListener('mouseenter', () => {
      el.style.transition = 'transform 0.08s ease-out';
    });
  });
}

// ============================================================================
// STATUS COLORING & UTILITIES
// ============================================================================
function getBarColor(pct) {
  if (pct >= 98) return 'var(--status-alarm)';
  if (pct >= 75) return 'var(--status-warn)';
  return 'var(--status-ok)';
}

function formatCountdown(targetEpochMs) {
  if (!targetEpochMs) return '00h 00m 00s';
  const diffMs = targetEpochMs - Date.now();
  if (diffMs <= 0) return 'พร้อมใช้งาน (Reset แล้ว)';

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const hStr = String(hrs).padStart(2, '0');
  const mStr = String(mins).padStart(2, '0');
  const sStr = String(secs).padStart(2, '0');

  if (days > 0) {
    return `${days}d ${hStr}h ${mStr}m ${sStr}s`;
  }
  return `${hStr}h ${mStr}m ${sStr}s`;
}

function formatMetricResetTime(resetEpoch, is5h = false, now = Date.now()) {
  if (!resetEpoch || !Number.isFinite(resetEpoch)) return '-';
  const diffMs = resetEpoch - now;
  if (diffMs <= 0) {
    return is5h ? 'รีเซ็ตแล้ว (พร้อมใช้งาน)' : 'รีเซ็ตแล้ว';
  }

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  const d = new Date(resetEpoch);
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (days > 0) {
    const dayStr = d.toLocaleDateString([], { weekday: 'short' });
    return `ในอีก ${days}d ${hrs}h (${dayStr} ${timeStr})`;
  }

  const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  return `ในอีก ${durStr} (${timeStr})`;
}

function updateLiveCountdowns() {
  for (const [provider, prefix] of Object.entries(PROVIDER_PREFIX)) {
    const target = targetResetTimes[provider];
    if (target) {
      const el = document.getElementById(`${prefix}-countdown-timer`);
      if (el) el.textContent = formatCountdown(target);
    }
  }

  // Update dynamic pool reset countdowns
  document.querySelectorAll('.pool-reset-txt').forEach((el) => {
    const epoch = Number(el.dataset.resetEpoch);
    const is5h = el.dataset.is5h === 'true';
    if (epoch && Number.isFinite(epoch)) {
      el.textContent = 'รีเซ็ต: ' + formatMetricResetTime(epoch, is5h);
    }
  });
}

// ============================================================================
// WEEKLY PACE & 3-LEVEL WARNING INDICATOR (คำนวนวันที่เหลือ & เตือน 3 ระดับ)
// ============================================================================
function calculateWeeklyPace(pct, resetEpoch, now = Date.now()) {
  const safePct = Math.min(100, Math.max(0, Math.round(pct || 0)));

  let daysRemaining = 3.5;
  let hasValidEpoch = false;

  if (resetEpoch && resetEpoch > now) {
    const msRemaining = resetEpoch - now;
    daysRemaining = msRemaining / (86400 * 1000);
    hasValidEpoch = true;
  }

  const cycleDays = 7;
  const daysRemainingClamped = Math.min(cycleDays, Math.max(0, daysRemaining));
  const daysElapsed = Math.min(cycleDays, Math.max(0, cycleDays - daysRemainingClamped));

  // Target expected pace for today: (daysElapsed / 7) * 100%
  const expectedPct = (daysElapsed / cycleDays) * 100;
  const delta = safePct - expectedPct;

  const remainingQuotaPct = Math.max(0, 100 - safePct);
  // Recommended daily allowance to last comfortably until reset
  const suggestedDailyBudget = daysRemainingClamped > 0.2
    ? (remainingQuotaPct / daysRemainingClamped)
    : remainingQuotaPct;

  const currentDayIndex = Math.min(7, Math.max(1, Math.ceil(daysElapsed) || 1));
  const daysAhead = delta > 0 ? (delta / (100 / cycleDays)).toFixed(1) : '0';

  // Determine 3-Level Warning Status
  let level = 1;
  let levelClass = 'level-1';
  let badgeLabel = '● ปกติ (On Pace)';
  let summaryClass = '';
  let summaryText = `อยู่ในเกณฑ์: เหลืออีก ${daysRemainingClamped.toFixed(1)} วัน | ใช้ได้เฉลี่ย ~${suggestedDailyBudget.toFixed(0)}%/วัน`;

  // LEVEL 3 (CRITICAL): Delta > 20% or high usage near exhaustion
  if (delta > 20 || (safePct >= 90 && daysRemainingClamped >= 1.5) || safePct >= 98) {
    level = 3;
    levelClass = 'level-3';
    badgeLabel = '⚡ วิกฤติ (Critical)';
    summaryClass = 'level-3-summary';
    summaryText = `วิกฤติ! ใช้ล้นเกินจุดวันนี้ไป ~${daysAhead} วัน (+${Math.max(0, Math.round(delta))}%) | เหลือ ${daysRemainingClamped.toFixed(1)} วัน (ควรชะลอการใช้)`;
  }
  // LEVEL 2 (HIGH BURN): Delta > 5% or usage high relative to time left
  else if (delta > 5 || (safePct >= 75 && daysRemainingClamped >= 2)) {
    level = 2;
    levelClass = 'level-2';
    badgeLabel = '▲ เร่งตัว (High Burn)';
    summaryClass = 'level-2-summary';
    summaryText = `เร่งตัว: ใช้ล้นเกินจุดวันนี้ไป ~${daysAhead} วัน (+${Math.round(delta)}%) | เหลือ ${daysRemainingClamped.toFixed(1)} วัน (แนะชะลอเหลือ ~${suggestedDailyBudget.toFixed(0)}%/วัน)`;
  }

  return {
    safePct,
    daysRemaining: daysRemainingClamped,
    daysElapsed,
    currentDayIndex,
    expectedPct,
    delta,
    level,
    levelClass,
    badgeLabel,
    summaryClass,
    summaryText,
    hasValidEpoch
  };
}

// Update the 7-segment rack cells
function update7SegmentRack(rackEl, pct, currentDayIndex) {
  if (!rackEl) return;
  const safePct = Math.min(100, Math.max(0, Number(pct) || 0));
  const cells = rackEl.querySelectorAll('.segment-cell');

  cells.forEach((cell, idx) => {
    const dayNumber = idx + 1;
    const lower = idx * SLOT_SIZE;
    const upper = (idx + 1) * SLOT_SIZE;

    let fillPct = 0;
    if (safePct >= upper) {
      fillPct = 100;
    } else if (safePct > lower) {
      fillPct = Math.round(((safePct - lower) / SLOT_SIZE) * 100);
    }

    const fillEl = cell.querySelector('.segment-fill');
    if (fillEl) {
      fillEl.style.height = `${fillPct}%`;
    }

    if (fillPct > 0) {
      cell.classList.add('has-usage');
    } else {
      cell.classList.remove('has-usage');
    }

    // Check if usage has overshot beyond today's allowance
    const isOverBudget = (dayNumber > currentDayIndex) && (fillPct > 0);
    if (isOverBudget) {
      cell.classList.add('is-over-budget');
    } else {
      cell.classList.remove('is-over-budget');
    }

    let pointerEl = cell.querySelector('.today-pointer');
    if (dayNumber === currentDayIndex) {
      cell.classList.add('is-today');
      cell.title = `วันที่ ${dayNumber} ของรอบ (วันนี้) - โควตาส่วนนี้ใช้ไป ${fillPct}%`;
      if (!pointerEl) {
        pointerEl = document.createElement('span');
        pointerEl.className = 'today-pointer';
        pointerEl.textContent = '▼ วันนี้';
        cell.appendChild(pointerEl);
      }
    } else {
      cell.classList.remove('is-today');
      cell.title = `วันที่ ${dayNumber} ของรอบ - ใช้โควตาส่วนนี้ไป ${fillPct}%`;
      if (pointerEl) {
        pointerEl.remove();
      }
    }
  });
}

// Centralized helper to update weekly metrics with 7-segment rack and 3-level warning indicator
function updateWeeklyMetric(txtEl, paceBadgeEl, rackEl, resetEl, summaryEl, pct, resetEpoch, resetStr) {
  const pace = calculateWeeklyPace(pct, resetEpoch);

  if (txtEl) txtEl.textContent = `${pace.safePct}%`;

  if (paceBadgeEl) {
    paceBadgeEl.className = `pace-badge ${pace.levelClass}`;
    paceBadgeEl.textContent = pace.badgeLabel;
  }

  if (rackEl) {
    update7SegmentRack(rackEl, pace.safePct, pace.currentDayIndex);
  }

  if (resetEl) {
    resetEl.textContent = resetStr ? `Reset: ${resetStr}` : 'Reset: -';
  }

  if (summaryEl) {
    summaryEl.className = `pace-summary ${pace.summaryClass}`;
    summaryEl.textContent = pace.summaryText;
  }
}

// Continuous 5-Hour Bar Update
function updateMetric(txtEl, barEl, resetEl, pct, resetStr) {
  if (!txtEl || !barEl || !resetEl) return;
  const safePct = Math.min(100, Math.max(0, Math.round(pct || 0)));
  txtEl.textContent = `${safePct}%`;
  barEl.style.width = `${safePct}%`;
  barEl.style.backgroundColor = getBarColor(safePct);
  resetEl.textContent = resetStr ? `Reset: ${resetStr}` : 'Reset: -';
}

function clearMetrics(prefix) {
  const txt5h = document.getElementById(`${prefix}-5h-txt`);
  const bar5h = document.getElementById(`${prefix}-5h-bar`);
  const rst5h = document.getElementById(`${prefix}-5h-reset`);

  const txtWk = document.getElementById(`${prefix}-wk-txt`);
  const paceBadge = document.getElementById(`${prefix}-wk-pace`);
  const rackWk = document.getElementById(`${prefix}-wk-rack`);
  const rstWk = document.getElementById(`${prefix}-wk-reset`);
  const summaryWk = document.getElementById(`${prefix}-wk-summary`);

  if (txt5h) txt5h.textContent = '-%';
  if (bar5h) bar5h.style.width = '0%';
  if (rst5h) rst5h.textContent = 'Reset: -';

  if (txtWk) txtWk.textContent = '-%';
  if (paceBadge) {
    paceBadge.className = 'pace-badge level-1';
    paceBadge.textContent = '● ปกติ (On Pace)';
  }
  if (rackWk) update7SegmentRack(rackWk, 0, 1);
  if (rstWk) rstWk.textContent = 'Reset: -';
  if (summaryWk) {
    summaryWk.className = 'pace-summary';
    summaryWk.textContent = 'พร้อมคำนวณรอบสัปดาห์...';
  }

  if (prefix === 'gm') {
    const poolsContainer = document.getElementById('gm-pools-container');
    if (poolsContainer) poolsContainer.innerHTML = '';
    const defMetrics = document.getElementById('gm-default-metrics');
    if (defMetrics) defMetrics.style.display = 'block';
  }
}

function applyExhaustedState(provider, isExhausted, targetEpochMs, exhaustedWindow) {
  const prefix = PROVIDER_PREFIX[provider];
  if (!prefix) return;

  const card = document.getElementById(`card-${provider}`);
  const box = document.getElementById(`${prefix}-countdown-box`);
  const label = document.getElementById(`${prefix}-countdown-label`);
  const badge = document.getElementById(`${prefix}-badge`);

  if (isExhausted) {
    if (card) card.classList.add('limit-hit');
    if (badge) {
      badge.textContent = '100% EXHAUSTED';
      badge.className = 'badge exhausted';
    }
    if (label) {
      label.textContent = exhaustedWindow === 'WEEKLY'
        ? '⏳ WEEKLY LIMIT EXHAUSTED - RESETS IN'
        : '⏳ LIMIT EXHAUSTED - RESETS IN';
    }
    if (targetEpochMs && targetEpochMs > Date.now()) {
      targetResetTimes[provider] = targetEpochMs;
      if (box) box.classList.add('active');
    } else {
      targetResetTimes[provider] = null;
      if (box) box.classList.remove('active');
    }
  } else {
    targetResetTimes[provider] = null;
    if (card) card.classList.remove('limit-hit');
    if (box) box.classList.remove('active');
  }
}

// Dynamically create a 7-segment rack DOM tree for weekly metrics
function createWeeklyRackElement() {
  const rack = document.createElement('div');
  rack.className = 'weekly-rack';

  const grid = document.createElement('div');
  grid.className = 'segment-grid';

  for (let i = 1; i <= 7; i++) {
    const cell = document.createElement('div');
    cell.className = 'segment-cell';
    cell.dataset.day = String(i);
    cell.innerHTML = `<div class="segment-fill"></div><span class="day-tag">D${i}</span>`;
    grid.appendChild(cell);
  }

  rack.appendChild(grid);
  return rack;
}

// Gemini Multi-Pools Quota Render with 7-Segment Rack and 3-Level Warning Indicator
function renderGeminiPools(pools) {
  const poolsContainer = document.getElementById('gm-pools-container');
  const defMetrics = document.getElementById('gm-default-metrics');
  if (!poolsContainer) return;

  if (defMetrics) defMetrics.style.display = 'none';
  poolsContainer.innerHTML = '';

  for (const pool of pools) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'pool-group';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'pool-title';
    titleDiv.innerHTML = `<span>${pool.name || 'Quota Pool'}</span>`;
    groupDiv.appendChild(titleDiv);

    if (pool.description) {
      const descDiv = document.createElement('div');
      descDiv.className = 'pool-desc';
      descDiv.textContent = pool.description;
      groupDiv.appendChild(descDiv);
    }

    for (const metric of pool.metrics || []) {
      const isWeekly = (metric.label && /week|7-day|7 day/i.test(metric.label)) ||
                       (metric.id && /week|7-day/i.test(metric.id)) ||
                       (metric.resetEpoch && (metric.resetEpoch - Date.now() > 24 * 3600 * 1000));

      const isExpired = metric.resetEpoch ? (metric.resetEpoch <= Date.now()) : false;
      const rawPct = Math.min(100, Math.max(0, Math.round(metric.pct || 0)));
      // If rolling 5-hour limit has expired, quota has fully refreshed to 0%
      const effectivePct = (!isWeekly && isExpired) ? 0 : rawPct;
      const resetDisplayStr = formatMetricResetTime(metric.resetEpoch, !isWeekly);

      const metricDiv = document.createElement('div');
      metricDiv.className = isWeekly ? 'metric weekly-metric' : 'metric';

      if (isWeekly) {
        // Render 7-Segment Rack with 3-Level Warning Indicator
        const pace = calculateWeeklyPace(effectivePct, metric.resetEpoch);

        metricDiv.innerHTML = `
          <div class="metric-info">
            <span class="metric-name">${metric.label}</span>
            <div class="metric-val-wrap">
              <span class="metric-val">${effectivePct}%</span>
              <span class="pace-badge ${pace.levelClass}">${pace.badgeLabel}</span>
            </div>
          </div>
        `;

        const rack = createWeeklyRackElement();
        metricDiv.appendChild(rack);
        update7SegmentRack(rack, effectivePct, pace.currentDayIndex);

        const resetDiv = document.createElement('div');
        resetDiv.className = 'reset-txt pool-reset-txt';
        resetDiv.dataset.resetEpoch = String(metric.resetEpoch || '');
        resetDiv.dataset.is5h = 'false';
        resetDiv.textContent = `รีเซ็ต: ${resetDisplayStr}`;
        metricDiv.appendChild(resetDiv);

        const summaryDiv = document.createElement('div');
        summaryDiv.className = `pace-summary ${pace.summaryClass}`;
        summaryDiv.textContent = pace.summaryText;
        metricDiv.appendChild(summaryDiv);
      } else {
        // Render continuous gauge bar
        const color = getBarColor(effectivePct);
        metricDiv.innerHTML = `
          <div class="metric-info">
            <span class="metric-name">${metric.label}</span>
            <span class="metric-val">${effectivePct}%</span>
          </div>
          <div class="bar-bg">
            <div class="bar-fill" style="width: ${effectivePct}%; background-color: ${color};"></div>
          </div>
          <div class="reset-txt pool-reset-txt" data-reset-epoch="${metric.resetEpoch || ''}" data-is-5h="true">รีเซ็ต: ${resetDisplayStr}</div>
        `;
      }

      groupDiv.appendChild(metricDiv);
    }

    poolsContainer.appendChild(groupDiv);
  }

  // Refresh magnetic effects for newly added elements
  initMagneticEffects();
}

function renderProviderCard(provider, data, okLabel = 'Connected') {
  const prefix = PROVIDER_PREFIX[provider];
  const badge = document.getElementById(`${prefix}-badge`);
  const card = document.getElementById(`card-${provider}`);
  if (!badge) return;

  if (data?.disabled) {
    if (card) card.classList.add('card-hidden');
    applyExhaustedState(provider, false, null, null);
    clearMetrics(prefix);
    return;
  }

  if (!data || data.error) {
    badge.textContent = data?.error || 'เชื่อมต่อไม่ได้';
    badge.className = 'badge error';
    applyExhaustedState(provider, false, null, null);
    clearMetrics(prefix);
    return;
  }

  const isExhausted = Boolean(data.isExhausted || data.fiveHour >= 100 || data.weekly >= 100);
  if (data.isCached) {
    badge.textContent = 'แคช (IDE ปิดอยู่)';
    badge.className = 'badge cached';
  } else {
    badge.textContent = isExhausted ? 'โควตาเต็ม 100%' : okLabel;
    badge.className = isExhausted ? 'badge exhausted' : 'badge active';
  }

  applyExhaustedState(provider, isExhausted, data.targetResetEpoch, data.exhaustedWindow);

  // Update source tag for Gemini
  if (provider === 'gemini') {
    const srcTag = document.getElementById('gm-source-tag');
    if (srcTag) {
      if (data.source === 'antigravity' || data.source === 'antigravity_cloud') {
        if (data.isCached) {
          const cacheAgeMin = Math.max(1, Math.round((Date.now() - (data.cachedTimestamp || Date.now())) / 60000));
          const ageStr = cacheAgeMin >= 60 ? `${Math.floor(cacheAgeMin / 60)} ชม.ก่อน` : `${cacheAgeMin} นาทีก่อน`;
          srcTag.textContent = `Antigravity (แคช ${ageStr})`;
        } else {
          srcTag.textContent = 'Antigravity IDE';
        }
      } else {
        srcTag.textContent = 'Gemini Web';
      }
    }
  }

  // Special multi-pool handling for Gemini Pro
  if (provider === 'gemini' && Array.isArray(data.pools) && data.pools.length > 0) {
    renderGeminiPools(data.pools);
    return;
  }

  if (provider === 'gemini') {
    const poolsContainer = document.getElementById('gm-pools-container');
    if (poolsContainer) poolsContainer.innerHTML = '';
    const defMetrics = document.getElementById('gm-default-metrics');
    if (defMetrics) defMetrics.style.display = 'block';
  }

  // 1. Continuous 5-Hour rolling bar
  updateMetric(
    document.getElementById(`${prefix}-5h-txt`),
    document.getElementById(`${prefix}-5h-bar`),
    document.getElementById(`${prefix}-5h-reset`),
    data.fiveHour,
    data.fiveHourResetText ? `ในอีก ${data.fiveHourResetText}` : '-'
  );

  // 2. Weekly Limit with 7-Segment Rack and 3-Level Warning Indicator
  updateWeeklyMetric(
    document.getElementById(`${prefix}-wk-txt`),
    document.getElementById(`${prefix}-wk-pace`),
    document.getElementById(`${prefix}-wk-rack`),
    document.getElementById(`${prefix}-wk-reset`),
    document.getElementById(`${prefix}-wk-summary`),
    data.weekly,
    data.weeklyResetEpoch,
    data.weeklyResetText ? `ในอีก ${data.weeklyResetText}` : '-'
  );
}

function loadAllUsage() {
  const lastUpdatedEl = document.getElementById('last-updated');
  if (lastUpdatedEl) lastUpdatedEl.textContent = 'กำลังโหลดข้อมูล...';

  chrome.runtime.sendMessage({ action: 'GET_ALL_USAGE' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      if (lastUpdatedEl) lastUpdatedEl.textContent = 'ไม่สามารถดึงข้อมูลได้';
      return;
    }

    renderProviderCard('claude', res.claude, 'พร้อมใช้งาน');
    renderProviderCard('gemini', res.gemini, 'พร้อมใช้งาน');
    renderProviderCard('minimax', res.minimax, 'พร้อมใช้งาน');
    renderProviderCard('codex', res.codex, res.codex?.planType || 'พร้อมใช้งาน');

    updateLiveCountdowns();
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = `อัปเดตล่าสุด: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  });
}
