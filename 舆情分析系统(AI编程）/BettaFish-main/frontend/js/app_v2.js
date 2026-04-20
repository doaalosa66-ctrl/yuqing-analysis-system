// ==========================================
// 战役 4：获取真实历史记录（摒弃 localStorage）
// ==========================================
async function openHistoryPanel() {
    document.getElementById('historyDrawer').style.display = 'flex';
    document.getElementById('historyDrawerOverlay').style.display = 'block';
    const historyBody = document.getElementById('historyDrawerBody');
    historyBody.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">📡 正在扫描云端档案...</div>';

    try {
        const response = await fetch('/api/report/history');
        const data = await response.json();

        if (data.success && data.history && data.history.length > 0) {
            historyBody.innerHTML = '';
            data.history.forEach(item => {
                const div = document.createElement('div');
                div.className = 'history-card';
                div.innerHTML = `
                    <div class="history-card-title">${item.title}</div>
                    <div class="history-card-meta">
                        <span class="history-card-badge done">已完成</span>
                        <span>${item.time}</span>
                    </div>
                `;
                div.addEventListener('click', () => {
                    closeHistoryDrawer();
                    openReportById(item.id);
                });
                historyBody.appendChild(div);
            });
        } else {
            historyBody.innerHTML = '<div class="history-empty">暂无历史报告<br><span style="font-size:11px;opacity:0.6;">完成一次分析后，报告将自动存档于此</span></div>';
        }
    } catch (error) {
        console.error('[历史记录] 获取失败:', error);
        historyBody.innerHTML = '<div style="text-align:center; padding: 20px; color:#ff5555;">❌ 获取历史记录失败，请检查后端运行状态</div>';
    }
}

function closeHistoryDrawer() {
    document.getElementById('historyDrawer').style.display = 'none';
    document.getElementById('historyDrawerOverlay').style.display = 'none';
}