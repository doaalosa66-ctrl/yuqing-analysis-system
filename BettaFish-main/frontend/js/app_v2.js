/**
 * OmniSight - 终极纯净版业务主逻辑 (app_v2.js)
 */
let pollingInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    console.log('[App_V2] 页面加载，正在从后端同步配置...');
    refreshSystemStatus();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') performSearch();
        });
    }
});

async function refreshSystemStatus() {
    const statusArea = document.getElementById('systemStatusArea');
    if(statusArea) statusArea.innerHTML = '正在与后端同步配置与状态...';
    try {
        const configResp = await window.API.getConfig();
        if (configResp.success && configResp.config) {
            const cfg = configResp.config;
            document.getElementById('deepseekApiKey').value = cfg.INSIGHT_ENGINE_API_KEY || '';
            document.getElementById('deepseekBaseUrl').value = cfg.INSIGHT_ENGINE_BASE_URL || '';
            document.getElementById('deepseekModel').value = cfg.INSIGHT_ENGINE_MODEL_NAME || '';
        }
        const statusResp = await window.API.getSystemStatus();
        if (statusResp.started) {
            if(statusArea) statusArea.innerHTML = '<span style="color:#4caf50;">✅ 系统所有组件已在后台平稳运行。</span>';
        } else {
            if(statusArea) statusArea.innerHTML = '<span style="color:#ff9800;">⚠️ 系统当前未启动，请核对配置后点击"一键启动"。</span>';
        }
    } catch (e) {
        if(statusArea) statusArea.innerHTML = '<span style="color:#f44336;">❌ 无法连接到后端。</span>';
    }
}

async function saveDashboardConfig() {
    const apiKey = document.getElementById('deepseekApiKey').value.trim();
    const baseUrl = document.getElementById('deepseekBaseUrl').value.trim();
    const modelName = document.getElementById('deepseekModel').value.trim();
    if (!apiKey) { alert('API Key 不能为空！'); return; }
    const updates = {
        INSIGHT_ENGINE_API_KEY: apiKey, INSIGHT_ENGINE_BASE_URL: baseUrl, INSIGHT_ENGINE_MODEL_NAME: modelName,
        MEDIA_ENGINE_API_KEY: apiKey, MEDIA_ENGINE_BASE_URL: baseUrl, MEDIA_ENGINE_MODEL_NAME: modelName,
        QUERY_ENGINE_API_KEY: apiKey, QUERY_ENGINE_BASE_URL: baseUrl, QUERY_ENGINE_MODEL_NAME: modelName,
        REPORT_ENGINE_API_KEY: apiKey, REPORT_ENGINE_BASE_URL: baseUrl, REPORT_ENGINE_MODEL_NAME: modelName,
        FORUM_HOST_API_KEY: apiKey, FORUM_HOST_BASE_URL: baseUrl, FORUM_HOST_MODEL_NAME: modelName
    };
    try {
        const resp = await window.API.updateConfig(updates);
        if (resp.success) alert('配置已成功写入本地 .env 文件！');
        else alert('保存失败：' + resp.message);
    } catch (e) { alert('网络错误，配置保存失败。'); }
}

async function launchSystem() {
    const statusArea = document.getElementById('systemStatusArea');
    statusArea.innerHTML = '正在发送点火指令...';
    try {
        const resp = await window.API.startSystem();
        if (resp.success) {
            statusArea.innerHTML = '<span style="color:#ffeb3b;">⏳ 点火成功！后台正在初始化，请耐心等待...</span>';
            const checkInterval = setInterval(async () => {
                const statusResp = await window.API.getSystemStatus();
                if (statusResp.started) {
                    clearInterval(checkInterval);
                    statusArea.innerHTML = '<span style="color:#4caf50;">✅ 系统初始化完毕！正在进入搜索中心...</span>';
                    setTimeout(() => window.AppViewController.switchView('HOME'), 1000);
                }
            }, 1000);
        } else {
            statusArea.innerHTML = `<span style="color:#f44336;">❌ 启动失败: ${resp.message}</span>`;
        }
    } catch (e) { statusArea.innerHTML = '<span style="color:#f44336;">❌ 请求异常。</span>'; }
}

async function performSearch() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput ? searchInput.value.trim() : '';
    if (!query) return;
    const searchBtn = document.getElementById('searchButton');
    if (searchBtn) searchBtn.disabled = true;
    try {
        const result = await window.API.startSearch(query);
        if (result && result.success) {
            window.AppViewController.switchView('FORUM');
            startProgressPolling(result.task_id);
        } else {
            alert('搜索启动失败：' + (result.message || '未知错误'));
        }
    } catch (error) {
        alert('网络请求失败，请确保后端服务运行。');
    } finally {
        if (searchBtn) searchBtn.disabled = false;
    }
}

function startProgressPolling(taskId) {
    if (pollingInterval) clearInterval(pollingInterval);
    const pBar = document.getElementById('aiProgressBar');
    const pText = document.getElementById('aiProgressText');
    let fakeProgress = 5;
    if (pBar) pBar.style.width = '5%';
    if (pText) pText.innerText = '任务已提交，系统正在调度...';

    pollingInterval = setInterval(async () => {
        try {
            const statusData = await window.API.getTaskStatus(taskId);
            if (pText && statusData.stage) pText.innerText = statusData.stage;
            if (fakeProgress < 90) {
                fakeProgress += (90 - fakeProgress) * 0.15;
                if (pBar) pBar.style.width = fakeProgress + '%';
            }
            if (statusData.status === 'done' || statusData.status === 'completed') {
                clearInterval(pollingInterval);
                if (pBar) pBar.style.width = '100%';
                if (pText) pText.innerText = '分析完成！正在渲染报告...';
                setTimeout(() => viewReport(taskId), 800);
            } else if (statusData.status === 'error' || statusData.status === 'failed') {
                clearInterval(pollingInterval);
                if (pBar) pBar.style.background = '#f44336';
                if (pText) pText.innerText = '任务失败: ' + (statusData.error || '未知错误');
            }
        } catch (error) { console.warn('轮询网络抖动:', error); }
    }, 2000);
}

async function viewReport(taskId) {
    if (!taskId) return;
    const container = document.getElementById('reportContainer');
    if (container) container.innerHTML = '<div style="color:white;text-align:center;">正在加载报告数据...</div>';
    window.AppViewController.switchView('REPORT');
    try {
        const htmlContent = await window.API.getReport(taskId);
        if (container) container.innerHTML = htmlContent;
    } catch (error) {
        if (container) container.innerHTML = `<div style="color:red;text-align:center;">加载失败: ${error.message}</div>`;
    }
}

// ==========================================
// 战役 3：下载报告核心逻辑
// ==========================================
function downloadReport() {
    const container = document.getElementById('reportContainer');

    // 1. 拦截空报告或未完成的报告
    if (!container || !container.innerHTML.trim() || container.innerHTML.includes('正在加载')) {
        alert('报告未就绪，请等待 AI 渲染完成！');
        return;
    }

    // 2. 提取并包装纯净的 HTML，自带排版样式，确保下载后依然美观
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="utf-8">
        <title>OmniSight 深度分析报告</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.6; padding: 40px; max-width: 900px; margin: 0 auto;
                color: #333; background: #fff;
            }
            h1, h2, h3 { color: #1a1a2e; border-bottom: 1px solid #eee; padding-bottom: 10px; }
            p { margin: 15px 0; }
            img { max-width: 100%; border-radius: 8px; }
        </style>
    </head>
    <body>
        ${container.innerHTML}
    </body>
    </html>
    `;

    // 3. 触发浏览器原生下载，自动按时间戳命名
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // 生成形如 OmniSight_Report_20260419_1530.html 的文件名
    const timeStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    a.download = `OmniSight_Report_${timeStr}.html`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function openHistoryPanel() {
    const historyView = document.getElementById('historyView');
    const historyList = document.getElementById('historyList');
    if(!historyView || !historyList) return;
    historyView.style.display = 'flex';
    historyList.innerHTML = '<div style="color:#aaa;text-align:center;">正在加载历史记录...</div>';
    try {
        const resp = await fetch(`${window.API.BASE_URL}/api/report/history`);
        const data = await resp.json();
        if (data.success && data.history.length > 0) {
            historyList.innerHTML = '';
            data.history.forEach(item => {
                const div = document.createElement('div');
                div.style.cssText = 'background:#2a2a4a;padding:15px;border-radius:8px;display:flex;justify-content:space-between;margin-bottom:10px;';
                div.innerHTML = `<div><div style="color:#66fcf1;">${item.title}</div><div style="font-size:0.8rem;color:#aaa;">${item.time}</div></div><button onclick="viewReport('${item.id}'); document.getElementById('historyView').style.display='none';">查看</button>`;
                historyList.appendChild(div);
            });
        } else { historyList.innerHTML = '<div style="color:#aaa;text-align:center;">暂无历史报告</div>'; }
    } catch (e) { historyList.innerHTML = '<div style="color:red;text-align:center;">加载失败</div>'; }
}