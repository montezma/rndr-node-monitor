let selectedNodeName = null;
let allNodes = [];
let lastRenderedLogs = '';

function updateProcessStatusDisplay(status) {
    const update = (dotId, textId, isActive) => {
        const dot = document.getElementById(dotId);
        const text = document.getElementById(textId);
        dot.className = `status-dot ${isActive ? 'active' : 'inactive'}`;
        text.textContent = isActive ? 'Running' : 'Stopped';
    };
    update('rndrStatus', 'rndrStatusText', status.rndr);
    update('watchdogStatus', 'watchdogStatusText', status.watchdog);
}

function updateThermalStatus(gpus) {
    const thermalDot = document.getElementById('thermalStatus');
    const thermalText = document.getElementById('thermalStatusText');

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
    const set = (id, val) => { document.getElementById(id).textContent = val; };
    if (!stats) {
        ['dailyTotal', 'dailySuccess', 'dailyFailed', 'epochTotal', 'epochSuccess', 'epochFailed', 'lifetimeTotal', 'lifetimeSuccess', 'lifetimeFailed'].forEach(id => set(id, 'N/A'));
        set('lastFrameTime', 'Offline');
        set('timeAgo', '');
        return;
    }
    set('dailyTotal', stats.dailyFrames.successful + stats.dailyFrames.failed);
    set('dailySuccess', stats.dailyFrames.successful);
    set('dailyFailed', stats.dailyFrames.failed);
    set('epochTotal', stats.epochFrames.successful + stats.epochFrames.failed);
    set('epochSuccess', stats.epochFrames.successful);
    set('epochFailed', stats.epochFrames.failed);
    set('lifetimeTotal', stats.lifetimeFrames.successful + stats.lifetimeFrames.failed);
    set('lifetimeSuccess', stats.lifetimeFrames.successful);
    set('lifetimeFailed', stats.lifetimeFrames.failed);
    if (stats.lastFrameTime) {
        const frameTime = new Date(stats.lastFrameTime);
        document.getElementById('lastFrameTime').textContent = frameTime.toLocaleString();
        updateTimeAgo(frameTime);
    } else {
         document.getElementById('lastFrameTime').textContent = 'No frames yet';
         document.getElementById('timeAgo').textContent = '';
    }
}

function displayGPUs(gpus) {
    const gpuGrid = document.getElementById('gpuGrid');
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
    document.getElementById('timeAgo').textContent = hours > 0 ? `(${hours}h ${minutes}m ago)` : `(${minutes}m ago)`;
}

function updateNextEpoch() {
    const now = new Date();
    const anchorTime = Date.UTC(2025, 7, 26, 23, 17, 23);
    const epochDuration = 7 * 24 * 60 * 60 * 1000;
    const timeSinceAnchor = now - anchorTime;
    const epochsSinceAnchor = Math.floor(timeSinceAnchor / epochDuration);
    const nextEpochTime = new Date(anchorTime + ((epochsSinceAnchor + 1) * epochDuration));
    const diff = nextEpochTime - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    document.getElementById('nextEpoch').textContent = `${days}d ${hours}h`;
}

function updateNodeList() {
    const nodeList = document.getElementById('nodeList');
    const localNodeHTML = `<li class="node-item ${selectedNodeName === allNodes[0]?.name ? 'active' : ''}" onclick="selectNode('${allNodes[0]?.name}')"><div class="node-status ${allNodes[0]?.data ? 'status-online' : 'status-offline'}"></div><span>${allNodes[0]?.name} (Local)</span></li>`;
    
    const remoteNodesHTML = allNodes.slice(1).map(node => {
        const statusClass = node.data ? 'status-online' : 'status-offline';
        return `<li class="node-item ${selectedNodeName === node.name ? 'active' : ''}" onclick="selectNode('${node.name}')"><div class="node-status ${statusClass}"></div><span>${node.name}</span></li>`;
    }).join('');

    nodeList.innerHTML = localNodeHTML + remoteNodesHTML;
}

function selectNode(nodeName) {
    selectedNodeName = nodeName;
    const node = allNodes.find(n => n.name === nodeName);
    displayNodeData(node.name, node ? node.data : null);
    updateNodeList();
}

function displayNodeData(nodeName, data) {
    document.getElementById('nodeTitle').textContent = nodeName;

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
    connect();
});