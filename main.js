const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { exec } = require('child_process');
const os = require('os');
const chokidar = require('chokidar');
const express = require('express');
const axios = require('axios');
const dgram = require('dgram');
const http = require('http');
const WebSocket = require('ws');
const mdns = require('multicast-dns');
const psList = require('ps-list');

let mainWindow;
let reportWindow;
let logWatcher;
let discoveredNodes = new Map();
let webServer, wss, bonjour;
let iAmWebServerHost = false;
let currentHostName = null;
let parsedEpochData = new Map();
let jobStartTimes = new Map();
let jobStartQueue = [];

const MAX_INFERRED_JOB_SECONDS = 6 * 60 * 60;
const MAX_PAIR_WINDOW_MS = 12 * 60 * 60 * 1000;

const USER_DATA_PATH = app.getPath('userData');
const REPORTS_PATH = path.join(USER_DATA_PATH, 'reports');
const LOG_PATH = path.join(os.homedir(), 'AppData', 'Local', 'OtoyRndrNetwork', 'rndr_log.txt');
const STATE_FILE = path.join(USER_DATA_PATH, 'state.json');
const API_PORT = 34567;
const WEB_PORT = 34568;

if (!fs.existsSync(REPORTS_PATH)) {
  fs.mkdirSync(REPORTS_PATH, { recursive: true });
}

const isLogLineEmpty = (line) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \w+: \[\d+\]\s*$/.test(line);

function getNetworkAdapters() {
  const interfaces = os.networkInterfaces();
  const adapters = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        adapters.push({
          name: name,
          address: iface.address,
          displayName: name.replace(/[^\w\s]/gi, ' ').trim()
        });
      }
    }
  }
  return adapters;
}

function getPreferredIpAddress() {
  const state = loadState();
  const adapters = getNetworkAdapters();
  if (state.preferredAdapter) {
    const preferred = adapters.find(a => a.address === state.preferredAdapter);
    if (preferred) {
      return preferred.address;
    }
  }
  return adapters.length > 0 ? adapters[0].address : '0.0.0.0';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    frame: false,
    backgroundColor: '#1a1a1a',
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });


  mainWindow.webContents.once('did-finish-load', () => {
    try { initializeMonitoring(); } catch (e) { console.error('Init error:', e); }
  });

  nativeTheme.themeSource = 'dark';

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (logWatcher) logWatcher.close();

    if (bonjour) {
      if (bonjour._announceInterval) {
        clearInterval(bonjour._announceInterval);
      }
      bonjour.destroy();
      bonjour = null;
    }

    if (webServer) webServer.close();
  });
}


app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => {
  createWindow();
  startApiServer();
  startServiceDiscovery();
  setInterval(performHostElection, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function startApiServer() {
  const apiApp = express();
  apiApp.use(express.json());
  apiApp.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

  apiApp.get('/api/status', (req, res) => res.json(getLocalNodeData()));

  apiApp.get('/api/log', async (req, res) => {
    try {
      const linesParam = Math.min(parseInt(req.query.lines) || 500, 5000);
      const hostQuery = req.query.host;

      if (hostQuery && hostQuery !== os.hostname()) {
        const remote = discoveredNodes.get(hostQuery);
        if (!remote) return res.status(404).json({ error: 'Unknown host' });
        try {
          const resp = await axios.get(`http://${remote.host}:${remote.port}/api/log?lines=${linesParam}`);
          return res.json(resp.data);
        } catch (e) {
          return res.status(502).json({ error: 'Failed to fetch remote log' });
        }
      }

      if (!fs.existsSync(LOG_PATH)) return res.json({ host: os.hostname(), lines: [] });
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const lines = content.split('\n').filter(l => l.trim() && !isLogLineEmpty(l));
      return res.json({ host: os.hostname(), lines: lines.slice(-linesParam) });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  apiApp.listen(API_PORT, '0.0.0.0', () => console.log(`Node API server running on port ${API_PORT}`));
}

function manageWebServer() {
  const state = loadState();
  if (iAmWebServerHost && !webServer && state.isHostingEnabled) {
    console.log(`This node (${os.hostname()}) is now the web host.`);
    const webApp = express();
    webApp.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
    webApp.get('/api/log', async (req, res) => {
      try {
        const linesParam = Math.min(parseInt(req.query.lines) || 500, 5000);
        const hostQuery = req.query.host;

        const readLocal = () => {
          if (!fs.existsSync(LOG_PATH)) return { host: os.hostname(), lines: [] };
          const content = fs.readFileSync(LOG_PATH, 'utf8');
          const lines = content.split('\n').filter(l => l.trim() && !isLogLineEmpty(l));
          return { host: os.hostname(), lines: lines.slice(-linesParam) };
        };

        if (!hostQuery || hostQuery === os.hostname()) {
          return res.json(readLocal());
        }

        const remote = discoveredNodes.get(hostQuery);
        if (!remote) return res.status(404).json({ error: 'Unknown host' });
        try {
          const resp = await axios.get(`http://${remote.host}:${API_PORT}/api/log?lines=${linesParam}`);
          return res.json(resp.data);
        } catch (e) {
          return res.status(502).json({ error: 'Remote fetch failed' });
        }
      } catch (err) {
        res.status(500).json({ error: 'Internal error' });
      }
    });

    webApp.use(express.static(path.join(__dirname, 'web')));
    webApp.get('/web-script.js', (req, res) => res.sendFile(path.join(__dirname, 'web', 'web-script.js')));

    webServer = http.createServer(webApp);
    wss = new WebSocket.Server({ server: webServer });

    wss.on('connection', ws => {
      console.log('Web client connected.');
      ws.send(JSON.stringify({ type: 'all-nodes-update', payload: getAllNodesAsArray() }));
    });

    const preferredIp = getPreferredIpAddress();

    webServer.listen(WEB_PORT, preferredIp, () => {
      console.log(`Web server running at http://${preferredIp}:${WEB_PORT}`);
      console.log(`Setting up IPv4-only mDNS for render.local on ${preferredIp}`);

      bonjour = mdns({
        multicast: true,
        interface: preferredIp,
        port: 5353,
        ip: '224.0.0.251',
        v4: true,
        v6: false,
        reuseAddr: true,
        socket: dgram.createSocket({ type: 'udp4', reuseAddr: true })
      });

      bonjour.on('query', (query) => {
        if (query.questions.some(q => q.name === 'render.local')) {
          bonjour.respond({ answers: [{ name: 'render.local', type: 'A', ttl: 120, data: preferredIp }] });
        }
        if (query.questions.some(q => q.name === '_http._tcp.local')) {
          bonjour.respond({
            answers: [{
              name: 'RNDR Monitor._http._tcp.local',
              type: 'SRV',
              data: { port: WEB_PORT, weight: 0, priority: 0, target: 'render.local' }
            }]
          });
        }
      });

      const announce = () => {
        bonjour.respond({
          answers: [
            { name: 'render.local', type: 'A', ttl: 120, data: preferredIp },
            { name: 'RNDR Monitor._http._tcp.local', type: 'PTR', ttl: 120, data: 'RNDR Monitor._http._tcp.local' }
          ]
        });
      };

      announce();
      const announceInterval = setInterval(announce, 30000);
      bonjour._announceInterval = announceInterval;

      console.log(`mDNS responder active on ${preferredIp} (IPv4 only)`);
    });
  } else if ((!iAmWebServerHost || !state.isHostingEnabled) && webServer) {
    console.log(`This node (${os.hostname()}) is no longer the web host.`);

    if (bonjour) {
      if (bonjour._announceInterval) clearInterval(bonjour._announceInterval);
      bonjour.destroy();
      bonjour = null;
    }

    if (wss) wss.close();
    if (webServer) {
      webServer.close(() => { webServer = null; });
    }
    wss = null;
  }
}

function performHostElection() {
  const state = loadState();
  const potentialHosts = getAllNodesAsArray()
    .filter(node => node.isHostingEnabled)
    .sort((a, b) => a.name.localeCompare(b.name));

  const electedHost = potentialHosts[0];
  currentHostName = electedHost ? electedHost.name : null;
  const previousHostState = iAmWebServerHost;
  iAmWebServerHost = electedHost ? electedHost.name === os.hostname() : false;

  if (previousHostState !== iAmWebServerHost || (iAmWebServerHost && !webServer)) {
    manageWebServer();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hosting-status-update', { currentHostName });
  }
}

function startServiceDiscovery() {
  const broadcastSocket = dgram.createSocket('udp4');
  broadcastSocket.bind(() => broadcastSocket.setBroadcast(true));

  setInterval(() => {
    const state = loadState();
    const message = JSON.stringify({
      type: 'rndr-monitor',
      hostname: os.hostname(),
      port: API_PORT,
      isHostingEnabled: state.isHostingEnabled,
      timestamp: Date.now()
    });
    broadcastSocket.send(message, 0, message.length, 45678, '255.255.255.255');
  }, 10000);

  const listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  listenSocket.bind(45678);

  listenSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'rndr-monitor' && data.hostname !== os.hostname()) {
        discoveredNodes.set(data.hostname, {
          name: data.hostname,
          host: rinfo.address,
          port: data.port,
          lastSeen: Date.now(),
          isHostingEnabled: data.isHostingEnabled || false,
          data: null
        });
      }
    } catch (err) { }
  });
}

async function updateNetworkNodes() {
  for (const [host, node] of discoveredNodes.entries()) {
    if (Date.now() - node.lastSeen > 30000) {
      discoveredNodes.delete(host);
      continue;
    }
    try {
      const response = await axios.get(`http://${node.host}:${node.port}/api/status`, { timeout: 3000 });
      node.data = response.data;
    } catch (err) {
      node.data = null;
      console.error(`Failed to fetch data from ${host}`);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('network-nodes-update', Array.from(discoveredNodes.values()));
  }

  if (iAmWebServerHost && wss) {
    const allNodes = getAllNodesAsArray();
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'all-nodes-update', payload: allNodes }));
      }
    });
  }
  performHostElection();
}

function getAllNodesAsArray() {
  const state = loadState();
  const localNode = {
    name: os.hostname(),
    isHostingEnabled: state.isHostingEnabled,
    data: getLocalNodeData()
  };
  const remoteNodes = Array.from(discoveredNodes.values());
  return [localNode, ...remoteNodes];
}

function getLocalNodeData() {
  const state = loadState();
  let recentLogs = [];
  try {
    if (fs.existsSync(LOG_PATH)) {
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      recentLogs = content.split('\n').filter(line => line.trim() && !isLogLineEmpty(line)).slice(-25);
    }
  } catch (err) {
    console.error("Could not read log file for API response:", err);
  }
  return {
    hostname: os.hostname(),
    rndrStatus: state.rndrStatus,
    watchdogStatus: state.watchdogStatus,
    gpus: state.gpuInfo,
    stats: getDisplayableStats(state),
    lastUpdate: state.lastUpdate,
    recentLogs: recentLogs
  };
}

function initializeMonitoring() {
  checkInitialStatus();
  startLogMonitoring();
  startGPUMonitoring();
  startProcessMonitoring();
  startDailyFramePruning();
  setInterval(updateNetworkNodes, 5000);
}

function checkInitialStatus() {
  try {
    if (!fs.existsSync(LOG_PATH)) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log-error', 'Log file not found');
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('loading-status', 'Analyzing render history...');

    const state = loadState();

    state.stats = {
      lifetimeFrames: { successful: 0, failed: 0, successfulTime: 0, failedTime: 0 },
      dailyFrames: { successfulTimestamps: [], failedTimestamps: [] },
      epochFrames: { successful: 0, failed: 0, successfulTimestamps: [], failedTimestamps: [] },
      lastFrameTime: null
    };

    jobStartTimes.clear();
    jobStartQueue.length = 0;

    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.split('\n');

    lines.forEach(line => {
      parseLine(line, state);
    });

    state.lastPosition = content.length;
    saveState(state);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stats-update', getDisplayableStats(state));
      const recentLines = lines.filter(line => line.trim() && !isLogLineEmpty(line));
      mainWindow.webContents.send('initial-log-entries', recentLines.slice(-25));
      mainWindow.webContents.send('loading-complete');
    }
  } catch (err) {
    console.error('Initialization failed:', err);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('loading-complete');
  }
}

function loadState() {
  const defaults = {
    isHostingEnabled: true,
    lastPosition: 0,
    preferredAdapter: null,
    stats: {
      lifetimeFrames: { successful: 0, failed: 0 },
      dailyFrames: { successfulTimestamps: [], failedTimestamps: [] },
      epochFrames: { successful: 0, failed: 0, successfulTimestamps: [], failedTimestamps: [] },
      lastFrameTime: null
    },
    gpuInfo: [],
    rndrStatus: false,
    watchdogStatus: false
  };

  if (!fs.existsSync(STATE_FILE)) {
    return defaults;
  }

  try {
    const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    const mergedState = { ...defaults, ...savedState };
    mergedState.stats = { ...defaults.stats, ...(savedState.stats || {}) };
    mergedState.stats.dailyFrames = { ...defaults.stats.dailyFrames, ...(savedState.stats?.dailyFrames || {}) };
    mergedState.stats.epochFrames = { ...defaults.stats.epochFrames, ...(savedState.stats?.epochFrames || {}) };

    return mergedState;
  } catch (err) {
    console.error('Error loading or merging state, returning defaults:', err);
    return defaults;
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state:', err);
  }
}

function extractTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function parseLocalDateTimeMs(ts) {
  if (!ts) return Date.now();
  return new Date(ts).getTime();
}

function consumeStartByHash(targetHash) {
  return consumeStartByHashLatest(targetHash, Date.now());
}

function consumeStartByHashLatest(targetHash, endMs) {
  if (!targetHash) return null;
  for (let i = jobStartQueue.length - 1; i >= 0; i--) {
    const entry = jobStartQueue[i];
    if (entry.hash === targetHash) {
      if (endMs && endMs - entry.ts > MAX_PAIR_WINDOW_MS) {
        continue;
      }
      jobStartQueue.splice(i, 1);
      return entry;
    }
  }
  return null;
}

function consumeOldestStart() {
  return null;
}

function parseLine(line, state) {
  if (isLogLineEmpty(line)) return;
  const timestamp = extractTimestamp(line);
  if (!timestamp) return;
  const lineTime = parseLocalDateTimeMs(timestamp);
  const utcMs = lineTime;
  const isoUtc = new Date(utcMs).toISOString();
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const currentEpochStart = getEpochStart(new Date()).getTime();

  if (!state.stats.epochFrames.successfulTimestamps) state.stats.epochFrames.successfulTimestamps = [];
  if (!state.stats.epochFrames.failedTimestamps) state.stats.epochFrames.failedTimestamps = [];
  if (!state.stats.lifetimeFrames.successfulTime) state.stats.lifetimeFrames.successfulTime = 0;
  if (!state.stats.lifetimeFrames.failedTime) state.stats.lifetimeFrames.failedTime = 0;

  if (state.stats.lastFrameTime && new Date(state.stats.lastFrameTime).getTime() < currentEpochStart && lineTime >= currentEpochStart) {
    console.log("New epoch detected, resetting live epoch stats.");
    state.stats.epochFrames = { successful: 0, failed: 0, successfulTimestamps: [], failedTimestamps: [] };
  }

  if (line.includes('starting a new render job with config hash:')) {
    const m = line.match(/config hash: (\w+)/);
    const hash = m && m[1] ? m[1] : `unknown_${lineTime}`;
    jobStartQueue.push({ hash, ts: lineTime });

    const cutoff = lineTime - (24 * 60 * 60 * 1000);
    while (jobStartQueue.length && jobStartQueue[0].ts < cutoff) {
      jobStartQueue.shift();
    }
    if (jobStartQueue.length > 5000) jobStartQueue.shift();
    return;
  }

  const extractHash = () => {
    const mh = line.match(/hash (\w+)/) || line.match(/config hash: (\w+)/);
    return mh && mh[1] ? mh[1] : null;
  };

  if (line.includes('job completed successfully')) {
    const explicitRt = extractRenderTime(line);
    const hash = extractHash();
    let start = null;
    if (hash) start = consumeStartByHashLatest(hash, lineTime);

    let rt = explicitRt != null ? explicitRt : (start ? Math.max(0, (lineTime - start.ts) / 1000) : 0);
    if (explicitRt == null && (rt < 0 || rt > MAX_INFERRED_JOB_SECONDS)) {
      rt = 0;
    }

    const point = { ts: lineTime, time: rt, timestamp: lineTime, timestampUtc: utcMs, isoUtc, renderTime: rt, hash };
    state.stats.lifetimeFrames.successful++;
    state.stats.lifetimeFrames.successfulTime = (state.stats.lifetimeFrames.successfulTime || 0) + rt;
    if (lineTime > dayAgo) state.stats.dailyFrames.successfulTimestamps.push(point);
    if (lineTime >= currentEpochStart) {
      state.stats.epochFrames.successful++;
      state.stats.epochFrames.successfulTimestamps.push(point);
    }
    state.stats.lastFrameTime = timestamp;
    return;
  }

  if (line.includes('job failed')) {
    const hash = extractHash();
    const start = hash ? consumeStartByHashLatest(hash, lineTime) : null;

    let rt = start ? Math.max(0, (lineTime - start.ts) / 1000) : 0;
    if (rt < 0 || rt > MAX_INFERRED_JOB_SECONDS) {
      rt = 0;
    }

    const point = { ts: lineTime, time: rt, timestamp: lineTime, timestampUtc: utcMs, isoUtc, renderTime: rt, hash };
    state.stats.lifetimeFrames.failed++;
    state.stats.lifetimeFrames.failedTime = (state.stats.lifetimeFrames.failedTime || 0) + rt;
    if (lineTime > dayAgo) state.stats.dailyFrames.failedTimestamps.push(point);
    if (lineTime >= currentEpochStart) {
      state.stats.epochFrames.failed++;
      state.stats.epochFrames.failedTimestamps.push(point);
    }
    return;
  }
}

function getDisplayableStats(state) {
  const norm = (arr) => (arr || []).map(item => (
    typeof item === 'number'
      ? { ts: item, time: 0, timestamp: item, timestampUtc: item, isoUtc: new Date(item).toISOString(), renderTime: 0, hash: null }
      : {
        ts: item.ts,
        time: item.time ?? item.renderTime ?? 0,
        timestamp: item.timestamp ?? item.ts,
        timestampUtc: item.timestampUtc ?? (item.timestamp ?? item.ts),
        isoUtc: item.isoUtc ?? new Date(item.timestampUtc ?? (item.timestamp ?? item.ts)).toISOString(),
        renderTime: item.renderTime ?? item.time ?? 0,
        hash: item.hash ?? null
      }
  )).filter(Boolean);

  const successArr = norm(state.stats.dailyFrames.successfulTimestamps);
  const failArr = norm(state.stats.dailyFrames.failedTimestamps);

  const epochSuccessArr = norm(state.stats.epochFrames?.successfulTimestamps || []);
  const epochFailArr = norm(state.stats.epochFrames?.failedTimestamps || []);

  const displayable = JSON.parse(JSON.stringify(state.stats));
  displayable.dailyFrames = {
    successful: successArr.length,
    failed: failArr.length,
    successfulTime: successArr.reduce((a, o) => a + (o.renderTime || 0), 0),
    failedTime: failArr.reduce((a, o) => a + (o.renderTime || 0), 0),
    successfulTimestamps: successArr,
    failedTimestamps: failArr
  };

  displayable.epochFrames = displayable.epochFrames || { successful: 0, failed: 0 };
  displayable.epochFrames.successful = epochSuccessArr.length;
  displayable.epochFrames.failed = epochFailArr.length;
  displayable.epochFrames.successfulTime = epochSuccessArr.reduce((a, o) => a + (o.renderTime || 0), 0);
  displayable.epochFrames.failedTime = epochFailArr.reduce((a, o) => a + (o.renderTime || 0), 0);
  displayable.epochFrames.successfulTimestamps = epochSuccessArr;
  displayable.epochFrames.failedTimestamps = epochFailArr;

  return displayable;
}

function startDailyFramePruning() {
  setInterval(() => {
    const state = loadState();
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const normalizeInState = (key) => {
      state.stats.dailyFrames[key] = (state.stats.dailyFrames[key] || []).map(item => (
        typeof item === 'number' ? { ts: item, time: 0, timestamp: item, renderTime: 0, hash: null } : item
      ));
    };
    normalizeInState('successfulTimestamps');
    normalizeInState('failedTimestamps');

    const originalSuccessCount = state.stats.dailyFrames.successfulTimestamps.length;
    const originalFailedCount = state.stats.dailyFrames.failedTimestamps.length;

    state.stats.dailyFrames.successfulTimestamps = state.stats.dailyFrames.successfulTimestamps.filter(item => item.ts > dayAgo);
    state.stats.dailyFrames.failedTimestamps = state.stats.dailyFrames.failedTimestamps.filter(item => item.ts > dayAgo);

    const newSuccessCount = state.stats.dailyFrames.successfulTimestamps.length;
    const newFailedCount = state.stats.dailyFrames.failedTimestamps.length;

    if (newSuccessCount !== originalSuccessCount || newFailedCount !== originalFailedCount) {
      saveState(state);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stats-update', getDisplayableStats(state));
      }
      console.log(`Pruned daily frames. Removed ${originalSuccessCount - newSuccessCount} successful, ${originalFailedCount - newFailedCount} failed.`);
    }
  }, 30 * 60 * 1000);
}

function extractRenderTime(line) {
  const match = line.match(/render time ([\d.]+) seconds/);
  return match ? parseFloat(match[1]) : null;
}

function getEpochStart(date) {
  const anchorTime = Date.UTC(2025, 7, 26, 23, 17, 23);
  const epochDuration = 7 * 24 * 60 * 60 * 1000;
  const targetTime = date.getTime();
  const timeSinceAnchor = targetTime - anchorTime;
  const epochsSinceAnchor = Math.floor(timeSinceAnchor / epochDuration);
  const currentEpochStartTime = anchorTime + (epochsSinceAnchor * epochDuration);
  return new Date(currentEpochStartTime);
}

function generateEpochReport(epochId, frames) {
  if (!frames || frames.length === 0) {
    console.log(`No frames to report for epoch ${epochId}.`);
    return;
  }
  const epochEndDate = new Date(epochId);
  epochEndDate.setDate(epochEndDate.getDate() + 7);
  const fileName = `epoch-report-ending-${epochEndDate.toISOString().split('T')[0]}.csv`;
  const filePath = path.join(REPORTS_PATH, fileName);

  const header = 'Timestamp,RenderTime(s)\n';
  const rows = frames.map(f => `${f.timestamp},${f.renderTime}`).join('\n');
  const csvContent = header + rows;

  fs.writeFile(filePath, csvContent, (err) => {
    if (err) {
      console.error('Failed to save epoch report:', err);
    } else {
      console.log(`Successfully saved epoch report to ${filePath}`);
    }
  });
}

function startLogMonitoring() {
  if (!fs.existsSync(LOG_PATH)) return;
  let lastSize = fs.statSync(LOG_PATH).size;

  logWatcher = chokidar.watch(LOG_PATH, { persistent: true, usePolling: true, interval: 2000 });
  logWatcher.on('change', () => {
    try {
      const state = loadState();
      const stats = fs.statSync(LOG_PATH);
      if (stats.size > lastSize) {
        const stream = fs.createReadStream(LOG_PATH, { start: lastSize, encoding: 'utf8' });
        stream.on('data', chunk => {
          const lines = chunk.split('\n');
          lines.forEach(line => {
            if (line.trim() && !isLogLineEmpty(line)) {
              parseLine(line, state);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('log-line', line);
              }
            }
          });
          saveState(state);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('stats-update', getDisplayableStats(state));
          }
        });
      }
      lastSize = stats.size;
      state.lastPosition = lastSize;
      saveState(state);
    } catch (err) {
      console.error('Error in log watcher:', err);
    }
  });
}

function startGPUMonitoring() {
  const updateGPUInfo = () => {
    const query = 'index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,pstate,clocks_event_reasons.hw_thermal_slowdown';
    exec(`nvidia-smi --query-gpu=${query} --format=csv,noheader,nounits`, (err, stdout) => {
      if (err) {
        const state = loadState();
        state.gpuInfo = [];
        saveState(state);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('gpu-update', []);
        return;
      }
      const gpus = stdout.trim().split('\n').filter(l => l).map(line => {
        const parts = line.split(', ');
        return {
          index: parseInt(parts[0]),
          name: parts[1].trim(),
          temperature: parseInt(parts[2]),
          gpuUtilization: parseInt(parts[3]),
          memoryUsed: parseInt(parts[4]),
          memoryTotal: parseInt(parts[5]),
          pState: parts[6].trim(),
          isThrottling: parts[7].trim() === 'Active',
          memoryUsedGB: (parseInt(parts[4]) / 1024).toFixed(2),
          memoryTotalGB: (parseInt(parts[5]) / 1024).toFixed(2),
          memoryUtilization: Math.round((parseInt(parts[4]) / parseInt(parts[5])) * 100)
        };
      });
      const state = loadState();
      state.gpuInfo = gpus;
      saveState(state);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('gpu-update', gpus);
    });
  };
  updateGPUInfo();
  setInterval(updateGPUInfo, 2000);
}

function startProcessMonitoring() {
  const checkProcesses = async () => {
    try {
      const processes = await psList();
      const isRndrRunning = processes.some(proc => {
        const name = (proc.name || '').toLowerCase();
        return name === 'tcpsvcs.exe';
      });
      const command = 'powershell -command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object MainWindowTitle | ConvertTo-Json"';

      exec(command, (err, stdout) => {
        if (err) {
          console.error('Error executing PowerShell command:', err);
          return;
        }

        let isWatchdogRunning = false;
        try {
          const windowTitles = JSON.parse(stdout);
          const titlesToCheck = Array.isArray(windowTitles) ? windowTitles : [windowTitles];
          isWatchdogRunning = titlesToCheck.some(win => {
            const title = (win.MainWindowTitle || '').toLowerCase();
            return title.includes('rndr watchdog');
          });
        } catch (parseError) {
          isWatchdogRunning = false;
        }
        const state = loadState();
        state.rndrStatus = isRndrRunning;
        state.watchdogStatus = isWatchdogRunning;
        saveState(state);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('process-status', {
            rndr: isRndrRunning,
            watchdog: isWatchdogRunning
          });
        }
      });

    } catch (err) {
      console.error('An error occurred while checking processes:', err);
    }
  };

  checkProcesses();
  setInterval(checkProcesses, 5000);
}

ipcMain.handle('get-remote-log', async (event, { host, lines }) => {
  if (host === os.hostname()) {
    if (!fs.existsSync(LOG_PATH)) return { host: os.hostname(), lines: [] };
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const logLines = content.split('\n').filter(l => l.trim() && !isLogLineEmpty(l));
    return { host: os.hostname(), lines: logLines.slice(-lines) };
  }

  const remote = discoveredNodes.get(host);
  if (!remote) throw new Error('Unknown host');

  try {
    const resp = await axios.get(`http://${remote.host}:${remote.port}/api/log?lines=${lines}`);
    return resp.data;
  } catch (e) {
    throw new Error('Failed to fetch remote log');
  }
});

ipcMain.on('get-network-adapters', (event) => {
  const adapters = getNetworkAdapters();
  const state = loadState();
  event.reply('network-adapters-ready', {
    adapters: adapters,
    preferred: state.preferredAdapter
  });
});

ipcMain.on('set-network-adapter', (event, adapterAddress) => {
  const state = loadState();
  state.preferredAdapter = adapterAddress;
  saveState(state);

  if (iAmWebServerHost) {
    console.log("Network adapter changed, restarting web server...");
    if (bonjour) {
      if (bonjour._announceInterval) {
        clearInterval(bonjour._announceInterval);
      }
      bonjour.destroy();
      bonjour = null;
    }
    if (webServer) {
      webServer.close(() => {
        webServer = null;
        manageWebServer();
      });
    }
  }
});

ipcMain.on('open-report-generator', () => {
  if (reportWindow) {
    reportWindow.focus();
    return;
  }
  reportWindow = new BrowserWindow({
    width: 600,
    height: 700,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: false,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true
  });
  reportWindow.loadFile('reports.html');
  reportWindow.on('closed', () => {
    reportWindow = null;
  });
});

ipcMain.on('get-all-epochs', (event) => {
  if (!fs.existsSync(LOG_PATH)) {
    event.reply('epoch-list-ready', []);
    return;
  }

  parsedEpochData.clear();
  const fileStream = fs.createReadStream(LOG_PATH);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const totalSize = fs.statSync(LOG_PATH).size;
  let processedSize = 0;

  rl.on('line', (line) => {
    processedSize += Buffer.byteLength(line, 'utf8') + 1;
    if (line.includes('job completed successfully')) {
      const timestamp = extractTimestamp(line);
      const renderTime = extractRenderTime(line);
      if (timestamp && renderTime !== null) {
        const date = new Date(timestamp);
        const epochStart = getEpochStart(date);
        const epochId = epochStart.toISOString().split('T')[0];

        if (!parsedEpochData.has(epochId)) {
          const endDate = new Date(epochStart);
          endDate.setDate(endDate.getDate() + 7);
          parsedEpochData.set(epochId, {
            startDate: epochStart,
            endDate: endDate,
            frames: []
          });
        }
        parsedEpochData.get(epochId).frames.push({ timestamp, renderTime });
      }
    }
    if (reportWindow && !reportWindow.isDestroyed()) {
      reportWindow.webContents.send('epoch-parsing-progress', (processedSize / totalSize) * 100);
    }
  });

  rl.on('close', () => {
    const epochList = Array.from(parsedEpochData.entries()).map(([id, data]) => {
      const start = data.startDate;
      const end = new Date(data.endDate - 1);
      return {
        id,
        label: `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`,
        frameCount: data.frames.length
      };
    }).sort((a, b) => new Date(b.id) - new Date(a.id));

    if (reportWindow && !reportWindow.isDestroyed()) {
      reportWindow.webContents.send('epoch-list-ready', epochList);
    }
  });
});

ipcMain.on('generate-selected-reports', (event, selectedEpochIds) => {
  let generatedCount = 0;
  for (const epochId of selectedEpochIds) {
    if (parsedEpochData.has(epochId)) {
      const epochData = parsedEpochData.get(epochId);
      generateEpochReport(epochId, epochData.frames);
      generatedCount++;
    }
  }
  if (reportWindow && !reportWindow.isDestroyed()) {
    reportWindow.webContents.send('report-generation-complete', generatedCount);
  }
});

ipcMain.on('toggle-hosting', (event, isEnabled) => {
  const state = loadState();
  state.isHostingEnabled = isEnabled;
  saveState(state);
  event.reply('hosting-enabled-updated', isEnabled);
});

ipcMain.on('open-reports-folder', () => {
  shell.openPath(REPORTS_PATH);
});

ipcMain.on('open-log-file', () => { if (fs.existsSync(LOG_PATH)) shell.openPath(LOG_PATH); });

ipcMain.on('toggle-theme', (event) => {
  nativeTheme.themeSource = nativeTheme.themeSource === 'dark' ? 'light' : 'dark';
  event.reply('theme-changed', nativeTheme.themeSource);
});

ipcMain.on('minimize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.minimize();
});

ipcMain.on('maximize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  }
});

ipcMain.on('close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.close();
});

function parseTs(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  const [_, Y, M, D, h, mnt, s] = m;
  return new Date(
    Number(Y),
    Number(M) - 1,
    Number(D),
    Number(h),
    Number(mnt),
    Number(s),
    0
  );
}

function secondsBetween(a, b) {
  return a && b ? (b - a) / 1000 : null;
}

function fmtSeconds(totalSec) {
  if (totalSec == null) return '-';
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function min(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => (a < b ? a : b), arr[0]);
}

function max(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => (a > b ? a : b), arr[0]);
}

function parseLog(content) {
  const lines = content.split(/\r?\n/);

  const lineRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\w+):\s+\[(\d+)\]\s+(.*)$/;
  const jobs = [];
  let currentJob = null;
  let lastUsableGpus = null;

  const unmatched = { successes: 0, fails: 0, cancels: 0 };
  let firstTs = null;
  let lastTs = null;

  let octaneDetectOpen = null;

  const findPendingJobBy = (predicate) => {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      if (j.status === 'pending' && predicate(j)) return j;
    }
    return null;
  };

  const attachToMostRecentPending = () =>
    findPendingJobBy(() => true) || currentJob || null;

  for (let raw of lines) {
    if (!raw.trim()) continue;
    const m = lineRe.exec(raw);
    if (!m) continue;

    const [, tsStr, level, threadId, msg] = m;
    const ts = parseTs(tsStr);
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    let rx;
    if ((rx = /starting a new render job with config hash: ([a-f0-9]+)/i.exec(msg))) {
      const hash = rx[1].toLowerCase();
      const job = {
        id: jobs.length + 1,
        configHash: hash,
        jobStartTs: ts,
        status: 'pending',
        steps: {},
        reportedSeconds: null,
        wallSeconds: null,
        overheadSeconds: null,
        gpusDetected: lastUsableGpus ?? null,
        octaneDevices: null
      };
      jobs.push(job);
      currentJob = job;
      octaneDetectOpen = null;
      continue;
    }

    if ((rx = /(\d+)\s+usable gpus detected/i.exec(msg))) {
      lastUsableGpus = Number(rx[1]);
      if (currentJob && currentJob.status === 'pending' && currentJob.gpusDetected == null) {
        currentJob.gpusDetected = lastUsableGpus;
      }
      octaneDetectOpen = null;
      continue;
    }

    if (/octane gpu devices detected and enabled/i.test(msg)) {
      octaneDetectOpen = { ts, count: 0 };
      if (currentJob) currentJob.steps.octaneDetectTs = ts;
      continue;
    }
    if (/octane gpu device\s+\d+\s+/i.test(msg)) {
      if (octaneDetectOpen) {
        octaneDetectOpen.count++;
        if (currentJob) currentJob.octaneDevices = octaneDetectOpen.count;
        continue;
      }
    } else {
      octaneDetectOpen = null;
    }

    if (/Initializing c4d system assets/i.test(msg)) {
      if (currentJob) currentJob.steps.systemAssetsStart = ts;
      continue;
    }
    if (/Initialized c4d system assets/i.test(msg)) {
      if (currentJob) currentJob.steps.systemAssetsEnd = ts;
      continue;
    }
    if (/Initializing c4d core/i.test(msg)) {
      if (currentJob) currentJob.steps.coreStart = ts;
      continue;
    }
    if (/Initialized c4d core/i.test(msg)) {
      if (currentJob) currentJob.steps.coreEnd = ts;
      continue;
    }
    if (/Loaded c4d scene/i.test(msg)) {
      if (currentJob) currentJob.steps.sceneLoaded = ts;
      continue;
    }
    if (/Loaded c4d renderer setting/i.test(msg)) {
      if (currentJob) currentJob.steps.rendererLoaded = ts;
      continue;
    }
    if (/Determined output info/i.test(msg)) {
      if (currentJob) currentJob.steps.outputInfo = ts;
      continue;
    }

    if (/Started c4d rendering/i.test(msg)) {
      const job = attachToMostRecentPending();
      if (job) job.steps.renderStart = ts;
      continue;
    }

    if ((rx = /sent render finished, job completed successfully \(render time ([\d.]+) seconds\)/i.exec(msg))) {
      const reported = parseFloat(rx[1]);
      let job =
        findPendingJobBy(j => j.steps.renderStart && j.reportedSeconds == null) ||
        attachToMostRecentPending();
      if (!job) {
        unmatched.successes++;
        continue;
      }
      job.steps.renderEnd = ts;
      job.reportedSeconds = reported;
      job.wallSeconds = secondsBetween(job.steps.renderStart, job.steps.renderEnd);
      job.overheadSeconds =
        job.wallSeconds != null ? job.wallSeconds - job.reportedSeconds : null;
      job.status = 'success';
      continue;
    }

    if (/job was canceled/i.test(msg)) {
      const job = attachToMostRecentPending();
      if (job) {
        job.status = 'canceled';
        job.steps.cancelTs = ts;
      } else {
        unmatched.cancels++;
      }
      continue;
    }

    if ((rx = /job failed with config hash:\s*([a-f0-9]+)/i.exec(msg))) {
      const hash = rx[1].toLowerCase();
      const job = findPendingJobBy(j => j.configHash === hash);
      if (job) {
        job.status = 'failed';
        job.steps.failTs = ts;
      } else {
        unmatched.fails++;
      }
      continue;
    }

  }

  const successJobs = jobs.filter(j => j.status === 'success');
  const failedJobs = jobs.filter(j => j.status === 'failed');
  const canceledJobs = jobs.filter(j => j.status === 'canceled');
  const pendingJobs = jobs.filter(j => j.status === 'pending');

  const reportedSecs = successJobs.map(j => j.reportedSeconds).filter(v => v != null);
  const wallSecs = successJobs.map(j => j.wallSeconds).filter(v => v != null);
  const overheadSecs = successJobs
    .map(j => j.overheadSeconds)
    .filter(v => v != null);

  const assetsInit = jobs
    .map(j => secondsBetween(j.steps.systemAssetsStart, j.steps.systemAssetsEnd))
    .filter(v => v != null);
  const coreInit = jobs
    .map(j => secondsBetween(j.steps.coreStart, j.steps.coreEnd))
    .filter(v => v != null);

  const ttfp = jobs
    .map(j => {
      const rs = j?.steps?.renderStart;
      if (!rs) return null;
      const anchors = [
        j.steps.outputInfo,
        j.steps.rendererLoaded,
        j.steps.sceneLoaded,
        j.steps.coreEnd,
        j.steps.systemAssetsEnd,
        j.jobStartTs
      ].filter(Boolean);
      if (anchors.length === 0) return null;
      const lastAnchor = anchors[anchors.length - 1];
      return secondsBetween(lastAnchor, rs);
    })
    .filter(v => v != null);

  const byHash = new Map();
  for (const j of jobs) {
    const h = j.configHash || 'unknown';
    if (!byHash.has(h)) {
      byHash.set(h, {
        hash: h,
        success: 0,
        failed: 0,
        canceled: 0,
        reported: [],
        wall: []
      });
    }
    const s = byHash.get(h);
    if (j.status === 'success') {
      s.success++;
      if (j.reportedSeconds != null) s.reported.push(j.reportedSeconds);
      if (j.wallSeconds != null) s.wall.push(j.wallSeconds);
    } else if (j.status === 'failed') {
      s.failed++;
    } else if (j.status === 'canceled') {
      s.canceled++;
    }
  }

  return {
    firstTs,
    lastTs,
    jobs,
    unmatched,
    summary: {
      totalJobsStarted: jobs.length,
      successCount: successJobs.length,
      failedCount: failedJobs.length,
      canceledCount: canceledJobs.length,
      pendingCount: pendingJobs.length,

      totalReportedSeconds: reportedSecs.reduce((a, b) => a + b, 0),
      totalWallSeconds: wallSecs.reduce((a, b) => a + b, 0),
      totalOverheadSeconds: overheadSecs.reduce((a, b) => a + b, 0),

      avgReportedSeconds: avg(reportedSecs),
      avgWallSeconds: avg(wallSecs),
      avgOverheadSeconds: avg(overheadSecs),

      minReportedSeconds: min(reportedSecs),
      maxReportedSeconds: max(reportedSecs),

      avgAssetsInitSeconds: avg(assetsInit),
      avgCoreInitSeconds: avg(coreInit),
      avgTimeToFirstPixelSeconds: avg(ttfp)
    },
    perHash: Array.from(byHash.values()).sort((a, b) => b.success - a.success)
  };
}

function printSummary(res) {
  const {
    firstTs,
    lastTs,
    unmatched,
    summary: s
  } = res;

  console.log('RNDR log analysis');
  console.log('-----------------');
  console.log(`Span: ${firstTs?.toISOString?.() ?? '-'} → ${lastTs?.toISOString?.() ?? '-'}`);
  if (firstTs && lastTs) {
    console.log(`Total span (hh:mm:ss): ${fmtSeconds((lastTs - firstTs) / 1000)}`);
  }
  console.log('');
  console.log(`Jobs started: ${s.totalJobsStarted}`);
  console.log(`Success: ${s.successCount} | Failed: ${s.failedCount} | Canceled: ${s.canceledCount} | Pending/incomplete: ${s.pendingCount}`);
  if (unmatched.successes || unmatched.fails || unmatched.cancels) {
    console.log(`Unmatched events → Success: ${unmatched.successes}, Fail: ${unmatched.fails}, Cancel: ${unmatched.cancels}`);
  }
  console.log('');
  console.log(`Total reported render time: ${fmtSeconds(s.totalReportedSeconds)} (${s.totalReportedSeconds.toFixed(1)}s)`);
  console.log(`Total wall render time:     ${fmtSeconds(s.totalWallSeconds)} (${s.totalWallSeconds.toFixed(1)}s)`);
  console.log(`Total overhead:             ${fmtSeconds(s.totalOverheadSeconds)} (${s.totalOverheadSeconds.toFixed(1)}s)`);
  if (s.totalWallSeconds > 0) {
    const pct = (s.totalOverheadSeconds / s.totalWallSeconds) * 100;
    console.log(`Overhead vs wall:           ${pct.toFixed(2)}%`);
  }
  console.log('');
  console.log(`Avg reported/frame: ${s.avgReportedSeconds != null ? s.avgReportedSeconds.toFixed(3) + 's' : '-'}`);
  console.log(`Avg wall/frame:     ${s.avgWallSeconds != null ? s.avgWallSeconds.toFixed(3) + 's' : '-'}`);
  console.log(`Avg overhead/frame: ${s.avgOverheadSeconds != null ? s.avgOverheadSeconds.toFixed(3) + 's' : '-'}`);
  console.log(`Min/Max reported:   ${s.minReportedSeconds != null ? s.minReportedSeconds.toFixed(3) : '-'}s / ${s.maxReportedSeconds != null ? s.maxReportedSeconds.toFixed(3) : '-'}s`);
  console.log('');
  console.log(`Avg init (assets):  ${s.avgAssetsInitSeconds != null ? s.avgAssetsInitSeconds.toFixed(3) + 's' : '-'}`);
  console.log(`Avg init (core):    ${s.avgCoreInitSeconds != null ? s.avgCoreInitSeconds.toFixed(3) + 's' : '-'}`);
  console.log(`Avg time→render:    ${s.avgTimeToFirstPixelSeconds != null ? s.avgTimeToFirstPixelSeconds.toFixed(3) + 's' : '-'}`);
  console.log('');
  console.log('Top config hashes (by successes):');
  for (const ph of res.perHash.slice(0, 10)) {
    const avgRep = avg(ph.reported);
    const avgWall = avg(ph.wall);
    console.log(
      `- ${ph.hash}: success=${ph.success}, failed=${ph.failed}, canceled=${ph.canceled}` +
      `${avgRep != null ? `, avgReported=${avgRep.toFixed(3)}s` : ''}` +
      `${avgWall != null ? `, avgWall=${avgWall.toFixed(3)}s` : ''}`
    );
  }
}

if (process.argv.includes('--analyze-log')) {
  (function analyzeRndrLog() {
    try {
      const logPath = path.join(__dirname, 'tools', 'rndr_log.txt');
      const raw = fs.readFileSync(logPath, 'utf8');
      const result = parseLog(raw);

      if (process.argv.includes('--json')) {
        const out = {
          firstTs: result.firstTs?.toISOString?.() ?? null,
          lastTs: result.lastTs?.toISOString?.() ?? null,
          summary: result.summary,
          unmatched: result.unmatched,
          perHash: result.perHash
        };
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      printSummary(result);
    } catch (err) {
      console.error('Failed to analyze RNDR log:', err.message);
      process.exitCode = 1;
    }
  })();
}
