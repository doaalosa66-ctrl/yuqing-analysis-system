window.API = {
    BASE_URL: '',

    // --- 配置与系统管理 ---
    getConfig: async function() {
        const resp = await fetch(`${this.BASE_URL}/api/config`);
        return await resp.json();
    },
    updateConfig: async function(updates) {
        const resp = await fetch(`${this.BASE_URL}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        return await resp.json();
    },
    getSystemStatus: async function() {
        const resp = await fetch(`${this.BASE_URL}/api/system/status`);
        return await resp.json();
    },
    startSystem: async function() {
        const resp = await fetch(`${this.BASE_URL}/api/system/start`, { method: 'POST' });
        return await resp.json();
    },

    // --- 搜索与轮询 ---
    startSearch: async function(query) {
        const resp = await fetch(`${this.BASE_URL}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query })
        });
        return await resp.json();
    },
    getTaskStatus: async function(taskId) {
        const resp = await fetch(`${this.BASE_URL}/api/search/status/${taskId}`);
        return await resp.json();
    },

    // --- 报告获取 ---
    getReport: async function(taskId) {
        const resp = await fetch(`${this.BASE_URL}/api/report/result/${taskId}`);
        return await resp.text();
    }
};

console.log('[System] 网络通讯层 (API.js) 加载完毕。');
