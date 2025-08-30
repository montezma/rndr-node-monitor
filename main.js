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

let mainWindow;
let reportWindow;
let logWatcher;
let discoveredNodes = new Map();
let webServer, wss, bonjour;
let iAmWebServerHost = false;
let currentHostName = null;
let parsedEpochData = new Map();

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
      const { address, family, internal } = iface;
      if (family === 'IPv4' && !internal) {
        adapters.push({ name: name, address: address });
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

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => {
  createWindow();
  startApiServer();
  startServiceDiscovery();
  initializeMonitoring();
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
  apiApp.get('/api/status', (req, res) => res.json(getLocalNodeData()));
  apiApp.listen(API_PORT, '0.0.0.0', () => console.log(`Node API server running on port ${API_PORT}`));
}

function manageWebServer() {
  const state = loadState();
  if (iAmWebServerHost && !webServer && state.isHostingEnabled) {
    console.log(`This node (${os.hostname()}) is now the web host.`);
    const webApp = express();
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
        socket: dgram.createSocket({
          type: 'udp4',
          reuseAddr: true
        })
      });

      bonjour.on('query', (query) => {
        if (query.questions.some(q => q.name === 'render.local')) {
          bonjour.respond({
            answers: [{
              name: 'render.local',
              type: 'A',
              ttl: 120,
              data: preferredIp
            }]
          });
        }

        if (query.questions.some(q => q.name === '_http._tcp.local')) {
          bonjour.respond({
            answers: [{
              name: 'RNDR Monitor._http._tcp.local',
              type: 'SRV',
              data: {
                port: WEB_PORT,
                weight: 0,
                priority: 0,
                target: 'render.local'
              }
            }]
          });
        }
      });

      const announce = () => {
        bonjour.respond({
          answers: [
            {
              name: 'render.local',
              type: 'A',
              ttl: 120,
              data: preferredIp
            },
            {
              name: 'RNDR Monitor._http._tcp.local',
              type: 'PTR',
              ttl: 120,
              data: 'RNDR Monitor._http._tcp.local'
            }
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
      if (bonjour._announceInterval) {
        clearInterval(bonjour._announceInterval);
      }
      bonjour.destroy();
      bonjour = null;
    }

    if (wss) wss.close();
    if (webServer) {
      webServer.close(() => {
        webServer = null;
      });
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
    gpuInfo: state.gpuInfo,
    stats: state.stats,
    lastUpdate: state.lastUpdate,
    recentLogs: recentLogs
  };
}

function initializeMonitoring() {
  checkInitialStatus();
  startLogMonitoring();
  startGPUMonitoring();
  startProcessMonitoring();
  setInterval(updateNetworkNodes, 5000);
}

function checkInitialStatus() {
  if (!fs.existsSync(LOG_PATH)) {
    mainWindow.webContents.send('log-error', 'Log file not found');
    return;
  }
  mainWindow.webContents.send('loading-status', 'Analyzing render history...');


  const state = loadState();


  state.stats = {
    lifetimeFrames: { successful: 0, failed: 0 },
    dailyFrames: { successful: 0, failed: 0 },
    epochFrames: { successful: 0, failed: 0 },
    lastFrameTime: null
  };


  const content = fs.readFileSync(LOG_PATH, 'utf8');
  const lines = content.split('\n');


  lines.forEach(line => {
    parseLine(line, state);
  });


  state.lastPosition = content.length;
  saveState(state);


  mainWindow.webContents.send('stats-update', state.stats);


  const recentLines = lines.filter(line => line.trim() && !isLogLineEmpty(line));
  mainWindow.webContents.send('initial-log-entries', recentLines.slice(-25));


  mainWindow.webContents.send('loading-complete');
}

function loadState() {
  const defaults = {
    isHostingEnabled: true,
    lastPosition: 0,
    preferredAdapter: null,
    stats: {
      lifetimeFrames: { successful: 0, failed: 0 },
      dailyFrames: { successful: 0, failed: 0 },
      epochFrames: { successful: 0, failed: 0 },
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

function parseLine(line, state) {
  if (isLogLineEmpty(line)) return;

  const timestamp = extractTimestamp(line);
  if (!timestamp) return;

  const lineTime = new Date(timestamp).getTime();
  const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const currentEpochStart = getEpochStart(new Date()).getTime();

  if (state.stats.lastFrameTime && new Date(state.stats.lastFrameTime).getTime() < currentEpochStart && lineTime >= currentEpochStart) {
    console.log("New epoch detected, resetting live epoch stats.");
    state.stats.epochFrames = { successful: 0, failed: 0 };
  }

  if (line.includes('job completed successfully')) {
    state.stats.lifetimeFrames.successful++;
    if (lineTime > dayAgo) state.stats.dailyFrames.successful++;
    if (lineTime >= currentEpochStart) state.stats.epochFrames.successful++;
    state.stats.lastFrameTime = timestamp;
  } else if (line.includes('job failed')) {
    state.stats.lifetimeFrames.failed++;
    if (lineTime > dayAgo) state.stats.dailyFrames.failed++;
    if (lineTime >= currentEpochStart) state.stats.epochFrames.failed++;
  }
}

function extractTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  return match ? match[1] : null;
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
            mainWindow.webContents.send('stats-update', state.stats);
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
  const checkProcesses = () => {
    exec('tasklist /V /FO CSV', (err, stdout) => {
      if (err) {
        console.error('Error checking processes:', err);
        return;
      }

      const lines = stdout.trim().split('\n');
      let rndrRunning = false;
      let watchdogRunning = false;

      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        if (lowerLine.includes('rndr') && (lowerLine.includes('tcp/ip services') || lowerLine.includes('rndr client'))) {
          rndrRunning = true;
        }

        if (lowerLine.includes('watchdog')) {
          watchdogRunning = true;
        }

        if (rndrRunning && watchdogRunning) {
          break;
        }
      }

      const state = loadState();
      state.rndrStatus = rndrRunning;
      state.watchdogStatus = watchdogRunning;
      saveState(state);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('process-status', {
          rndr: rndrRunning,
          watchdog: watchdogRunning
        });
      }
    });
  };

  checkProcesses();
  setInterval(checkProcesses, 5000);
}

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
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        bonjour = null;
      });
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

