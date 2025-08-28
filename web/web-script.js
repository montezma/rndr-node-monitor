let selectedNodeName = null;
let allNodes = [];
let lastRenderedLogs = '';

function updateProcessStatusDisplay(status) {
    const rndrDot = document.getElementById('rndrStatus');
    const rndrText = document.getElementById('rndrStatusText');
    const watchdogDot = document.getElementById('watchdogStatus');
    const watchdogText = document.getElementById('watchdogStatusText');

    if (!rndrDot || !rndrText || !watchdogDot || !watchdogText) return;

    rndrDot.className = `status-dot ${status.rndr ? 'active' : 'inactive'}`;
    rndrText.textContent = status.rndr ? 'Running' : 'Stopped';
    watchdogDot.className = `status-dot ${status.watchdog ? 'active' : 'inactive'}`;
    watchdogText.textContent = status.watchdog ? 'Running' : 'Stopped';
}

function updateThermalStatus(gpus) {
    const thermalDot = document.getElementById('thermalStatus');
    const thermalText = document.getElementById('thermalStatusText');

    if (!thermalDot || !thermalText) return;

    if (!gpus || gpus.length === 0) {
        thermalDot.className = 'status-dot';
        thermalText.textContent = 'N/A';
        return;
    }
    const isAnyGpuThrottling = gpus.some(gpu => gpu.isThrottling);
    if (isAnyGpuThrottling) {
        thermalDot.className = 'status-dot warning';
        thermalText.textContent = 'HW Throttling Active';
    } else {
        thermalDot.className = 'status-dot active';
        thermalText.textContent = 'Nominal';
    }
}

function updateStatsDisplay(stats) {
    const set = (id, val) => { 
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    
    if (!stats) {
        ['dailyTotal', 'dailySuccess', 'dailyFailed', 'epochTotal', 'epochSuccess', 'epochFailed', 'lifetimeTotal', 'lifetimeSuccess', 'lifetimeFailed'].forEach(id => set(id, 'N/A'));
        set('lastFrameTime', 'Offline');
        set('timeAgo', '');
        return;
    }

    const safeStats = {
        dailyFrames: { successful: 0, failed: 0 },
        epochFrames: { successful: 0, failed: 0 },
        lifetimeFrames: { successful: 0, failed: 0 },
        ...stats
    };

    set('dailyTotal', safeStats.dailyFrames.successful + safeStats.dailyFrames.failed);
    set('dailySuccess', safeStats.dailyFrames.successful);
    set('dailyFailed', safeStats.dailyFrames.failed);
    set('epochTotal', safeStats.epochFrames.successful + safeStats.epochFrames.failed);
    set('epochSuccess', safeStats.epochFrames.successful);
    set('epochFailed', safeStats.epochFrames.failed);
    set('lifetimeTotal', safeStats.lifetimeFrames.successful + safeStats.lifetimeFrames.failed);
    set('lifetimeSuccess', safeStats.lifetimeFrames.successful);
    set('lifetimeFailed', safeStats.lifetimeFrames.failed);

    if (stats.lastFrameTime) {
        const frameTime = new Date(stats.lastFrameTime);
        set('lastFrameTime', frameTime.toLocaleString());
        updateTimeAgo(frameTime);
    } else {
         set('lastFrameTime', 'No frames yet');
         set('timeAgo', '');
    }
}

function displayGPUs(gpus) {
    const gpuGrid = document.getElementById('gpuGrid');
    if (!gpuGrid) return;
    if (!gpus || gpus.length === 0) {
        gpuGrid.innerHTML = `<div class="gpu-card"><div class="gpu-name">No GPU data available</div></div>`;
        return;
    }
    gpuGrid.innerHTML = gpus.map(gpu => `
        <div class="gpu-card">
            <div class="gpu-header">
                <div class="gpu-name">GPU ${gpu.index}: ${gpu.name}</div>
                <div class="gpu-temp">${gpu.temperature}°C / ${gpu.pState}</div>
            </div>
            <div class="gpu-metrics">
                 <div class="metric"><div class="metric-label">GPU Usage</div><div class="metric-value">${gpu.gpuUtilization}%</div><div class="progress-bar"><div class="progress-fill" style="width: ${gpu.gpuUtilization}%"></div></div></div>
                 <div class="metric"><div class="metric-label">Memory Usage</div><div class="metric-value">${gpu.memoryUsedGB} / ${gpu.memoryTotalGB} GB</div><div class="progress-bar"><div class="progress-fill" style="width: ${gpu.memoryUtilization}%"></div></div></div>
            </div>
        </div>`).join('');
}

function displayLogEntries(entries) {
    const logEl = document.getElementById('logEntries');
    if (!logEl) return;
    if (!entries || entries.length === 0) {
        if (lastRenderedLogs !== '') {
            logEl.innerHTML = `<div style="color: var(--text-secondary);">No log entries available.</div>`;
            lastRenderedLogs = '';
        }
        return;
    }
    const newLogsSignature = entries.map(entry => entry.text).join('\n');
    if (newLogsSignature !== lastRenderedLogs) {
        logEl.innerHTML = entries.map(entry => `<div class="${entry.className}">${entry.text}</div>`).join('');
        lastRenderedLogs = newLogsSignature;
    }
}

function getLogEntryClass(line) {
    if (line.includes('job completed successfully')) return 'log-entry success';
    if (line.includes('failed') || line.includes('ERROR')) return 'log-entry error';
    if (line.includes('WARNING')) return 'log-entry warning';
    return 'log-entry';
}

function updateTimeAgo(lastTime) {
    const diff = new Date() - lastTime;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const timeAgoEl = document.getElementById('timeAgo');
    if (timeAgoEl) {
        timeAgoEl.textContent = hours > 0 ? `(${hours}h ${minutes}m ago)` : `(${minutes}m ago)`;
    }
}

function updateNextEpoch() {
    const anchorTime = Date.UTC(2025, 7, 26, 23, 17, 23);
    const epochDuration = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const timeSinceAnchor = now - anchorTime;
    const epochsSinceAnchor = Math.floor(timeSinceAnchor / epochDuration);
    const nextEpochTime = new Date(anchorTime + ((epochsSinceAnchor + 1) * epochDuration));
    const diff = nextEpochTime - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const nextEpochEl = document.getElementById('nextEpoch');
    if (nextEpochEl) {
        nextEpochEl.textContent = `${days}d ${hours}h`;
    }
}

function updateNodeList() {
    const nodeList = document.getElementById('nodeList');
    if (!nodeList || !allNodes || allNodes.length === 0) {
        nodeList.innerHTML = '';
        return;
    }

    const localNode = allNodes[0];
    const remoteNodes = allNodes.slice(1);

    const localNodeHTML = `<li class="node-item ${selectedNodeName === localNode.name ? 'active' : ''}" onclick="selectNode('${localNode.name}')"><div class="node-status ${localNode.data ? 'status-online' : 'status-offline'}"></div><span>${localNode.name} (Host)</span></li>`;
    
    const remoteNodesHTML = remoteNodes.map(node => {
        const statusClass = node.data ? 'status-online' : 'status-offline';
        return `<li class="node-item ${selectedNodeName === node.name ? 'active' : ''}" onclick="selectNode('${node.name}')"><div class="node-status ${statusClass}"></div><span>${node.name}</span></li>`;
    }).join('');

    nodeList.innerHTML = localNodeHTML + remoteNodesHTML;
}

function selectNode(nodeName) {
    selectedNodeName = nodeName;
    const node = allNodes.find(n => n.name === nodeName);
    displayNodeData(nodeName, node ? node.data : null);
    updateNodeList();
}

function displayNodeData(nodeName, data) {
    const titleEl = document.getElementById('nodeTitle');
    if (titleEl) titleEl.textContent = nodeName;

    if (!data) {
        const nodeItem = Array.from(document.querySelectorAll('.node-item')).find(item => item.textContent.includes(nodeName));
        if (nodeItem) {
            const statusDot = nodeItem.querySelector('.node-status');
            if (statusDot) statusDot.className = 'node-status status-offline';
        }
        return;
    }

    updateStatsDisplay(data.stats);
    updateProcessStatusDisplay({ rndr: data.rndrStatus, watchdog: data.watchdogStatus });
    updateThermalStatus(data.gpuInfo);
    displayGPUs(data.gpuInfo);
    const logs = data.recentLogs ? data.recentLogs.map(line => ({ text: line, className: getLogEntryClass(line) })) : [];
    displayLogEntries(logs);
}

function connect() {
    const socket = new WebSocket(`ws://${window.location.host}`);
    socket.onmessage = (event) => {
        const { type, payload } = JSON.parse(event.data);
        if (type === 'all-nodes-update') {
            allNodes = payload;
            if (!selectedNodeName || !allNodes.some(n => n.name === selectedNodeName)) {
                selectNode(allNodes[0]?.name);
            } else {
                const updatedNodeData = allNodes.find(n => n.name === selectedNodeName);
                if (updatedNodeData) {
                    displayNodeData(updatedNodeData.name, updatedNodeData.data);
                }
            }
            updateNodeList();
        }
    };
    socket.onclose = () => {
        console.log('WebSocket disconnected. Reconnecting in 2 seconds...');
        setTimeout(connect, 2000);
    };
    socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        socket.close();
    };
}

document.addEventListener('DOMContentLoaded', () => {
    updateNextEpoch();
    setInterval(updateNextEpoch, 60 * 60 * 1000);
    
setInterval(() => {
        const lastFrameElement = document.getElementById('lastFrameTime');
        if (lastFrameElement && lastFrameElement.textContent.includes('/')) {
            const lastTime = new Date(lastFrameElement.textContent);
            if (!isNaN(lastTime)) {
                updateTimeAgo(lastTime);
            }
        }
    }, 10000);
    connect();
});