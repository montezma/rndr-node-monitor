let selectedNodeName = null;
let allNodes = [];
let lastRenderedLogs = '';
let framesChart = null;
let epochBounds = null;
let userEpochCustomView = false;

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
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    if (stats && stats.lifetimeFrames) {
        const lifetimeTotalFrames = stats.lifetimeFrames.successful + stats.lifetimeFrames.failed;
        const lifetimeSuccessPercent = lifetimeTotalFrames > 0 ? Math.round((stats.lifetimeFrames.successful / lifetimeTotalFrames) * 100) : 0;
        const lifetimeFailedPercent = lifetimeTotalFrames > 0 ? Math.round((stats.lifetimeFrames.failed / lifetimeTotalFrames) * 100) : 0;
        set('lifetimeTotal', lifetimeTotalFrames);
        set('lifetimeSuccess', stats.lifetimeFrames.successful);
        set('lifetimeFailed', stats.lifetimeFrames.failed);
        set('lifetimeSuccessPercent', `(${lifetimeSuccessPercent}%)`);
        set('lifetimeFailedPercent', `(${lifetimeFailedPercent}%)`);
        set('lifetimeSuccessTime', formatSeconds(stats.lifetimeFrames.successfulTime));
        set('lifetimeFailedTime', formatSeconds(stats.lifetimeFrames.failedTime));
    } else {
        ['lifetimeTotal', 'lifetimeSuccess', 'lifetimeFailed'].forEach(id => set(id, 'N/A'));
        ['lifetimeSuccessPercent', 'lifetimeFailedPercent'].forEach(id => set(id, ''));
        set('lifetimeSuccessTime', '');
        set('lifetimeFailedTime', '');
    }

    if (!stats) {
        ['dailyTotal', 'dailySuccess', 'dailyFailed', 'epochTotal', 'epochSuccess', 'epochFailed'].forEach(id => set(id, 'N/A'));
        ['dailySuccessPercent', 'dailyFailedPercent', 'epochSuccessPercent', 'epochFailedPercent'].forEach(id => set(id, ''));
        set('lastFrameTime', 'Offline');
        set('timeAgo', '');
        set('dailySuccessTime', '');
        set('dailyFailedTime', '');
        set('epochSuccessTime', '');
        set('epochFailedTime', '');
        return;
    }

    const dailyTotalFrames = stats.dailyFrames.successful + stats.dailyFrames.failed;
    const dailySuccessPercent = dailyTotalFrames > 0 ? Math.round((stats.dailyFrames.successful / dailyTotalFrames) * 100) : 0;
    const dailyFailedPercent = dailyTotalFrames > 0 ? Math.round((stats.dailyFrames.failed / dailyTotalFrames) * 100) : 0;
    set('dailyTotal', dailyTotalFrames);
    set('dailySuccess', stats.dailyFrames.successful);
    set('dailyFailed', stats.dailyFrames.failed);
    set('dailySuccessPercent', dailyTotalFrames > 0 ? `(${dailySuccessPercent}%)` : '');
    set('dailyFailedPercent', dailyTotalFrames > 0 ? `(${dailyFailedPercent}%)` : '');

    const epochFrames = stats.epochFrames || { successful: 0, failed: 0 };
    const epochTotalFrames = epochFrames.successful + epochFrames.failed;
    const epochSuccessPercent = epochTotalFrames > 0 ? Math.round((epochFrames.successful / epochTotalFrames) * 100) : 0;
    const epochFailedPercent = epochTotalFrames > 0 ? Math.round((epochFrames.failed / epochTotalFrames) * 100) : 0;
    set('epochTotal', epochTotalFrames);
    set('epochSuccess', epochFrames.successful);
    set('epochFailed', epochFrames.failed);
    set('epochSuccessPercent', epochTotalFrames > 0 ? `(${epochSuccessPercent}%)` : '');
    set('epochFailedPercent', epochTotalFrames > 0 ? `(${epochFailedPercent}%)` : '');

    set('dailySuccessTime', formatSeconds(stats.dailyFrames.successfulTime));
    set('dailyFailedTime', formatSeconds(stats.dailyFrames.failedTime));
    set('epochSuccessTime', formatSeconds(epochFrames.successfulTime));
    set('epochFailedTime', formatSeconds(epochFrames.failedTime));

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
    if (!nodeList) return;

    const homeButtonHTML = `
        <li class="node-item ${selectedNodeName === 'home' ? 'active' : ''}" onclick="selectNode('home')">
            <div class="node-info" style="flex-direction: row; align-items: center; gap: 10px;">
                <span style="font-size: 18px;"></span>
                <span class="node-name">Home</span>
            </div>
        </li>`;

    if (!allNodes || allNodes.length === 0) {
        nodeList.innerHTML = homeButtonHTML;
        return;
    }

    const nodesHTML = allNodes.map(node => {
        const connectionStatusClass = node.data ? 'status-online' : 'status-offline';
        const rndrStatusClass = (node.data && node.data.rndrStatus) ? 'status-online' : 'status-offline';
        const dailyFrames = (node.data && node.data.stats) ? node.data.stats.dailyFrames : { successful: 0, failed: 0 };
        const isHost = node.name.toLowerCase().includes('host');

        return `
            <li class="node-item ${selectedNodeName === node.name ? 'active' : ''}" onclick="selectNode('${node.name}')">
                <div class="node-indicators">
                    <div class="indicator"><div class="node-status ${connectionStatusClass}"></div> C</div>
                    <div class="indicator"><div class="node-status ${rndrStatusClass}"></div> R</div>
                </div>
                <div class="node-info">
                    <span class="node-name">${node.name}${isHost ? '' : ''}</span>
                    <div class="node-frames">
                        <span class="frames-success">${dailyFrames.successful}</span> / <span class="frames-failed">${dailyFrames.failed}</span>
                    </div>
                </div>
            </li>`;
    }).join('');

    nodeList.innerHTML = homeButtonHTML + nodesHTML;
}

function selectNode(nodeName) {
    selectedNodeName = nodeName;
    updateNodeList();

    const singleNodeView = document.getElementById('singleNodeView');
    const allNodesView = document.getElementById('allNodesView');

    if (nodeName === 'home') {
        singleNodeView.style.display = 'none';
        allNodesView.style.display = 'grid';
        renderAllNodesView();
    } else {
        singleNodeView.style.display = 'block';
        allNodesView.style.display = 'none';
        const node = allNodes.find(n => n.name === nodeName);
        displayNodeData(nodeName, node ? node.data : null);
    }

    if (window.buildLogHostSelect) { try { window.buildLogHostSelect(); } catch (e) { } }
}

function renderAllNodesView() {
    const allNodesView = document.getElementById('allNodesView');
    if (!allNodesView) return;

    allNodesView.innerHTML = allNodes.map(node => {
        const data = node.data;
        if (!data) {
            return `
            <div class="node-card">
                <div class="node-card-header">${node.name}</div>
                <div style="color: var(--error);">Offline</div>
            </div>`;
        }

        const gpus = data.gpus || data.gpuInfo || [];
        const gpuSummary = gpus.length > 0
            ? gpus.map(g => `GPU${g.index}: ${g.temperature}°C / ${g.gpuUtilization}%`).join(' | ')
            : 'N/A';

        let lastFrameText = 'N/A';
        if (data.stats?.lastFrameTime) {
            const frameTime = new Date(data.stats.lastFrameTime);
            const diff = new Date() - frameTime;
            const hours = Math.floor(diff / 3600000);
            const minutes = Math.floor((diff % 3600000) / 60000);
            const timeAgo = hours > 0 ? `(${hours}h ${minutes}m ago)` : `(${minutes}m ago)`;
            lastFrameText = `${frameTime.toLocaleString()} <span class="time-ago">${timeAgo}</span>`;
        }

        const thermalStatus = gpus.some(g => g.isThrottling)
            ? '<span style="color: var(--warning);">Throttling</span>'
            : '<span style="color: var(--success);">Nominal</span>';

        return `
        <div class="node-card">
            <div class="node-card-header">${node.name}</div>
            <div class="node-card-grid">
                <div class="node-card-item">
                    <div class="label">RNDR Client</div>
                    ${data.rndrStatus ? '<span style="color: var(--success);">Running</span>' : '<span style="color: var(--error);">Stopped</span>'}
                </div>
                <div class="node-card-item">
                    <div class="label">Watchdog</div>
                    ${data.watchdogStatus ? '<span style="color: var(--success);">Running</span>' : '<span style="color: var(--error);">Stopped</span>'}
                </div>
                <div class="node-card-item">
                    <div class="label">Thermal Status</div>
                    ${thermalStatus}
                </div>
                <div class="node-card-item">
                    <div class="label">Last Frame</div>
                    ${lastFrameText}
                </div>
            </div>
            <div class="node-card-gpus">
                <div class="label">GPUs (Temp / Util)</div>
                ${gpuSummary}
            </div>
        </div>`;
    }).join('');
}

function formatSeconds(seconds) {
    if (seconds === undefined || seconds === null || isNaN(seconds)) { return ''; }
    if (seconds === 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    let str = '';
    if (h > 0) str += `${h}h `;
    if (m > 0) str += `${m}m `;
    if (s > 0 && h === 0) str += `${s}s`;
    return str.trim();
}

function updateChart(stats) {
    const canvas = document.getElementById('framesChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!stats || !stats.epochFrames) return;

    const epochSuccess = stats.epochFrames.successfulTimestamps || [];
    const epochFailed = stats.epochFrames.failedTimestamps || [];
    const allFrames = [
        ...epochSuccess.map(item => ({ ...item, type: 'success' })),
        ...epochFailed.map(item => ({ ...item, type: 'failed' }))
    ].sort((a, b) => a.timestampUtc - b.timestampUtc);
    const chartData = allFrames.map((item, index) => ({
        x: index,
        y: item.time || 0,
        time: item.time,
        hash: item.hash,
        timestamp: item.timestampUtc,
        type: item.type,
        backgroundColor: item.type === 'success' ? 'rgba(0,255,136,0.6)' : 'rgba(255,51,102,0.6)',
        borderColor: item.type === 'success' ? 'rgba(0,255,136,1)' : 'rgba(255,51,102,1)'
    }));

    if (framesChart) {
        framesChart.data.datasets[0].data = chartData;
        framesChart.update('none');
        return;
    }

    const bodyStyles = getComputedStyle(document.body);
    const textColor = bodyStyles.getPropertyValue('--text-secondary');
    const gridColor = bodyStyles.getPropertyValue('--border');

    framesChart = new Chart(ctx, {
        type: 'bar',
        data: {
            datasets: [{
                label: 'Frames',
                data: chartData,
                backgroundColor: function (context) {
                    return context.parsed ? context.raw.backgroundColor : 'rgba(0,255,136,0.6)';
                },
                borderColor: function (context) {
                    return context.parsed ? context.raw.borderColor : 'rgba(0,255,136,1)';
                },
                borderWidth: 1,
                barThickness: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            interaction: { mode: 'point', intersect: true },
            onClick: (event, elements) => {
                if (elements.length > 0) {
                    const elementIndex = elements[0].index;
                    const dataPoint = chartData[elementIndex];

                    if (dataPoint && dataPoint.hash) {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(dataPoint.hash).then(() => {
                                console.log('Hash copied to clipboard:', dataPoint.hash);
                                showCopyFeedback(event);
                            }).catch(err => {
                                console.error('Failed to copy hash:', err);
                                fallbackCopyToClipboard(dataPoint.hash);
                            });
                        } else {
                            fallbackCopyToClipboard(dataPoint.hash);
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    title: {
                        display: true,
                        text: 'Current Epoch Frames',
                        color: textColor
                    },
                    ticks: {
                        color: textColor,
                        callback: function (value) {
                            if (value % 10 === 0) return Math.floor(value);
                            return '';
                        }
                    },
                    grid: { color: gridColor }
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Render Time (s)',
                        color: textColor
                    },
                    ticks: { color: textColor },
                    grid: { color: gridColor }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        title: function (tooltipItems) {
                            const item = tooltipItems[0];
                            const dataPoint = chartData[item.dataIndex];

                            if (dataPoint && dataPoint.timestamp) {
                                return new Date(dataPoint.timestamp).toLocaleString();
                            }
                            return 'Frame #' + item.dataIndex;
                        },
                        label: function (ctx) {
                            const dataPoint = chartData[ctx.dataIndex];

                            let label = dataPoint.type === 'success' ? 'Successful' : 'Failed';
                            if (dataPoint && dataPoint.time !== undefined && dataPoint.time !== null) {
                                label += `: ${formatSeconds(dataPoint.time)}`;
                            }
                            if (dataPoint && dataPoint.hash) {
                                label += ` | Hash: ${dataPoint.hash}`;
                            }
                            label += ' | Click to copy hash';
                            return label;
                        }
                    }
                },
                zoom: {
                    pan: { enabled: true, mode: 'x' },
                    zoom: {
                        wheel: { enabled: true },
                        pinch: { enabled: true },
                        mode: 'x'
                    }
                }
            }
        }
    });
}

function showCopyFeedback(event) {
    const feedback = document.createElement('div');
    feedback.textContent = 'Hash copied!';
    feedback.style.cssText = `
        position: fixed;
        background: var(--accent);
        color: #000;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        z-index: 10000;
        pointer-events: none;
        left: ${event.clientX}px;
        top: ${event.clientY - 30}px;
        animation: fadeInOut 1.5s ease-out forwards;
    `;

    if (!document.querySelector('#copyFeedbackStyle')) {
        const style = document.createElement('style');
        style.id = 'copyFeedbackStyle';
        style.textContent = `
            @keyframes fadeInOut {
                0% { opacity: 0; transform: translateY(10px); }
                20% { opacity: 1; transform: translateY(0); }
                80% { opacity: 1; transform: translateY(0); }
                100% { opacity: 0; transform: translateY(-10px); }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(feedback);
    setTimeout(() => feedback.remove(), 1500);
}

function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        document.execCommand('copy');
        console.log('Hash copied to clipboard (fallback):', text);
        showCopyFeedback({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 });
    } catch (err) {
        console.error('Fallback copy failed:', err);
    }

    document.body.removeChild(textArea);
}

function resetEpochZoom() {
    if (!framesChart) return;
    framesChart.destroy();
    framesChart = null;
    const currentNode = allNodes.find(n => n.name === selectedNodeName);
    if (currentNode && currentNode.data && currentNode.data.stats) {
        updateChart(currentNode.data.stats);
    }
}

function displayNodeData(nodeName, data) {
    const titleEl = document.getElementById('nodeTitle');
    if (titleEl) titleEl.textContent = nodeName;
    if (!data) {
        updateStatsDisplay(null);
        displayGPUs([]);
        displayLogEntries([]);
        return;
    }
    updateStatsDisplay(data.stats);
    updateProcessStatusDisplay({ rndr: data.rndrStatus, watchdog: data.watchdogStatus });
    const gpus = data.gpus || data.gpuInfo;
    updateThermalStatus(gpus);
    displayGPUs(gpus);
    const logs = data.logEntries || (data.recentLogs ? data.recentLogs.map(l => ({ text: l, className: getLogEntryClass(l) })) : []);
    displayLogEntries(logs);
    if (data.stats) updateChart(data.stats);
}

document.addEventListener('DOMContentLoaded', () => {
    selectNode('home');
});