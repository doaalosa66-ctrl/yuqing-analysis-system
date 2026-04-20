// 全局变量
let socket;
let currentApp = 'insight';
let appStatus = {
    insight: 'stopped',
    media: 'stopped',
    query: 'stopped',
    forum: 'stopped',  // 前端启动后再标记为 running
    report: 'stopped'  // Report Engine
};
let customTemplate = ''; // 存储用户上传的自定义模板内容
let configValues = {};
let configDirty = false;
let configAutoRefreshTimer = null;
let systemStarted = false;
let systemStarting = false;
let configModalLocked = false;
let socketConnected = false;
let reportStreamConnected = false;
let backendReachable = false;
const consoleLayerApps = ['insight', 'media', 'query', 'forum', 'report'];
const consoleLayers = {};
let activeConsoleLayer = currentApp;
const logRenderers = {};
const FORUM_SCROLL_REATTACH_DELAY = 3000;
const FORUM_SCROLL_BOTTOM_THRESHOLD = 60;
let forumMessagesCache = [];
let forumAutoScrollEnabled = true;
let forumScrollRestTimer = null;
let forumScrollHandlerAttached = false;
let _currentSearchTaskId = null;
let _currentSearchQuery = null;
window._taskInfoMap = {};
window._pendingCancelTasks = [];

// 页面可见性状态管理
let isPageVisible = !document.hidden;
let allTimers = {
    updateTime: null,
    checkStatus: null,
    refreshConsole: null,
    refreshForum: null,
    reportLockCheck: null,
    connectionProbe: null
};

// 页面可见性变化处理
function handleVisibilityChange() {
    isPageVisible = !document.hidden;

    if (isPageVisible) {
        console.log('页面可见，恢复定时器');
        startAllTimers();
        // 【FIX Bug #7】页面重新可见时，立即刷新数据以补齐丢失的日志
        setTimeout(() => {
            refreshConsoleOutput();
            if (currentApp === 'forum') {
                refreshForumLog();
            }
            if (currentApp === 'report') {
                // 使用新的日志管理器刷新
                if (reportLogManager && reportLogManager.isRunning) {
                    reportLogManager.refresh();
                }
            }
        }, 100);
    } else {
        console.log('页面隐藏，暂停定时器以节省资源');
        pauseAllTimers();
    }
}

// 启动所有定时器
function startAllTimers() {
    // 清理旧定时器
    stopAllTimers();

    // 时间更新定时器 - 只在页面可见时更新
    if (isPageVisible) {
        allTimers.updateTime = setInterval(updateTime, 1000);
    }

    // 状态检查定时器 - 优化频率
    allTimers.checkStatus = setInterval(checkStatus, 10000);

    // 【优化】控制台刷新定时器 - 提升至2秒快速响应
    allTimers.refreshConsole = setInterval(() => {
        if (appStatus[currentApp] === 'running' || appStatus[currentApp] === 'starting') {
            refreshConsoleOutput();
        }
    }, 2000);  // 2秒刷新，快速响应

    // 【优化】Forum刷新定时器 - 提升至2秒
    allTimers.refreshForum = setInterval(() => {
        if (currentApp === 'forum' || appStatus.forum === 'running') {
            refreshForumMessages();
        }
    }, 2000);

    // 报告锁定检查定时器
    allTimers.reportLockCheck = setInterval(checkReportLockStatus, 15000);
}

// 暂停所有定时器
function pauseAllTimers() {
    // 只保留关键的连接检查定时器，其他全部暂停
    Object.keys(allTimers).forEach(key => {
        if (key !== 'connectionProbe' && allTimers[key]) {
            clearInterval(allTimers[key]);
            allTimers[key] = null;
        }
    });
}

// 停止所有定时器
function stopAllTimers() {
    Object.keys(allTimers).forEach(key => {
        if (allTimers[key]) {
            clearInterval(allTimers[key]);
            allTimers[key] = null;
        }
    });
}

// 页面卸载时清理资源
function cleanupOnUnload() {
    console.log('页面卸载，清理所有资源');

    // 停止所有定时器
    stopAllTimers();

    // 清理所有日志渲染器
    Object.values(logRenderers).forEach(renderer => {
        if (renderer && typeof renderer.dispose === 'function') {
            renderer.dispose();
        }
    });

    // 关闭Socket连接
    if (socket) {
        socket.close();
    }

    // 关闭SSE连接
    safeCloseReportStream();

    // 清理全局变量
    Object.keys(consoleLayers).forEach(key => {
        delete consoleLayers[key];
    });
    Object.keys(logRenderers).forEach(key => {
        delete logRenderers[key];
    });
}

// 简化日志渲染器：实时逐行追加，不做虚拟截断
class LogVirtualList {
    constructor(container) {
        this.container = container;
        this.lines = [];
        this.isActive = false;
        this.autoScrollEnabled = true;
        this.needsScroll = false;
        this.resumeDelay = 3000;
        this.resumeTimer = null;
        this.renderScheduled = false;
        this.lastRenderTime = 0;
        this.lastRenderLineCount = 0;
        this.pendingHighWaterMark = 0;
        this.flushCount = 0;
        this.lastRenderHash = null;
        this.renderPending = false;
        this.maxLines = Number.MAX_SAFE_INTEGER;
        this.trimTarget = Number.MAX_SAFE_INTEGER;
        this.scrollHandler = this.handleScroll.bind(this);
        if (this.container) {
            this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
        }
    }

    dispose() {
        if (this.container && this.scrollHandler) {
            this.container.removeEventListener('scroll', this.scrollHandler);
        }
        this.clearResumeTimer();
        this.container = null;
        this.lines = [];
    }

    clearResumeTimer() {
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
    }

    handleScroll() {
        if (!this.container) return;
        const distanceFromBottom = this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop;
        const atBottom = distanceFromBottom <= 8;
        if (atBottom) {
            this.autoScrollEnabled = true;
            this.needsScroll = true;
            this.clearResumeTimer();
            return;
        }

        this.autoScrollEnabled = false;
        this.clearResumeTimer();
        this.resumeTimer = setTimeout(() => {
            this.autoScrollEnabled = true;
            this.needsScroll = true;
            this.scrollToLatest(true);
        }, this.resumeDelay);
    }

    isNearBottom() {
        if (!this.container) return true;
        const distanceFromBottom = this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop;
        return distanceFromBottom <= 8;
    }

    scrollToLatest(force = false) {
        if (!this.container) return;
        if (!force && !this.autoScrollEnabled) return;

        if (this.container.scrollHeight <= this.container.clientHeight) {
            this.container.scrollTop = 0;
            this.needsScroll = false;
            return;
        }

        const target = this.container.scrollHeight - this.container.clientHeight;
        this.container.scrollTop = target;
        // 双保险：下一帧再吸附一次，避免渲染时机导致未到达底部
        requestAnimationFrame(() => {
            if (this.container) {
                this.container.scrollTop = this.container.scrollHeight - this.container.clientHeight;
            }
            this.needsScroll = false;
        });
    }

    forceScrollToLatest() {
        // 三次确认（当前帧、下一帧、50ms后），降低偶发现象
        this.scrollToLatest(true);
        requestAnimationFrame(() => this.scrollToLatest(true));
        setTimeout(() => this.scrollToLatest(true), 50);
    }

    scrollToBottom() {
        this.scrollToLatest(true);
    }

    append(text, className = 'console-line') {
        if (!this.container || text === undefined || text === null) return;
        const normalized = typeof text === 'string' ? text : String(text);
        const stickToLatest = this.autoScrollEnabled || this.isNearBottom();

        this.lines.push({ text: normalized, className: className || 'console-line' });
        const node = document.createElement('div');
        node.className = className || 'console-line';
        node.textContent = normalized;
        this.container.appendChild(node);

        this.pendingHighWaterMark = Math.max(this.pendingHighWaterMark, this.lines.length);
        this.lastRenderLineCount = this.lines.length;
        this.lastRenderTime = performance.now();

        if (stickToLatest) {
            this.needsScroll = true;
            // 推迟到下一帧，确保布局完成
            requestAnimationFrame(() => this.forceScrollToLatest());
        }
    }

    appendBatch(items) {
        if (!this.container || !Array.isArray(items) || items.length === 0) return;
        const fragment = document.createDocumentFragment();
        let appended = 0;
        items.forEach(item => {
            if (item === undefined || item === null) return;
            const text = typeof item === 'string' ? item : item.text;
            if (text === undefined || text === null) return;
            const className = typeof item === 'string' ? 'console-line' : (item.className || 'console-line');
            this.lines.push({ text, className });
            const node = document.createElement('div');
            node.className = className;
            node.textContent = String(text);
            fragment.appendChild(node);
            appended += 1;
        });
        if (appended > 0) {
            this.container.appendChild(fragment);
            this.pendingHighWaterMark = Math.max(this.pendingHighWaterMark, this.lines.length);
            this.lastRenderLineCount = this.lines.length;
            this.lastRenderTime = performance.now();
            if (this.autoScrollEnabled) {
                this.scrollToLatest(true);
            }
        }
    }

    clear(message = null) {
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.lines = [];
        if (message) {
            this.append(message, 'console-line');
        } else {
            this.needsScroll = true;
        }
    }

    render() {
        if (!this.container) return;
        const fragment = document.createDocumentFragment();
        this.lines.forEach(line => {
            const node = document.createElement('div');
            node.className = line.className || 'console-line';
            node.textContent = line.text;
            fragment.appendChild(node);
        });
        this.container.replaceChildren(fragment);
        this.lastRenderLineCount = this.lines.length;
        this.lastRenderTime = performance.now();
        if (this.autoScrollEnabled || this.isNearBottom()) {
            this.scrollToLatest(true);
        }
    }

    scheduleRender(force = false) {
        if (force) {
            this.render();
            return;
        }
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.render();
        });
    }

    setActive(active) {
        this.isActive = !!active;
        if (active) {
            this.autoScrollEnabled = true;
            // 立即多次吸附，避免切换时机导致停在中间
            this.forceScrollToLatest();
        }
    }

    maybeTrim() {
        // 保留所有日志，满足“完整展示”需求
        return;
    }

    getPerformanceStats() {
        const memoryBytes = this.lines.length * 100;
        const memoryEstimate = memoryBytes < 1024
            ? `${memoryBytes} B`
            : `${(memoryBytes / 1024).toFixed(2)} KB`;
        return {
            totalLines: this.lines.length,
            pendingLines: 0,
            pendingHighWaterMark: Math.max(this.pendingHighWaterMark, this.lines.length),
            flushCount: this.flushCount,
            lastRenderTime: `${this.lastRenderTime ? this.lastRenderTime.toFixed(2) : 0}ms`,
            lastRenderLineCount: this.lastRenderLineCount,
            poolSize: this.lines.length,
            memoryEstimate
        };
    }

    resetPerformanceStats() {
        this.flushCount = 0;
        this.pendingHighWaterMark = this.lines.length;
        this.lastRenderTime = 0;
        this.lastRenderLineCount = this.lines.length;
    }

    setLineHeight() {
        // 兼容旧接口，现为无操作
    }
}

let pageRefreshInProgress = false;
let shutdownInProgress = false;

const CONFIG_ENDPOINT = '/api/config';
const SYSTEM_STATUS_ENDPOINT = '/api/system/status';
const SYSTEM_START_ENDPOINT = '/api/system/start';
const SYSTEM_SHUTDOWN_ENDPOINT = '/api/system/shutdown';
const START_BUTTON_DEFAULT_TEXT = '保存并启动系统';
const APP_PORTS = {
    insight: 8501,
    media: 8502,
    query: 8503
};

const configFieldGroups = [
    {
        tab: 'ops',
        title: '数据库连接',
        subtitle: '用于连接社媒数据库的基本配置，注意数据库默认为空，需要单独部署MindSpider爬取数据',
        purpose: '存储从微博、小红书、抖音等平台爬取的舆情数据。洞察引擎的数据来源，没有数据库则无数据可分析。',
        recommend: '本地部署推荐 PostgreSQL，主机填 127.0.0.1，端口 5432。需单独部署 MindSpider 爬虫将数据写入数据库。',
        fields: [
            { key: 'DB_DIALECT', label: '数据库类型', type: 'select', options: ['mysql', 'postgresql'] },
            { key: 'DB_HOST', label: '主机地址' },
            { key: 'DB_PORT', label: '端口' },
            { key: 'DB_USER', label: '用户名' },
            { key: 'DB_PASSWORD', label: '密码', type: 'password' },
            { key: 'DB_NAME', label: '数据库名称' },
            { key: 'DB_CHARSET', label: '字符集' }
        ]
    },
    {
        tab: 'user',
        title: '洞察引擎',
        subtitle: 'OpenAi接入格式，推荐LLM：kimi-k2',
        purpose: '查询私有舆情数据库，执行情感分析、热点挖掘与话题聚类，是系统最核心的分析大脑。',
        recommend: '推荐 kimi-k2-0711-preview（月之暗面官方）。超长上下文 128K，中文理解强，价格合理。申请：platform.moonshot.cn',
        fields: [
            { key: 'INSIGHT_ENGINE_MODEL_NAME', label: '模型名称', type: 'datalist', options: ['kimi-k2-0711-preview', 'kimi-k1.5-long', 'moonshot-v1-128k'] },
            { key: 'INSIGHT_ENGINE_API_KEY', label: 'API Key', type: 'password' },
            { key: 'INSIGHT_ENGINE_BASE_URL', label: 'Base URL', advanced: true }
        ]
    },
    {
        tab: 'user',
        title: '媒体引擎',
        subtitle: 'OpenAi接入格式，推荐LLM：gemini-2.5-pro',
        purpose: '搜索互联网公开媒体报道，擅长图文多模态内容分析，补充私有数据库没有的信息。',
        recommend: '推荐 gemini-2.5-pro（通过 aihubmix 中转）。原生多模态能力最强，上下文超大（1M tokens）。申请：aihubmix.com',
        fields: [
            { key: 'MEDIA_ENGINE_MODEL_NAME', label: '模型名称', type: 'datalist', options: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro'] },
            { key: 'MEDIA_ENGINE_API_KEY', label: 'API Key', type: 'password' },
            { key: 'MEDIA_ENGINE_BASE_URL', label: 'Base URL', advanced: true }
        ]
    },
    {
        tab: 'user',
        title: '搜索引擎',
        subtitle: 'OpenAi接入格式，推荐LLM：deepseek-chat',
        purpose: '通过 Tavily 实时搜索互联网新闻，弥补数据库数据的时效性不足，获取最新动态。',
        recommend: '推荐 deepseek-chat（DeepSeek 官方）。价格极低，推理能力强，适合高频调用。申请：platform.deepseek.com',
        fields: [
            { key: 'QUERY_ENGINE_MODEL_NAME', label: '模型名称', type: 'datalist', options: ['deepseek-chat', 'deepseek-reasoner'] },
            { key: 'QUERY_ENGINE_API_KEY', label: 'API Key', type: 'password' },
            { key: 'QUERY_ENGINE_BASE_URL', label: 'Base URL', advanced: true }
        ]
    },
    {
        tab: 'user',
        title: '报告引擎',
        subtitle: 'OpenAi接入格式，推荐LLM：gemini-2.5-pro',
        purpose: '整合三个分析引擎的输出，生成结构化 HTML/PDF 舆情报告，是最终报告的排版编辑。',
        recommend: '推荐 gemini-2.5-pro（可与媒体引擎共用同一 API Key）。注意：模型能力不足会导致图表空白或段落异常。',
        fields: [
            { key: 'REPORT_ENGINE_MODEL_NAME', label: '模型名称', type: 'datalist', options: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro'] },
            { key: 'REPORT_ENGINE_API_KEY', label: 'API Key', type: 'password' },
            { key: 'REPORT_ENGINE_BASE_URL', label: 'Base URL', advanced: true }
        ]
    },
    {
        tab: 'user',
        title: '论坛主持人',
        subtitle: 'OpenAi接入格式，推荐LLM：qwen-plus',
        purpose: '综合 Insight/Media/Query 三个 Agent 的发言，梳理事件脉络、整合观点、引导讨论方向，让多 Agent 分析产生化学反应。',
        recommend: '推荐 qwen-plus（阿里云百炼）或 Qwen3 系列。调用频率低但需较强综合推理能力。申请：aliyun.com/product/bailian',
        fields: [
            { key: 'FORUM_HOST_MODEL_NAME', label: '模型名称', type: 'datalist', options: ['qwen-plus', 'qwen-max', 'qwen3-235b-a22b'] },
            { key: 'FORUM_HOST_API_KEY', label: 'API Key', type: 'password' },
            { key: 'FORUM_HOST_BASE_URL', label: 'Base URL', advanced: true }
        ]
    },
    {
        tab: 'user',
        title: '关键词优化器',
        subtitle: 'OpenAi接入格式，推荐LLM：qwen-plus',
        purpose: '把 AI 生成的专业搜索词（如"舆情传播趋势"）转化为网民真实使用的词汇（如"武大"），提升数据库查询命中率。',
        recommend: '推荐 qwen-plus（可与论坛主持人共用同一 API Key）。任务简单，轻量模型即可，无需强模型。',
        fields: [
            { key: 'KEYWORD_OPTIMIZER_MODEL_NAME', label: '模型名称', type: 'datalist', options: ['qwen-plus', 'qwen-turbo', 'qwen3-8b'] },
            { key: 'KEYWORD_OPTIMIZER_API_KEY', label: 'API Key', type: 'password' },
            { key: 'KEYWORD_OPTIMIZER_BASE_URL', label: 'Base URL', advanced: true }
        ]
    },
    {
        tab: 'ops',
        title: '外部检索工具',
        subtitle: '联动搜索引擎、网站抓取等在线服务，两个都需配置',
        purpose: '为媒体引擎和搜索引擎提供实际的互联网抓取能力。Tavily 用于新闻搜索，Bocha/Anspire 用于多模态网页搜索。',
        recommend: '推荐 SEARCH_TOOL_TYPE 选 AnspireAPI（费用是 Bocha 的一半，效果相当）。Tavily 免费额度每月 1000 次，够日常使用。申请：tavily.com / open.anspire.cn',
        fields: [
            {
                key: 'SEARCH_TOOL_TYPE',
                label: '选择检索工具',
                type: 'select',
                options: ['BochaAPI', 'AnspireAPI']
            },
            { key: 'TAVILY_API_KEY', label: 'Tavily API Key', type: 'password' },
            { key: 'BOCHA_WEB_SEARCH_API_KEY', label: 'Bocha API Key', type: 'password', condition: { key: 'SEARCH_TOOL_TYPE', value: 'BochaAPI' } },
            { key: 'ANSPIRE_API_KEY', label: 'Anspire API Key', type: 'password', condition: { key: 'SEARCH_TOOL_TYPE', value: 'AnspireAPI' } }
        ]
    }
];

// 应用名称映射
const appNames = {
    insight: '洞察引擎',
    media: '媒体引擎',
    query: '搜索引擎',
    forum: '论坛引擎',
    report: '报告引擎'
};

// 页面头部显示的完整Agent介绍
const agentTitles = {
    insight: '洞察引擎 - 私有数据库挖掘',
    media: '媒体引擎 - 多模态内容分析',
    query: '搜索引擎 - 精准信息搜索',
    forum: '论坛引擎 - 多智能体交流',
    report: '报告引擎 - 最终报告生成'
};

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    initializeConsoleLayers();
    syncStatusBarPosition();
    initializeSocket();
    initializeEventListeners();
    ensureSystemReadyOnLoad();
    loadConsoleOutput(currentApp);
    // 后台预加载其他引擎的历史日志，避免切换时空白
    setTimeout(preloadAllConsoleOutputs, 400);

    // 使用新的定时器管理系统
    updateTime(); // 立即更新一次
    checkStatus(); // 立即检查一次
    checkReportLockStatus(); // 立即检查一次

    // 启动所有定时器
    startAllTimers();

    // 【新增】启动定期内存优化
    startMemoryOptimization();
    console.log('[性能优化] 已启动定期内存优化（每5分钟）');

    // 【新增】将性能监控函数暴露到全局，方便调试
    window.getGlobalPerformanceStats = getGlobalPerformanceStats;
    window.resetAllPerformanceStats = resetAllPerformanceStats;
    console.log('[调试工具] 性能监控函数已挂载到window对象：');
    console.log('  - window.getGlobalPerformanceStats() : 查看所有渲染器性能统计');
    console.log('  - window.resetAllPerformanceStats() : 重置所有性能计数器');

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 监听页面卸载事件
    window.addEventListener('beforeunload', cleanupOnUnload);
    window.addEventListener('unload', cleanupOnUnload);

    // 初始化密码切换功能（事件委托，只需调用一次）
    attachConfigPasswordToggles();

    // 初始化论坛相关功能
    initializeForum();

    // 连接探测定时器（保持运行）
    startConnectionProbe();

    // 窗口尺寸变化时同步状态栏位置
    window.addEventListener('resize', syncStatusBarPosition);

    // 初始化新功能
    initSearchHints();
    initHistoryDrawer();
    initSearchHistoryDropdown();
    checkEngineConfigStatus();
    // 每30秒刷新一次引擎状态
    setInterval(checkEngineConfigStatus, 30000);
});

// Socket.IO连接
function initializeSocket() {
    socket = io();

    socket.on('connect', function() {
        socketConnected = true;
        refreshConnectionStatus();
        socket.emit('request_status');
    });

    socket.on('disconnect', function() {
        socketConnected = false;
        refreshConnectionStatus();
    });

    socket.on('console_output', function(data) {
        // 处理控制台输出
        addConsoleOutput(data.line, data.app);

        // Phase 2: 同步推送到 Forum State 终端（零侵入）
        if (window.ForumState) {
            window.ForumState.push(data.line, data.app);
        }

        // 如果是forum的输出，同时也处理为论坛消息
        if (data.app === 'forum') {
            const parsed = parseForumMessage(data.line);
            if (parsed) {
                // addForumMessage(parsed);
            }
        }
    });

    socket.on('forum_message', function(data) {
        // addForumMessage(data);
    });

    socket.on('status_update', function(data) {
        updateAppStatus(data);
    });

    socket.on('search_progress', function(data) {
        updateSearchProgress(data);
    });

    socket.on('search_done', function(data) {
        onSearchDone(data);
    });

    socket.on('system_start_result', function(data) {
        console.log('[Socket] 收到 system_start_result:', data);
        systemStarting = false;
        if (data.success) {
            setConfigStatus('系统启动成功', 'success');
            applySystemState({ started: true, starting: false });
            showMessage('系统启动成功', 'success');
        } else {
            setConfigStatus('系统启动失败: ' + (data.message || '未知错误'), 'error');
            applySystemState({ started: false, starting: false });
            showMessage('系统启动失败: ' + (data.message || '未知错误'), 'error');
        }
        updateStartButtonState();
    });
}

// 事件监听器
function initializeEventListeners() {
    // 搜索按钮
    document.getElementById('searchButton').addEventListener('click', performSearch);
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    });

    // 文件上传
    document.getElementById('templateFileInput').addEventListener('change', handleTemplateUpload);

    // 应用切换按钮
    document.querySelectorAll('.app-button').forEach(button => {
        button.addEventListener('click', function() {
            const app = this.dataset.app;
            switchToApp(app);
        });
    });

    // LLM 配置弹窗
    const openConfigButton = document.getElementById('openConfigButton');
    if (openConfigButton) {
        openConfigButton.addEventListener('click', () => openConfigModal({ lock: !systemStarted }));
    }

    const closeConfigButton = document.getElementById('closeConfigModal');
    if (closeConfigButton) {
        closeConfigButton.addEventListener('click', () => closeConfigModal());
    }

    const refreshConfigButton = document.getElementById('refreshConfigButton');
    if (refreshConfigButton) {
        refreshConfigButton.addEventListener('click', () => refreshConfigFromServer(true));
    }

    const saveConfigButton = document.getElementById('saveConfigButton');
    if (saveConfigButton) {
        saveConfigButton.addEventListener('click', () => saveConfigUpdates());
    }

    const startSystemButton = document.getElementById('startSystemButton');
    if (startSystemButton) {
        startSystemButton.addEventListener('click', () => startSystem());
    }

    const refreshPageButton = document.getElementById('pageRefreshButton');
    if (refreshPageButton) {
        refreshPageButton.addEventListener('click', () => handleSafeRefresh());
    }

    const shutdownButton = document.getElementById('shutdownButton');
    if (shutdownButton) {
        shutdownButton.addEventListener('click', () => handleShutdownRequest());
    }

    const cancelShutdownButton = document.getElementById('cancelShutdownButton');
    if (cancelShutdownButton) {
        cancelShutdownButton.addEventListener('click', () => hideShutdownConfirm());
    }

    const closeShutdownButton = document.getElementById('closeShutdownConfirm');
    if (closeShutdownButton) {
        closeShutdownButton.addEventListener('click', () => hideShutdownConfirm());
    }

    const confirmShutdownButton = document.getElementById('confirmShutdownButton');
    if (confirmShutdownButton) {
        confirmShutdownButton.addEventListener('click', () => {
            hideShutdownConfirm();
            shutdownSystem({ skipAgentWarning: true });
        });
    }

    const configModal = document.getElementById('configModal');
    if (configModal) {
        configModal.addEventListener('click', (event) => {
            if (event.target === configModal) {
                closeConfigModal();
            }
        });
    }

    const configFormContainer = document.getElementById('configFormContainer');
    if (configFormContainer) {
        configFormContainer.addEventListener('input', () => {
            configDirty = true;
            setConfigStatus('已修改，尚未保存');
        });
    }

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            if (isConfigModalVisible()) {
                closeConfigModal();
            }
            const shutdownModal = document.getElementById('shutdownConfirmModal');
            if (shutdownModal && shutdownModal.classList.contains('visible')) {
                hideShutdownConfirm();
            }
        }
    });
}

function isConfigModalVisible() {
    const modal = document.getElementById('configModal');
    return modal ? modal.classList.contains('visible') : false;
}

function openConfigModal(options = {}) {
    const { lock = false, message = '' } = options;
    const modal = document.getElementById('configModal');
    if (!modal) {
        return;
    }

    configModalLocked = lock;
    modal.classList.add('visible');
    configDirty = false;

    const initialMessage = message || '正在读取配置...';
    setConfigStatus(initialMessage, '');

    const messageAfterLoad = message || '';

    refreshConfigFromServer(true, messageAfterLoad);

    if (configAutoRefreshTimer) {
        clearInterval(configAutoRefreshTimer);
    }
    configAutoRefreshTimer = setInterval(() => {
        if (!configDirty) {
            refreshConfigFromServer(false, messageAfterLoad);
        }
    }, 10000);

    updateStartButtonState();
    updateConfigCloseButton();
}

function closeConfigModal(force = false) {
    const modal = document.getElementById('configModal');
    if (modal) {
        modal.classList.remove('visible');
    }
    if (configAutoRefreshTimer) {
        clearInterval(configAutoRefreshTimer);
        configAutoRefreshTimer = null;
    }
    configDirty = false;
    configModalLocked = false;
    setConfigStatus('', '');
    updateStartButtonState();
    updateConfigCloseButton();
    localStorage.setItem('bettafish_config_visited', '1');
}

function refreshConfigFromServer(showFeedback = false, messageOverride = '') {
    if (showFeedback && configDirty) {
        const proceed = window.confirm('当前修改尚未保存，确定要刷新并放弃更改吗？');
        if (!proceed) {
            return;
        }
    }
    fetch(CONFIG_ENDPOINT)
        .then(response => response.json())
        .then(data => {
            if (!data.success) {
                throw new Error(data.message || '读取配置失败');
            }
            configValues = data.config || {};
            renderConfigForm(configValues);
            configDirty = false;
            if (messageOverride) {
                setConfigStatus(messageOverride);
            } else if (showFeedback) {
                setConfigStatus('已加载最新配置');
            } else {
                setConfigStatus('已同步最新配置');
            }
        })
        .catch(error => {
            console.error(error);
            setConfigStatus(`读取配置失败: ${error.message}`, 'error');
        });
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
}

function renderConfigForm(values) {
    const container = document.getElementById('configFormContainer');
    if (!container) {
        return;
    }

    const eyeOffIcon = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>
    `;

    function buildFieldControl(field, value) {
        const safeValue = escapeHtml(String(value || ''));

        if (field.type === 'select' && field.options) {
            const optionsHtml = field.options.map(option => {
                const selected = option === value ? 'selected' : '';
                const safeOption = escapeHtml(String(option));
                return `<option value="${safeOption}" ${selected}>${safeOption}</option>`;
            }).join('');
            return `
                <select class="config-field-input" data-config-key="${field.key}" data-field-type="select">
                    ${optionsHtml}
                </select>
            `;
        }

        if (field.type === 'datalist' && field.options) {
            const listId = `dl-${field.key}`;
            const optionsHtml = field.options.map(o => `<option value="${escapeHtml(String(o))}"></option>`).join('');
            return `
                <input
                    type="text"
                    class="config-field-input"
                    data-config-key="${field.key}"
                    data-field-type="text"
                    value="${safeValue}"
                    list="${listId}"
                    placeholder="选择推荐模型或直接输入自定义模型名"
                    autocomplete="off"
                >
                <datalist id="${listId}">${optionsHtml}</datalist>
            `;
        }

        if (field.type === 'password') {
            return `
                <div class="config-password-wrapper">
                    <input
                        type="password"
                        class="config-field-input"
                        data-config-key="${field.key}"
                        data-field-type="password"
                        value="${safeValue}"
                        placeholder="填写${field.label}"
                        autocomplete="off"
                    >
                    <button type="button" class="config-password-toggle" data-target="${field.key}" title="显示/隐藏密码">
                        ${eyeOffIcon}
                    </button>
                </div>
            `;
        }

        const inputType = field.type || 'text';
        return `
            <input
                type="${inputType}"
                class="config-field-input"
                data-config-key="${field.key}"
                data-field-type="${inputType}"
                value="${safeValue}"
                placeholder="填写${field.label}"
                autocomplete="on"
            >
        `;
    }

    function buildGroupHtml(group, isUserTab) {
        // 分离普通字段和高级字段（BASE_URL）
        const normalFields = [];
        const advancedFields = [];
        group.fields.forEach(field => {
            if (isUserTab && field.advanced) {
                advancedFields.push(field);
            } else {
                normalFields.push(field);
            }
        });

        const buildFieldLabel = (field) => {
            const value = values[field.key] !== undefined ? values[field.key] : '';
            let hiddenClass = '';
            if (field.condition) {
                const currentValue = values[field.condition.key];
                hiddenClass = currentValue === field.condition.value ? '' : 'hidden';
            }
            return `
                <label class="config-field ${hiddenClass}" data-condition-key="${field.condition ? field.condition.key : ''}" data-condition-value="${field.condition ? field.condition.value : ''}">
                    <span class="config-field-label">${field.label}</span>
                    ${buildFieldControl(field, value)}
                </label>
            `;
        };

        const normalHtml = normalFields.map(buildFieldLabel).join('');

        const advancedHtml = advancedFields.length > 0 ? `
            <details class="advanced-settings">
                <summary>高级设置：自定义代理 / Base URL</summary>
                ${advancedFields.map(buildFieldLabel).join('')}
            </details>
        ` : '';

        const subtitle = group.subtitle ? `<div class="config-group-subtitle">${group.subtitle}</div>` : '';
        const helpBlock = (group.purpose || group.recommend) ? `
            <details class="config-group-help">
                <summary>查看作用与推荐配置 ▸</summary>
                <div class="config-group-help-body">
                    ${group.purpose ? `<div class="config-help-row"><span class="config-help-label">作用</span><span class="config-help-text">${group.purpose}</span></div>` : ''}
                    ${group.recommend ? `<div class="config-help-row"><span class="config-help-label">推荐配置</span><span class="config-help-text">${group.recommend}</span></div>` : ''}
                </div>
            </details>
        ` : '';

        return `
            <section class="config-group">
                <div class="config-group-title">${group.title}</div>
                ${subtitle}
                ${helpBlock}
                ${normalHtml}
                ${advancedHtml}
            </section>
        `;
    }

    const userGroups = configFieldGroups.filter(g => g.tab === 'user');
    const opsGroups  = configFieldGroups.filter(g => g.tab === 'ops');

    const userSections = userGroups.map(g => buildGroupHtml(g, true)).join('');
    const opsSections  = opsGroups.map(g => buildGroupHtml(g, false)).join('');

    // 清除旧的事件委托标记，确保重新绑定
    delete container.dataset.passwordToggleAttached;
    delete container.dataset.conditionalLogicAttached;

    container.innerHTML = `
        <div class="config-tab-bar">
            <button class="config-tab-btn active" data-tab="user">👤 业务 AI 配置（用户）</button>
            <button class="config-tab-btn" data-tab="ops">🛠️ 系统底层配置（运维）</button>
        </div>
        <div class="config-tab-panel active" data-tab-panel="user">
            <div class="config-tab-banner user">💡 提示：请为系统的各个分析环节分配 AI 大脑。大多数情况下，您只需要选择推荐模型并填入 API Key 即可。</div>
            ${userSections}
        </div>
        <div class="config-tab-panel" data-tab-panel="ops">
            <div class="config-tab-banner ops">⚠️ 运维专属：此处用于配置系统数据库与底层检索基建，修改后需重启后端服务生效，非技术人员请勿随意修改。</div>
            ${opsSections}
        </div>
    `;

    // Tab 切换逻辑
    container.querySelectorAll('.config-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            container.querySelectorAll('.config-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
            container.querySelectorAll('.config-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === target));
        });
    });

    // 重新绑定密码切换和条件逻辑（DOM 已重建）
    attachConfigPasswordToggles();
    // 为所有 select 下拉框绑定事件，监听值变化并动态显示/隐藏条件字段
    attachConfigConditionalLogic();
}

function attachConfigPasswordToggles() {
    // 定义眼睛图标的SVG
    const eyeOffIcon = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>
    `;
    const eyeOnIcon = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>
    `;

    // 使用事件委托，只在容器上绑定一次事件
    const container = document.getElementById('configFormContainer');
    if (!container) {
        return;
    }

    // 防止重复绑定
    if (container.dataset.passwordToggleAttached === 'true') {
        return;
    }

    container.addEventListener('click', (event) => {
        // 查找是否点击了密码切换按钮或其内部的SVG
        const toggle = event.target.closest('.config-password-toggle');
        if (!toggle) {
            return;
        }

        const key = toggle.dataset.target;
        const input = container.querySelector(`.config-field-input[data-config-key="${key}"]`);
        if (!input) {
            return;
        }

        const reveal = input.getAttribute('type') === 'password';
        input.setAttribute('type', reveal ? 'text' : 'password');
        toggle.innerHTML = reveal ? eyeOnIcon : eyeOffIcon;
        toggle.classList.toggle('revealed', reveal);
    });

    // 标记已绑定，防止重复
    container.dataset.passwordToggleAttached = 'true';
}

// 【新增】条件字段动态显示逻辑
function attachConfigConditionalLogic() {
    const container = document.getElementById('configFormContainer');
    if (!container) {
        return;
    }

    // 防止重复绑定
    if (container.dataset.conditionalLogicAttached === 'true') {
        return;
    }

    // 监听所有 select 下拉框的变化
    container.addEventListener('change', (event) => {
        const select = event.target.closest('select.config-field-input');
        if (!select) {
            return;
        }

        const triggerKey = select.dataset.configKey;
        const triggerValue = select.value;

        // 更新所有依赖于这个字段的条件字段的显示状态
        const conditionalFields = container.querySelectorAll('.config-field[data-condition-key]');
        conditionalFields.forEach(field => {
            const conditionKey = field.dataset.conditionKey;
            const conditionValue = field.dataset.conditionValue;

            // 检查这个条件字段是否依赖于当前改变的字段
            if (conditionKey === triggerKey) {
                if (triggerValue === conditionValue) {
                    // 显示字段
                    field.classList.remove('hidden');
                } else {
                    // 隐藏字段
                    field.classList.add('hidden');
                }
            }
        });
    });

    // 标记已绑定，防止重复
    container.dataset.conditionalLogicAttached = 'true';
}

function collectConfigUpdates() {
    const inputs = document.querySelectorAll('#configFormContainer [data-config-key]');
    const updates = {};
    inputs.forEach(input => {
        const key = input.dataset.configKey;
        if (!key) {
            return;
        }
        const fieldType = input.dataset.fieldType || 'text';
        let value = input.value;
        if (fieldType !== 'password' && typeof value === 'string') {
            value = value.trim();
        }

        if (value !== '' && /PORT$/i.test(key)) {
            const numeric = Number(value);
            if (!Number.isNaN(numeric)) {
                updates[key] = numeric;
                return;
            }
        }

        updates[key] = value;
    });
    return updates;
}

function setConfigStatus(message, type = '') {
    const status = document.getElementById('configStatusMessage');
    if (!status) {
        return;
    }
    status.textContent = message || '';
    status.classList.remove('error', 'success');
    if (type) {
        status.classList.add(type);
    }
}

async function saveConfigUpdates(options = {}) {
    const { silent = false } = options;
    const saveButton = document.getElementById('saveConfigButton');

    if (!silent && saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = '保存中...';
    }
    if (!silent) {
        setConfigStatus('正在保存配置...', '');
    }

    const updates = collectConfigUpdates();

    try {
        const response = await fetch(CONFIG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || '保存失败');
        }
        configValues = data.config || {};
        renderConfigForm(configValues);
        configDirty = false;
        if (silent) {
            setConfigStatus('配置已保存', 'success');
        } else {
            setConfigStatus('配置已保存', 'success');
            showMessage('配置已保存', 'success');
            // 更新全局配置状态
            const keyFields = ['INSIGHT_ENGINE_API_KEY','MEDIA_ENGINE_API_KEY','QUERY_ENGINE_API_KEY','REPORT_ENGINE_API_KEY'];
            window._modelConfigured = keyFields.some(k => configValues[k] && configValues[k].trim() !== '');
            // 保存成功后自动关闭配置页
            setTimeout(() => closeConfigModal(), 600);
        }
        return true;
    } catch (error) {
        console.error(error);
        setConfigStatus(`保存失败: ${error.message}`, 'error');
        if (!silent) {
            showMessage(`保存失败: ${error.message}`, 'error');
        }
        return false;
    } finally {
        if (!silent && saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = '保存';
        }
    }
}

function updateStartButtonState() {
    const startButton = document.getElementById('startSystemButton');
    const saveButton = document.getElementById('saveConfigButton');
    if (!startButton) return;

    if (systemStarted) {
        // 系统已启动：只显示【保存】
        startButton.style.display = 'none';
        if (saveButton) {
            saveButton.style.display = 'inline-block';
            saveButton.disabled = false;
            saveButton.textContent = '保存';
        }
    } else {
        // 系统未启动：只显示【保存并启动系统】
        startButton.style.display = 'inline-block';
        startButton.disabled = systemStarting;
        startButton.textContent = systemStarting ? '启动中...' : START_BUTTON_DEFAULT_TEXT;
        if (saveButton) saveButton.style.display = 'none';
    }
}

function updateConfigCloseButton() {
    const closeButton = document.getElementById('closeConfigModal');
    if (!closeButton) return;
    // 返回按钮始终可用
    closeButton.removeAttribute('disabled');
}

function applySystemState(state) {
    if (!state) {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'started')) {
        systemStarted = !!state.started;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'starting')) {
        systemStarting = !!state.starting;
    }
    updateStartButtonState();
    updateConfigCloseButton();
}

async function fetchSystemStatus() {
    try {
        const response = await fetch(SYSTEM_STATUS_ENDPOINT);
        const data = await response.json();
        if (data && data.success) {
            applySystemState(data);
        }
        return data;
    } catch (error) {
        console.error('获取系统状态失败', error);
        return null;
    }
}

async function ensureSystemReadyOnLoad() {
    const status = await fetchSystemStatus();
    if (!status || !status.success) {
        openConfigModal({
            lock: true,
            message: '无法获取系统状态，请检查配置后重试。'
        });
        return;
    }

    if (!status.started) {
        if (status.starting) {
            openConfigModal({ lock: false, message: '系统正在启动中，请稍候...' });
        } else {
            openConfigModal({ lock: true, message: '请先确认配置，然后点击"保存并启动系统"' });
        }
    } else {
        applySystemState(status);
        configModalLocked = false;
        if (!localStorage.getItem('bettafish_config_visited')) {
            openConfigModal({ lock: false, message: '欢迎使用！请检查并完善以下配置项。' });
        }
    }
}

function getRunningAgents() {
    return Object.keys(appStatus).filter(app => appStatus[app] === 'running');
}

function hideShutdownConfirm() {
    const modal = document.getElementById('shutdownConfirmModal');
    if (modal) {
        modal.classList.remove('visible');
        modal.setAttribute('aria-hidden', 'true');
    }
}

function showShutdownConfirm(runningAgents = []) {
    const modal = document.getElementById('shutdownConfirmModal');
    const list = document.getElementById('shutdownRunningList');
    const portList = document.getElementById('shutdownPortList');
    const strongText = document.getElementById('shutdownStrongText');

    if (strongText) {
        strongText.textContent = runningAgents.length > 0
            ? '部分 Agent 正在运行，确定要关闭吗？'
            : '确定要关闭系统吗？';
    }

    if (list) {
        list.innerHTML = '';
        list.style.display = 'none';
    }

    if (portList) {
        const targets = Object.entries(APP_PORTS).map(([key, port]) => {
            const status = appStatus[key] || 'unknown';
            const label = `${appNames[key] || key}${port ? `:${port}` : ''}`;
            const suffix = status === 'running' ? '运行中' : '未运行';
            return `<span class="confirm-pill shutdown-pill">${label} · ${suffix}</span>`;
        });
        portList.innerHTML = targets.length > 0
            ? targets.join('')
            : '<span class="confirm-pill">暂无需要关闭的端口</span>';
    }

    if (modal) {
        modal.classList.add('visible');
        modal.setAttribute('aria-hidden', 'false');
    }
}

async function handleSafeRefresh() {
    if (pageRefreshInProgress) {
        return;
    }

    pageRefreshInProgress = true;
    const refreshButton = document.getElementById('pageRefreshButton');
    const originalText = refreshButton ? refreshButton.textContent : '';
    if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.textContent = '刷新中...';
    }

    try {
        await fetchSystemStatus();
        await checkStatus();
        refreshConsoleOutput();
        showMessage('已刷新最新状态与日志', 'success');
    } catch (error) {
        console.error('刷新页面数据失败', error);
        showMessage(`刷新失败: ${error.message}`, 'error');
    } finally {
        pageRefreshInProgress = false;
        if (refreshButton) {
            refreshButton.disabled = false;
            refreshButton.textContent = originalText || '安全刷新';
        }
    }
}

async function handleShutdownRequest() {
    if (shutdownInProgress) {
        return;
    }

    if (systemStarting) {
        showMessage('系统正在启动/重启，请稍后再关闭', 'error');
        return;
    }

    const runningAgents = getRunningAgents();
    if (runningAgents.length > 0) {
        showShutdownConfirm(runningAgents);
        return;
    }

    shutdownSystem({ skipAgentWarning: true });
}

async function shutdownSystem(options = {}) {
    const { skipAgentWarning = false } = options;

    if (shutdownInProgress) {
        return;
    }

    if (!skipAgentWarning) {
        const runningAgents = getRunningAgents();
        if (runningAgents.length > 0) {
            showShutdownConfirm(runningAgents);
            return;
        }
    }

    shutdownInProgress = true;
    const button = document.getElementById('shutdownButton');
    const originalText = button ? button.textContent : '';
    if (button) {
        button.disabled = true;
        button.textContent = '关闭中...';
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(SYSTEM_SHUTDOWN_ENDPOINT, { method: 'POST', signal: controller.signal });
        clearTimeout(timeoutId);

        const message = '系统正在停止，请稍候...';
        if (!response.ok) {
            throw new Error(`服务返回 ${response.status}`);
        }

        setConfigStatus(message, 'success');
        showMessage(message, 'success');
    } catch (error) {
        const text = error.name === 'AbortError'
            ? '停止指令已发送，请稍候退出'
            : `停止失败: ${error.message}`;
        showMessage(text, error.name === 'AbortError' ? 'success' : 'error');

        if (error.name !== 'AbortError') {
            shutdownInProgress = false;
            if (button) {
                button.disabled = false;
                button.textContent = originalText || '关闭系统';
            }
        }
    }
}

async function startSystem() {
    if (systemStarting) {
        setConfigStatus('系统正在启动，请稍候...', '');
        return;
    }

    systemStarting = true;
    updateStartButtonState();

    try {
        if (configDirty) {
            setConfigStatus('检测到未保存的修改，正在保存配置...', '');
            const saved = await saveConfigUpdates({ silent: true });
            if (!saved) {
                systemStarting = false;
                updateStartButtonState();
                return;
            }
        }

        setConfigStatus('正在启动系统...', '');
        const response = await fetch(SYSTEM_START_ENDPOINT, { method: 'POST' });
        const data = await response.json();
        if (!response.ok || !data.success) {
            const message = data && data.message ? data.message : '系统启动失败';
            throw new Error(message);
        }

        showMessage('系统启动成功', 'success');
        setConfigStatus('系统启动成功', 'success');
        applySystemState({ started: true, starting: false });
        configModalLocked = false;

        setTimeout(() => {
            closeConfigModal();
        }, 800);

        setTimeout(() => {
            checkStatus();
        }, 1000);

        setTimeout(() => {
            window.location.reload();
        }, 1200);
    } catch (error) {
        setConfigStatus(`系统启动失败: ${error.message}`, 'error');
        showMessage(`系统启动失败: ${error.message}`, 'error');
        applySystemState({ started: false, starting: false });
    } finally {
        systemStarting = false;
        updateStartButtonState();
        await fetchSystemStatus();
    }
}

// 工具：推送日志到 ForumState 终端（带时间戳）
function _fsLog(text, app) {
    if (!window.ForumState) return;
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
    const src = (app || 'forum').toUpperCase();
    window.ForumState.push(`[${ts}] [${src}] ${text}`, app || 'forum');
}

// 执行搜索
async function performSearch() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) {
        showMessage('请输入搜索内容', 'error');
        return;
    }

    if (!window._modelConfigured) {
        showMessage('请先配置 LLM 模型和 API Key', 'error');
        openConfigModal({ lock: false });
        return;
    }

    if (window._currentSearchTaskId) {
        const currentQuery = window._currentSearchQuery || '上一个';
        const confirmed = await showConfirmDialog(
            `当前还有「${currentQuery}」报告在生成中，是否继续生成新的报告？`,
            '继续搜索',
            '取消'
        );
        if (!confirmed) {
            _fsLog('用户取消搜索', 'forum');
            return;
        }
        if (window._currentSearchTaskId) {
            window._pendingCancelTasks = window._pendingCancelTasks || [];
            window._pendingCancelTasks.push(window._currentSearchTaskId);
        }
        window._currentSearchTaskId = null;
        window._currentSearchQuery = null;
        _fsLog(`用户选择继续，新搜索关键词：「${query}」`, 'forum');
    }

    try {
        if (typeof window.activateWorkspace === 'function') {
            window.activateWorkspace();
        }
    } catch (e) {
        console.error('[performSearch] activateWorkspace 异常:', e);
    }

    try {
        if (window.ForumState) {
            window.ForumState.setSearchActive(true);
            window.ForumState.reset();
            window.ForumState.show();
        }
    } catch (e) {
        console.error('[performSearch] ForumState.show 异常:', e);
    }

    window.AppViewController.switchView('FORUM');

    saveSearchTerm(query);
    hideSearchDropdown();

    const button = document.getElementById('searchButton');
    button.disabled = true;
    button.innerHTML = '<span class="loading"></span> 搜索中...';

    const taskProgressArea = document.getElementById('taskProgressArea');
    if (taskProgressArea) {
        taskProgressArea.innerHTML = '';
    }

    autoGenerateTriggered = false;
    reportTaskId = null;
    stopProgressPolling();

    _fsLog(`收到搜索指令，关键词：「${query}」`, 'forum');
    _fsLog(`正在调用后端搜索接口...`, 'forum');

    try {
        const result = await window.API.startSearch(query);

        if (result.success) {
            reportTaskId = result.task_id;
            window._currentSearchTaskId = result.task_id;
            window._currentSearchQuery = query;
            window._taskInfoMap[result.task_id] = { query: query, startTime: Date.now() };
            _fsLog(`✅ 搜索任务已创建，任务ID：${result.task_id}`, 'forum');

            const progressContainer = document.getElementById('searchProgressContainer');
            if (progressContainer) {
                progressContainer.style.display = 'flex';
            }
            const forumBar = document.getElementById('forumProgressBar');
            const forumStage = document.getElementById('forumProgressStage');
            if (forumBar) forumBar.style.width = '5%';
            if (forumStage) forumStage.textContent = '正在启动...';

            showMessage('当前后台搜集数据等待报告生成，生成后可在【历史报告】中查看', 'info');
        } else {
            _fsLog(`❌ 搜索失败：${result.message}`, 'forum');
            showMessage('搜索失败：' + result.message, 'error');
        }
    } catch (e) {
        console.error('[performSearch] 调用搜索接口异常:', e);
        _fsLog(`❌ 网络异常：${e.message}`, 'forum');
        showMessage('网络异常：' + e.message, 'error');
    }

    button.disabled = false;
    button.innerHTML = '开始分析';
}

// 搜索进度阶段定义（按顺序）
const SEARCH_STAGES = [
    { key: '启动中', percent: 5 },
    { key: '采集', percent: 30 },
    { key: '清洗', percent: 50 },
    { key: '分析', percent: 70 },
    { key: '生成', percent: 90 },
    { key: '完成', percent: 100 },
];

// 根据阶段关键词计算进度百分比
function calcSearchPercent(stageMsg) {
    if (!stageMsg) return 0;
    for (const s of SEARCH_STAGES) {
        if (stageMsg.includes(s.key)) return s.percent;
    }
    return 50;
}

// 更新搜索进度条
function updateSearchProgress(data) {
    const container = document.getElementById('searchProgressContainer');
    const label = document.getElementById('searchProgressLabel');
    const bar = document.getElementById('searchProgressBar');
    const percent = document.getElementById('searchProgressPercent');
    const stage = document.getElementById('searchProgressStage');

    const pct = calcSearchPercent(data.stage);
    const msg = data.message || data.stage || '处理中';

    // 更新 app-switcher 区域的进度条
    if (container) {
        container.style.display = 'flex';
        label.textContent = '搜索进度';
        bar.style.width = pct + '%';
        percent.textContent = pct + '%';
        stage.textContent = msg;
    }

    // 更新 ForumState 区域的进度条
    const forumBar = document.getElementById('forumProgressBar');
    const forumStage = document.getElementById('forumProgressStage');
    if (forumBar) {
        forumBar.style.width = pct + '%';
    }
    if (forumStage) {
        forumStage.textContent = msg;
    }
}

// 搜索完成回调
function onSearchDone(data) {
    const container = document.getElementById('searchProgressContainer');
    const label = document.getElementById('searchProgressLabel');
    const bar = document.getElementById('searchProgressBar');
    const percent = document.getElementById('searchProgressPercent');
    const stage = document.getElementById('searchProgressStage');

    // 更新 app-switcher 区域
    if (container) {
        label.textContent = '搜索完成';
        bar.style.width = '100%';
        bar.style.background = 'linear-gradient(90deg, #4CAF50, #8BC34A)';
        percent.textContent = '100%';
        stage.textContent = '报告生成中...';
    }

    // 更新 ForumState 区域
    const forumBar = document.getElementById('forumProgressBar');
    const forumStage = document.getElementById('forumProgressStage');
    if (forumBar) {
        forumBar.style.width = '100%';
        forumBar.style.background = 'linear-gradient(90deg, #4CAF50, #8BC34A)';
    }
    if (forumStage) {
        forumStage.textContent = '报告生成中...';
    }

    // 获取任务ID和任务信息
    // task_id 是搜索任务ID（我们在 performSearch 时存储的）
    // report_task_id 是报告引擎内部的任务ID（不同）
    const taskId = data && (data.task_id || data.report_task_id);
    const taskInfo = taskId && window._taskInfoMap ? window._taskInfoMap[taskId] : null;
    const completedQuery = taskInfo ? taskInfo.query : (window._currentSearchQuery || '新');

    // 如果此任务被标记为取消（用户开始了新搜索），则不保存到历史
    const isCancelled = window._pendingCancelTasks && window._pendingCancelTasks.includes(taskId);
    if (isCancelled) {
        _fsLog(`任务 ${taskId} 已被新搜索取消，不保存到历史记录`, 'forum');
        if (taskId && window._taskInfoMap) {
            delete window._taskInfoMap[taskId];
        }
        window._pendingCancelTasks = (window._pendingCancelTasks || []).filter(id => id !== taskId);
        if (window._currentSearchTaskId === taskId) {
            window._currentSearchTaskId = null;
            window._currentSearchQuery = null;
        }
        return;
    }

    // 清理任务信息
    if (taskId && window._taskInfoMap) {
        delete window._taskInfoMap[taskId];
    }
    window._currentSearchTaskId = null;
    window._currentSearchQuery = null;

    // 保存到历史记录
    if (taskId && window.saveReportToHistory) {
        window.saveReportToHistory(completedQuery, taskId);
    }

    // 右上角弹出通知
    showNotification(
        '✅ 报告生成完成',
        `「${completedQuery}」报告已生成，请前往【历史报告】查看`,
        8000
    );
}

// 切换应用
function switchToApp(app) {
    if (app === currentApp) return;
    const previousApp = currentApp;

    // 检查Report Engine是否被锁定
    if (app === 'report') {
        const reportButton = document.querySelector(`[data-app="report"]`);
        if (reportButton && reportButton.classList.contains('locked')) {
            showMessage('需等待其余三个Agent工作完毕', 'error');
            return;
        }
    }

    // 更新按钮状态
    document.querySelectorAll('.app-button').forEach(btn => {
        btn.classList.remove('active');
    });
    const targetButton = document.querySelector(`[data-app="${app}"]`);
    if (targetButton) {
        targetButton.classList.add('active');
    }

    // 更新当前应用
    currentApp = app;

    // 【状态栏优化】切换app时隐藏状态栏，避免显示过时信息
    const statusBar = document.getElementById('consoleStatusBar');
    if (statusBar) {
        statusBar.classList.remove('visible');
    }

    // 【图层优化】切换控制台层（纯CSS图层切换，瞬间完成）
    setActiveConsoleLayer(app);

    switchEmbeddedView(app);

    // Forum默认吸附到最新日志与聊天
    if (app === 'forum') {
        scrollForumViewToBottom();
        // 再次异步确认，避免布局切换时机导致未到底
        setTimeout(scrollForumViewToBottom, 200);
    }

    // Report默认吸附到最新日志
    if (app === 'report') {
        scrollReportViewToBottom();
        setTimeout(scrollReportViewToBottom, 200);
    }

    // 其他引擎也补充双重吸附，降低偶发不贴底
    setTimeout(() => {
        const renderer = logRenderers[app];
        if (renderer) {
            renderer.forceScrollToLatest();
        }
    }, 120);

    // 【图层优化】移除重复加载逻辑
    // 日志数据已通过Socket.IO/SSE实时同步，无需重新加载
    // 仅保留特殊页面的初始化逻辑
    if (app === 'report') {
        // 【修复】切换到Report Engine时启动日志刷新
        reportLogManager.start();

        // 只在报告界面未初始化时才重新加载
        const reportContent = document.getElementById('reportContent');
        if (!reportContent || reportContent.children.length === 0) {
            loadReportInterface();
        }
        // 切换到report页面时检查是否可以自动生成报告
        setTimeout(() => {
            checkReportLockStatus();
        }, 500);
    } else {
        // 【修复】切换离开Report Engine时停止日志刷新，节省资源
        reportLogManager.stop();

        // 离开Report且无任务运行时，关闭SSE避免后台悬挂
        if (previousApp === 'report' && !reportTaskId && reportEventSource) {
            safeCloseReportStream(true);
            stopProgressPolling();
        }
    }
}

// 【新增】全局性能监控函数
function getGlobalPerformanceStats() {
    console.log('=== 日志渲染器性能统计 ===');
    let totalMemory = 0;
    let totalLines = 0;

    consoleLayerApps.forEach(app => {
        const renderer = logRenderers[app];
        if (renderer) {
            const stats = renderer.getPerformanceStats();
            console.log(`\n[${app.toUpperCase()}]:`);
            console.log(`  总行数: ${stats.totalLines}`);
            console.log(`  待处理行数: ${stats.pendingLines}`);
            console.log(`  队列峰值: ${stats.pendingHighWaterMark}`);
            console.log(`  Flush次数: ${stats.flushCount}`);
            console.log(`  上次渲染耗时: ${stats.lastRenderTime}`);
            console.log(`  上次渲染行数: ${stats.lastRenderLineCount}`);
            console.log(`  DOM池大小: ${stats.poolSize}`);
            console.log(`  内存估算: ${stats.memoryEstimate}`);

            totalLines += stats.totalLines;
            // 简单累加（实际内存使用需要更精确的计算）
        }
    });

    console.log(`\n=== 总计 ===`);
    console.log(`总日志行数: ${totalLines}`);
    console.log(`活跃渲染器: ${Object.keys(logRenderers).length}`);
}

// 【新增】重置所有性能统计
function resetAllPerformanceStats() {
    consoleLayerApps.forEach(app => {
        const renderer = logRenderers[app];
        if (renderer) {
            renderer.resetPerformanceStats();
        }
    });
    console.log('[性能统计] 已重置所有渲染器的性能统计');
}

// 【新增】定期内存优化（每5分钟检查一次）
function startMemoryOptimization() {
    setInterval(() => {
        consoleLayerApps.forEach(app => {
            // 只优化非当前活跃的渲染器
            if (app !== currentApp) {
                const renderer = logRenderers[app];
                if (renderer && renderer.lines.length > 0) {
                    // 如果非活跃渲染器有大量日志，进行trim
                    if (renderer.lines.length > renderer.maxLines * 0.8) {
                        const before = renderer.lines.length;
                        renderer.maybeTrim();
                        const after = renderer.lines.length;
                        if (before > after) {
                            console.log(`[内存优化] 非活跃渲染器 ${app} 从 ${before} 行裁剪到 ${after} 行`);
                        }
                    }
                }
            }
        });
    }, 5 * 60 * 1000); // 5分钟
}


// 存储最后显示的行数，避免重复加载
        let lastLineCount = {};




function getConsoleContainer() {
    return document.getElementById('consoleOutput');
}

// 同步状态栏位置，避免覆盖应用切换按钮
function syncStatusBarPosition() {
    const bar = document.getElementById('consoleStatusBar');
    const switcher = document.querySelector('.app-switcher');
    if (!bar || !switcher) return;

    const offset = switcher.offsetHeight || 0;
    const barHeight = bar.offsetHeight || 26;
    const totalOffset = offset + barHeight + 6; // 额外预留6px缓冲

    bar.style.top = `${offset}px`;
    document.documentElement.style.setProperty('--console-offset', `${totalOffset}px`);
}

function initializeConsoleLayers() {
    const container = getConsoleContainer();
    if (!container) return;
    container.innerHTML = '';

    consoleLayerApps.forEach(app => {
        const layer = document.createElement('div');
        layer.className = 'console-layer';
        layer.dataset.app = app;
        if (app === currentApp) {
            layer.classList.add('active');
            activeConsoleLayer = app;
        }
        // 【图层优化】不再设置style.display，完全由CSS类控制

        container.appendChild(layer);
        consoleLayers[app] = layer;
        logRenderers[app] = new LogVirtualList(layer);
        logRenderers[app].setActive(app === currentApp);

        // 【FIX Bug #3】初始提示立即渲染，避免黑屏
        logRenderers[app].clear(`[系统] ${appNames[app] || app} 日志就绪`);
        logRenderers[app].render(); // 立即同步渲染
    });

    // 不需要手动设置滚动位置，LogVirtualList会处理
}

function getConsoleLayer(app) {
    if (consoleLayers[app]) {
        return consoleLayers[app];
    }

    const container = getConsoleContainer();
    if (!container) return null;

    const layer = document.createElement('div');
    layer.className = 'console-layer';
    layer.dataset.app = app;
    // 【图层优化】不再设置style.display，完全由CSS类控制
    if (app === currentApp) {
        layer.classList.add('active');
        activeConsoleLayer = app;
    }

    container.appendChild(layer);
    consoleLayers[app] = layer;
    logRenderers[app] = new LogVirtualList(layer);
    logRenderers[app].setActive(app === currentApp);

    return layer;
}

function setActiveConsoleLayer(app) {
    const container = getConsoleContainer();
    if (!container) return;

    // 如果已经是当前激活的层，跳过
    if (activeConsoleLayer === app && consoleLayers[app] && consoleLayers[app].classList.contains('active')) {
        return;
    }

    // 【图层优化】标记旧窗口为非活动
    if (activeConsoleLayer && consoleLayers[activeConsoleLayer]) {
        consoleLayers[activeConsoleLayer].classList.remove('active');
        if (logRenderers[activeConsoleLayer]) {
            logRenderers[activeConsoleLayer].setActive(false);
        }
    }

    // 获取或创建目标层
    const targetLayer = getConsoleLayer(app);
    if (!targetLayer) return;

    // 【图层优化】显示新的激活层（纯CSS类切换，不修改style.display）
    targetLayer.classList.add('active');
    activeConsoleLayer = app;

    // 【图层优化】标记新窗口为活动，触发异步渲染
    const renderer = logRenderers[app];
    if (renderer) {
        renderer.setActive(true);  // 会在内部异步渲染待处理内容
        renderer.needsScroll = true;
        renderer.scheduleRender(true);
        requestAnimationFrame(() => renderer.forceScrollToLatest());
    }
}

function syncConsoleScroll(app) {
    // 这个函数已经不需要了，因为 LogVirtualList 内部已经处理了滚动
    // 保留函数签名以避免破坏现有调用，但不执行任何操作
    return;
}

function appendConsoleTextLine(app, text, className = 'console-line') {
    // 【优化】添加空值检查
    if (!app || !text) return;

    const renderer = logRenderers[app] || (logRenderers[app] = new LogVirtualList(getConsoleLayer(app)));
    renderer.append(text, className);
}

function appendConsoleElement(app, element) {
    // 【优化】添加空值检查
    if (!app || !element) return;

    const renderer = logRenderers[app] || (logRenderers[app] = new LogVirtualList(getConsoleLayer(app)));
    if (!renderer.container) return;

    // 将元素转换为文本行，统一使用 LogVirtualList 的渲染逻辑
    const text = element.textContent || element.innerText || '';
    const className = element.className || 'console-line';
    renderer.append(text, className);
}

function clearConsoleLayer(app, message = null) {
    const renderer = logRenderers[app] || (logRenderers[app] = new LogVirtualList(getConsoleLayer(app)));
    renderer.clear(message);
}

// 加载控制台输出
function loadConsoleOutput(app) {
    if (app === 'forum') {
        loadForumLog();
        return;
    }

    if (app === 'report') {
        loadReportLog();
        return;
    }

    fetch(`/api/output/${app}`)
    .then(response => response.json())
    .then(data => {
        if (data.success && data.output.length > 0) {
            const lastCount = lastLineCount[app] || 0;
            const newLines = data.output.slice(lastCount);

            if (newLines.length > 0) {
                newLines.forEach(line => appendConsoleTextLine(app, line));
                lastLineCount[app] = data.output.length;

                // 切换到该引擎时立即吸附到最新，显示最新日志
                if (currentApp === app) {
                    const renderer = logRenderers[app];
                    if (renderer) {
                        renderer.needsScroll = true;
                        requestAnimationFrame(() => renderer.forceScrollToLatest());
                        setTimeout(() => renderer.forceScrollToLatest(), 60);
                    }
                }

                // 数据加载完成，更新加载提示为实际日志
                const renderer = logRenderers[app];
                if (renderer && renderer.lines.length > 0) {
                    // 移除"正在加载"提示（如果存在）
                    const firstLine = renderer.lines[0];
                    if (firstLine && firstLine.text.includes('正在加载')) {
                        renderer.lines.shift(); // 移除第一行
                        renderer.lastRenderHash = null; // 强制重新渲染
                        renderer.scheduleRender(true);
                    }
                }
            }
        }
    })
    .catch(error => {
        console.error('加载输出失败:', error);
        // 加载失败时也显示错误提示
        if (currentApp === app) {
            const renderer = logRenderers[app];
            if (renderer) {
                renderer.clear(`[错误] 加载${appNames[app] || app}日志失败`);
                renderer.render();
            }
        }
    });
}

// 预加载所有Engine的历史日志，切换时无需等待
function preloadAllConsoleOutputs() {
    ['insight', 'media', 'query', 'forum'].forEach(app => {
        if (app === currentApp) return;
        loadConsoleOutput(app);
    });
}

// 刷新当前应用的控制台输出
function refreshConsoleOutput() {
    if (currentApp === 'forum') {
        refreshForumLog();
        return;
    }

    if (currentApp === 'report') {
        // 使用新的日志管理器刷新
        if (reportLogManager && reportLogManager.isRunning) {
            reportLogManager.refresh();
        }
        return;
    }

    if (appStatus[currentApp] === 'running' || appStatus[currentApp] === 'starting') {
        fetch(`/api/output/${currentApp}`)
        .then(response => response.json())
        .then(data => {
            if (data.success && data.output.length > 0) {
                // 只添加新的行
                const lastCount = lastLineCount[currentApp] || 0;
                const newLines = data.output.slice(lastCount);

                if (newLines.length > 0) {
                    newLines.forEach(line => {
                        appendConsoleTextLine(currentApp, line);
                    });
                    lastLineCount[currentApp] = data.output.length;
                }
            }
        })
        .catch(error => {
            console.error('刷新输出失败:', error);
        });
    }
}

// 添加控制台输出
function addConsoleOutput(line, app = currentApp) {
    const targetApp = app || currentApp;
    appendConsoleTextLine(targetApp, line);

    if (targetApp !== 'report') {
        lastLineCount[targetApp] = (lastLineCount[targetApp] || 0) + 1;
    }
}

function switchEmbeddedView(app) {
    const header = document.getElementById('embeddedHeader');
    if (!header) return;
    const fc = document.getElementById('forumContainer');
    const rc = document.getElementById('reportContainer');

    if (app === 'forum') {
        header.textContent = '论坛引擎 - 多智能体交流';
        fc.classList.add('active');
        rc.classList.remove('active');
    } else if (app === 'report') {
        header.textContent = '报告引擎 - 最终报告生成';
        rc.classList.add('active');
        fc.classList.remove('active');
    } else {
        header.textContent = agentTitles[app] || appNames[app] || app;
        rc.classList.remove('active');
        fc.classList.remove('active');
    }
}

// 检查应用状态
function checkStatus() {
    fetch('/api/status')
    .then(response => response.json())
    .then(data => {
        backendReachable = true;
        updateAppStatus(data);
        refreshConnectionStatus();
    })
    .catch(error => {
        console.error('状态检查失败:', error);
        backendReachable = false;
        refreshConnectionStatus();
    });
}

function startConnectionProbe() {
    if (connectionProbeTimer) {
        clearInterval(connectionProbeTimer);
    }
    probeBackendConnection();
    connectionProbeTimer = setInterval(probeBackendConnection, CONNECTION_PROBE_INTERVAL);
}

function probeBackendConnection() {
    fetch('/api/report/status?heartbeat=1', { cache: 'no-store' })
    .then(response => {
        if (!response.ok) throw new Error('heartbeat failed');
        return response.json();
    })
    .then(() => {
        backendReachable = true;
        refreshConnectionStatus();
    })
    .catch(() => {
        backendReachable = false;
        refreshConnectionStatus();
    });
}

// 更新应用状态
function updateAppStatus(data) {
    // 先备份旧状态，用于判断是否有变化
    const oldStatus = { ...appStatus };

    for (const [app, info] of Object.entries(data)) {
        // 适配实际的API格式：{app: {status: string, port: int, output_lines: int}}
        const status = info.status === 'running' ? 'running' : 'stopped';
        appStatus[app] = status;

        const indicator = document.getElementById(`status-${app}`);
        if (indicator) {
            indicator.className = `status-indicator ${status}`;
        }
    }

    // 检查是否有状态真正改变
    let statusChanged = false;
    for (const [app, info] of Object.entries(data)) {
        const newStatus = info.status === 'running' ? 'running' : 'stopped';
        if (oldStatus[app] !== newStatus) {
            statusChanged = true;
            break;
        }
    }

    if (statusChanged) {
        switchEmbeddedView(currentApp);
    }
}

// 根据当前的Socket/SSE状态刷新底部连接指示
function refreshConnectionStatus() {
    const statusEl = document.getElementById('connectionStatus');
    if (!statusEl) return;
    if (socketConnected || reportStreamConnected || backendReachable) {
        statusEl.textContent = '已连接';
    } else {
        statusEl.textContent = '连接断开';
    }
}

// 更新时间
function updateTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('zh-CN');
    document.getElementById('systemTime').textContent = timeString;
}

// 显示消息
function showMessage(text, type = 'info', action = null) {
    const message = document.getElementById('message');

    // 清除之前的定时器
    if (message.hideTimer) {
        clearTimeout(message.hideTimer);
    }

    // 清空内容
    message.innerHTML = '';
    message.className = `message ${type}`;

    // 文字节点
    message.appendChild(document.createTextNode(text));

    // 可选操作按钮
    if (action && action.label && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.className = 'message-action-btn';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
            message.classList.remove('show');
            action.onClick();
        });
        message.appendChild(btn);
    }

    message.classList.add('show');

    const delay = action ? 6000 : 3000;
    message.hideTimer = setTimeout(() => {
        message.classList.remove('show');
        setTimeout(() => {
            message.innerHTML = '';
            message.className = 'message';
        }, 300);
    }, delay);
}

// 确认对话框
function showConfirmDialog(message, confirmText = '确定', cancelText = '取消') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
        overlay.id = 'confirmDialogOverlay';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.3);font-family:inherit;';
        dialog.innerHTML = `
            <p style="margin:0 0 20px;font-size:16px;color:#333;line-height:1.5;">${message}</p>
            <div style="display:flex;gap:12px;justify-content:flex-end;">
                <button id="dialogCancel" style="padding:10px 20px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;color:#666;cursor:pointer;font-size:14px;">${cancelText}</button>
                <button id="dialogConfirm" style="padding:10px 20px;border:none;border-radius:6px;background:#4CAF50;color:#fff;cursor:pointer;font-size:14px;">${confirmText}</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        document.getElementById('dialogConfirm').addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(true);
        });
        document.getElementById('dialogCancel').addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(false);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
                resolve(false);
            }
        });
    });
}

// 右上角弹出通知
function showNotification(title, message, duration = 5000) {
    const existing = document.getElementById('reportNotification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.id = 'reportNotification';
    notification.style.cssText = 'position:fixed;top:20px;right:20px;width:320px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:10001;overflow:hidden;font-family:inherit;';

    notification.innerHTML = `
        <div style="background:linear-gradient(135deg,#4CAF50,#8BC34A);padding:14px 16px;color:#fff;">
            <div style="font-size:14px;font-weight:bold;">${title}</div>
        </div>
        <div style="padding:16px;">
            <p style="margin:0 0 12px;font-size:13px;color:#666;line-height:1.5;">${message}</p>
            <div style="display:flex;gap:8px;">
                <button id="notifGoReport" style="flex:1;padding:8px 12px;border:none;border-radius:6px;background:#4CAF50;color:#fff;cursor:pointer;font-size:13px;">前往历史报告</button>
                <button id="notifClose" style="padding:8px 12px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;color:#666;cursor:pointer;font-size:13px;">关闭</button>
            </div>
        </div>
    `;

    document.body.appendChild(notification);

    notification.querySelector('#notifGoReport').addEventListener('click', () => {
        notification.remove();
        switchToApp('report');
    });
    notification.querySelector('#notifClose').addEventListener('click', () => {
        notification.remove();
    });

    setTimeout(() => {
        if (document.getElementById('reportNotification')) {
            notification.remove();
        }
    }, duration);
}

// 处理模板文件上传
function handleTemplateUpload(event) {
    const file = event.target.files[0];
    const statusDiv = document.getElementById('uploadStatus');

    if (!file) {
        statusDiv.textContent = '';
        statusDiv.className = 'upload-status';
        customTemplate = '';
        return;
    }

    // 检查文件类型
    const allowedTypes = ['text/markdown', 'text/plain', '.md', '.txt'];
    const fileName = file.name.toLowerCase();
    const isValidType = fileName.endsWith('.md') || fileName.endsWith('.txt') || 
                      allowedTypes.includes(file.type);

    if (!isValidType) {
        statusDiv.textContent = '错误: 请选择 .md 或 .txt 文件';
        statusDiv.className = 'upload-status error';
        customTemplate = '';
        event.target.value = ''; // 清空文件输入
        return;
    }

    // 检查文件大小 (最大 1MB)
    const maxSize = 1024 * 1024; // 1MB
    if (file.size > maxSize) {
        statusDiv.textContent = '错误: 文件大小不能超过 1MB';
        statusDiv.className = 'upload-status error';
        customTemplate = '';
        event.target.value = '';
        return;
    }

    statusDiv.textContent = '正在读取文件...';
    statusDiv.className = 'upload-status';

    // 读取文件内容
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            customTemplate = e.target.result;
            statusDiv.textContent = `成功: 已加载自定义模板 "${file.name}" (${(file.size/1024).toFixed(1)}KB)`;
            statusDiv.className = 'upload-status success';
            showMessage(`自定义模板已加载: ${file.name}`, 'success');
        } catch (error) {
            statusDiv.textContent = '错误: 文件读取失败';
            statusDiv.className = 'upload-status error';
            customTemplate = '';
            event.target.value = '';
        }
    };

    reader.onerror = function() {
        statusDiv.textContent = '错误: 文件读取失败';
        statusDiv.className = 'upload-status error';
        customTemplate = '';
        event.target.value = '';
    };

    reader.readAsText(file, 'utf-8');
}

// Forum Engine 相关函数
let forumLogLineCount = 0;

// Report Engine 相关函数
let reportLogLineCount = 0;
let reportLockCheckInterval = null;
let lastCompletedReportTask = null;
// 标记是否已通过SSE直接获取日志，避免轮询重复
let reportLogStreaming = false;

// ====== Report Engine 日志管理器 ======
class ReportLogManager {
    constructor() {
        this.intervalId = null;
        this.lineCount = 0;
        this.isRunning = false;
        this.refreshInterval = 250; // 改为250ms，更接近实时
        this.lastError = null;
        this.retryCount = 0;
        this.maxRetries = 3;
        this.consecutiveErrors = 0; // 连续错误计数
        this.maxConsecutiveErrors = 10; // 增加到10次，因为频率更高了
        this.abortController = null; // 复用controller避免创建开销
        this.isFetching = false; // 避免并发请求
    }

    // 启动日志轮询
    start() {
        if (this.isRunning || reportLogStreaming) {
            return;
        }

        this.isRunning = true;
        this.retryCount = 0;
        this.consecutiveErrors = 0; // 重置连续错误计数

        // 立即执行一次
        console.log('[ReportLogManager] 启动日志轮询');
        this.refresh();

        // 启动定时轮询
        this.intervalId = setInterval(() => {
            if (currentApp === 'report' && this.isRunning && !reportLogStreaming) {
                this.refresh();
            }
        }, this.refreshInterval);
    }

    // 停止日志轮询
    stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // 取消正在进行的请求
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isFetching = false;

        console.log('[ReportLogManager] 停止日志轮询');
    }

    // 重置计数器（任务开始时调用）
    reset() {
        this.lineCount = 0;
        this.lastError = null;
        this.retryCount = 0;
        this.consecutiveErrors = 0;
        this.isFetching = false;
    }

    // 刷新日志
    refresh() {
        if (!this.isRunning || reportLogStreaming) {
            return;
        }

        if (this.isFetching) {
            return;
        }
        this.isFetching = true;

        // 复用或创建新的 AbortController
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const timeoutId = setTimeout(() => {
            if (this.abortController) {
                this.abortController.abort();
            }
        }, 3000);

        fetch('/api/report/log', {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' },
            signal: this.abortController.signal
        })
        .then(response => {
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return response.json();
        })
        .then(data => {
            // 成功后重置连续错误计数
            this.consecutiveErrors = 0;
            this.retryCount = 0;

            if (!data.success) {
                throw new Error(data.error || '未知错误');
            }

            // 处理日志数据
            this.processLogs(data.log_lines || []);
        })
        .catch(error => {
            clearTimeout(timeoutId);
            // 忽略abort错误
            if (error.name === 'AbortError') {
                this.isFetching = false;
                return;
            }
            this.handleError(error);
        })
        .finally(() => {
            this.isFetching = false;
        });
    }

    // 处理日志数据
    processLogs(logLines) {
        const totalLines = logLines.length;

        // 如果有新日志
        if (totalLines > this.lineCount) {
            const newLines = logLines.slice(this.lineCount);

            // 逐行处理并显示
            newLines.forEach(line => {
                this.displayLogLine(line);
            });

            // 更新计数器
            this.lineCount = totalLines;
        }
    }

    // 显示单行日志（带格式化）
    displayLogLine(line) {
        // 解析loguru格式的日志
        // 注意：loguru的级别字段会填充到8个字符，如 "INFO    ", "WARNING ", "DEBUG   ", "ERROR   "
        // 修改正则以匹配带空格填充的级别字段
        const logPattern = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s*\|\s*(INFO|DEBUG|WARNING|ERROR|CRITICAL)\s*\|\s*(.+?)\s*-\s*(.*)$/;
        const match = line.match(logPattern);

        if (match) {
            const [, timestamp, levelWithPadding, location, message] = match;

            // 去除级别中的填充空格
            const level = levelWithPadding.trim();

            // 格式化输出 - 简化时间戳，只显示时间部分
            const timeOnly = timestamp.split(' ')[1];
            const formattedLine = `[${timeOnly}] [${level}] ${message}`;

            // 添加到控制台（带样式提示）
            if (level === 'ERROR' || level === 'CRITICAL') {
                appendConsoleTextLine('report', formattedLine, 'error');
            } else if (level === 'WARNING') {
                appendConsoleTextLine('report', formattedLine, 'warning');
            } else if (level === 'DEBUG') {
                appendConsoleTextLine('report', formattedLine, 'debug');
            } else {
                appendConsoleTextLine('report', formattedLine);
            }
        } else {
            // 非标准格式的日志，直接显示
            appendConsoleTextLine('report', line);
        }
    }

    // 处理错误
    handleError(error) {
        // 增加连续错误计数
        this.consecutiveErrors++;

        // 避免重复错误日志
        const errorMsg = error.message || error.toString();
        const isSameError = (errorMsg === this.lastError);
        this.lastError = errorMsg;

        // 只在前几次或新错误时输出
        if (!isSameError && this.consecutiveErrors <= 3) {
            console.warn(`[ReportLogManager] 获取日志失败 (连续${this.consecutiveErrors}次): ${errorMsg}`);
        }

        // 连续错误过多时暂停
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
            this.stop();
            console.error('[ReportLogManager] 连续错误过多，暂停轮询');

            // 10秒后自动重试
            setTimeout(() => {
                if (currentApp === 'report' && !this.isRunning) {
                    console.log('[ReportLogManager] 尝试恢复轮询...');
                    this.consecutiveErrors = 0; // 重置错误计数
                    this.start();
                }
            }, 10000);
        }
    }

    // 获取状态信息
    getStatus() {
        return {
            isRunning: this.isRunning,
            lineCount: this.lineCount,
            intervalId: this.intervalId,
            lastError: this.lastError,
            retryCount: this.retryCount
        };
    }
}

// 创建全局日志管理器实例
const reportLogManager = new ReportLogManager();

// 新任务时重置报告日志，避免残留历史输出
function resetReportLogsForNewTask(taskId, reason = '开始新的报告任务，日志已重置') {
    if (!taskId) return;
    if (reportTaskId === taskId) return; // 已是同一任务，无需重复清空

    // 停止当前流与轮询，防止旧日志混入
    safeCloseReportStream();
    reportLogManager.stop();
    reportLogManager.reset();

    // 重置前端计数与缓存
    reportLogLineCount = 0;
    lastLineCount['report'] = 0;

    clearConsoleLayer('report', `[系统] ${reason}`);
    resetReportStreamOutput('报告引擎正在启动...');

    // 重新启动轮询，确保新任务日志即时接入
    reportLogManager.start();
    reportTaskId = taskId;
}

// 【调试】测试日志管理器
window.testReportLogManager = function() {
    console.log('[测试] ===== 开始测试Report日志管理器 =====');

    // 检查当前状态
    const status = reportLogManager.getStatus();
    console.log('[测试] 当前状态:', status);

    // 如果未运行，启动它
    if (!status.isRunning) {
        console.log('[测试] 启动日志管理器...');
        reportLogManager.start();
    }

    // 手动刷新一次
    console.log('[测试] 手动触发刷新...');
    reportLogManager.refresh();

    // 模拟添加日志
    console.log('[测试] 模拟添加WARNING日志...');
    appendConsoleTextLine('report', '[21:02:43.014] [WARNING] 测试警告消息', 'warning');

    console.log('[测试] 模拟添加ERROR日志...');
    appendConsoleTextLine('report', '[21:02:43.018] [ERROR] 测试错误消息', 'error');

    console.log('[测试] ===== 测试完成 =====');
};

// 【调试】直接测试API
window.testReportAPI = function() {
    console.log('[测试API] ===== 开始测试Report API =====');

    fetch('/api/report/log', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' }
    })
    .then(response => {
        console.log('[测试API] 响应状态:', response.status);
        return response.json();
    })
    .then(data => {
        console.log('[测试API] 返回数据:', data);
        if (data.success && data.log_lines) {
            console.log('[测试API] 日志行数:', data.log_lines.length);
            console.log('[测试API] 前5行日志:');
            data.log_lines.slice(0, 5).forEach((line, idx) => {
                console.log(`  ${idx}: ${line}`);
            });

            // 查找WARNING和ERROR日志
            const warnings = data.log_lines.filter(line => line.includes('WARNING'));
            const errors = data.log_lines.filter(line => line.includes('ERROR'));

            console.log(`[测试API] 找到 ${warnings.length} 条WARNING日志`);
            console.log(`[测试API] 找到 ${errors.length} 条ERROR日志`);

            if (warnings.length > 0) {
                console.log('[测试API] WARNING日志示例:');
                warnings.slice(0, 3).forEach(line => console.log('  ', line));
            }

            if (errors.length > 0) {
                console.log('[测试API] ERROR日志示例:');
                errors.slice(0, 3).forEach(line => console.log('  ', line));
            }
        }
    })
    .catch(error => {
        console.error('[测试API] 错误:', error);
    });

    console.log('[测试API] ===== 测试完成 =====');
};

function attachForumScrollHandler() {
    const chatArea = document.getElementById('forumChatArea');
    if (!chatArea || forumScrollHandlerAttached) return;
    forumScrollHandlerAttached = true;

    chatArea.addEventListener('scroll', () => {
        const nearBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < FORUM_SCROLL_BOTTOM_THRESHOLD;

        if (nearBottom) {
            forumAutoScrollEnabled = true;
            if (forumScrollRestTimer) {
                clearTimeout(forumScrollRestTimer);
                forumScrollRestTimer = null;
            }
        } else {
            forumAutoScrollEnabled = false;
            if (forumScrollRestTimer) {
                clearTimeout(forumScrollRestTimer);
            }
            forumScrollRestTimer = setTimeout(() => {
                forumAutoScrollEnabled = true;
                scrollForumViewToBottom(true);
            }, FORUM_SCROLL_REATTACH_DELAY);
        }
    });
}

function applyForumMessages(parsedMessages, { reset = false } = {}) {
    const chatArea = document.getElementById('forumChatArea');
    if (!chatArea) return;

    const incoming = parsedMessages || [];

    // 文件被重置或主动要求刷新时清空
    if (reset || incoming.length < forumMessagesCache.length) {
        chatArea.innerHTML = '';
        forumMessagesCache = [];
    }

    if (incoming.length === 0) {
        forumMessagesCache = [];
        return;
    }

    // 初次渲染或缓存为空
    if (forumMessagesCache.length === 0) {
        forumMessagesCache = incoming.slice();
        incoming.forEach(msg => addForumMessage(msg, { suppressScroll: true }));
        scrollForumViewToBottom(true);
        return;
    }

    // 只追加新增的消息，避免滚动条跳动
    if (incoming.length > forumMessagesCache.length) {
        const newMessages = incoming.slice(forumMessagesCache.length);
        forumMessagesCache = incoming.slice();
        newMessages.forEach(msg => addForumMessage(msg, { suppressScroll: true }));
        if (forumAutoScrollEnabled) {
            scrollForumViewToBottom();
        }
    }
}

// 实时刷新论坛消息（适用于所有页面）
function refreshForumMessages() {
    fetch('/api/forum/log')
    .then(response => response.json())
    .then(data => {
        if (!data.success) return;

        const logLines = data.log_lines || [];
        const parsedMessages = data.parsed_messages || [];

        const logShrunk = logLines.length < forumLogLineCount || parsedMessages.length < forumMessagesCache.length;

        if (logLines.length > forumLogLineCount) {
            const newLines = logLines.slice(forumLogLineCount);
            newLines.forEach(line => {
                appendConsoleTextLine('forum', line);
            });
        }

        applyForumMessages(parsedMessages, { reset: logShrunk });

        forumLogLineCount = logLines.length;
    })
    .catch(error => {
        console.error('刷新论坛消息失败:', error);
    });
}

// ── 搜索提示词条 ──
const SEARCH_HINT_POOL = [
    "具身智能赛道头部企业核心技术栈对比",
    "新一代智能座舱多模态交互演进趋势",
    "端侧大模型算力下放对终端定价权影响",
    "大模型结合 RPA 在企业业务流改造的 ROI",
    "全球 L2+ 高阶辅助驾驶核心供应链调研",
    "车载智能终端出海欧美的本土化用户洞察",
    "中国科技品牌在日韩市场的第二增长曲线",
    "北美市场对车载无感互联配件的痛点挖掘",
    "智能车机系统（CarPlay等）的全球装配率变动",
    "人形机器人核心零部件供应链的国产替代"
];

function renderRandomSearchHints() {
    const container = document.getElementById('searchHintChipsContainer');
    const input = document.getElementById('searchInput');
    if (!container || !input) return;

    const indices = [];
    while (indices.length < 3) {
        const idx = Math.floor(Math.random() * SEARCH_HINT_POOL.length);
        if (!indices.includes(idx)) indices.push(idx);
    }

    container.innerHTML = '';
    indices.forEach(idx => {
        const query = SEARCH_HINT_POOL[idx];
        const chip = document.createElement('span');
        chip.className = 'search-hint-chip';
        chip.dataset.query = query;
        chip.textContent = `"${query}"`;
        chip.addEventListener('click', () => {
            input.value = query;
            input.focus();
        });
        container.appendChild(chip);
    });
}
function initSearchHints() {
    renderRandomSearchHints();
}

// ── 引擎配置状态检测 ──
function checkEngineConfigStatus() {
    fetch('/api/config')
        .then(r => r.json())
        .then(data => {
            if (!data.success) return;
            const cfg = data.config || {};
            const keyFields = [
                'INSIGHT_ENGINE_API_KEY',
                'MEDIA_ENGINE_API_KEY',
                'QUERY_ENGINE_API_KEY',
                'REPORT_ENGINE_API_KEY'
            ];
            const allConfigured = keyFields.some(k => cfg[k] && cfg[k].trim() !== '');
            // 缓存配置状态，供 performSearch 使用
            window._modelConfigured = allConfigured;
            const banner = document.getElementById('engineStatusBanner');
            const bannerText = document.getElementById('engineStatusBannerText');
            if (!banner) return;
            banner.style.display = 'flex';
            if (allConfigured) {
                banner.className = 'engine-status-banner ready';
                bannerText.textContent = '洞察引擎已就绪';
                banner.onclick = null;
                banner.title = '';
            } else {
                banner.className = 'engine-status-banner not-ready';
                bannerText.innerHTML = '⚠️ 引擎尚未就绪，请先完成 <span class="banner-link">LLM 配置</span>';
                banner.onclick = () => {
                    const btn = document.getElementById('openConfigButton');
                    if (btn) btn.click();
                };
                banner.title = '点击前往配置';
            }
        })
        .catch(() => {
            // 后端不可达时不显示横幅
            const banner = document.getElementById('engineStatusBanner');
            if (banner) banner.style.display = 'none';
        });
}

// ── 搜索历史下拉 ──
const SEARCH_HISTORY_KEY = 'yuqing_search_history';
const SEARCH_HISTORY_MAX = 10;

function getSearchHistory() {
    try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); }
    catch (e) { return []; }
}

function saveSearchTerm(term) {
    if (!term) return;
    let list = getSearchHistory();
    list = list.filter(t => t !== term);
    list.unshift(term);
    if (list.length > SEARCH_HISTORY_MAX) list.splice(SEARCH_HISTORY_MAX);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list));
}

function deleteSearchTerm(term) {
    let list = getSearchHistory().filter(t => t !== term);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list));
}

function clearSearchHistory() {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
}

// 查找某个搜索词是否有已完成的报告，返回最新一条或 null
function findReportByTitle(title) {
    const history = getReportHistory();
    return history.find(h => h.title === title && h.status === 'done') || null;
}

// 渲染下拉列表
function renderSearchDropdown(filterText) {
    const dropdown = document.getElementById('searchHistoryDropdown');
    if (!dropdown) return;
    let list = getSearchHistory();
    if (filterText) {
        list = list.filter(t => t.includes(filterText));
    }
    if (list.length === 0) {
        dropdown.style.display = 'none';
        return;
    }
    const reportHistory = getReportHistory();
    const reportTitleSet = new Set(reportHistory.filter(h => h.status === 'done').map(h => h.title));

    let html = '<div class="shd-header">最近搜索</div>';
    list.forEach(term => {
        const safeTerm = escapeHtml(term);
        const hasBadge = reportTitleSet.has(term);
        html += `<div class="shd-item" data-term="${safeTerm}">
            <span class="shd-item-icon">🕐</span>
            <span class="shd-item-text">${safeTerm}</span>
            ${hasBadge ? '<span class="shd-item-badge">有报告</span>' : ''}
            <span class="shd-item-del" data-del="${safeTerm}" title="删除">×</span>
        </div>`;
    });
    html += '<div class="shd-footer" id="shdClearAll">清空搜索历史</div>';
    dropdown.innerHTML = html;
    dropdown.style.display = 'block';

    // 点击词条回填
    dropdown.querySelectorAll('.shd-item').forEach(item => {
        item.addEventListener('mousedown', function(e) {
            // 如果点的是删除按钮，不触发回填
            if (e.target.classList.contains('shd-item-del')) return;
            e.preventDefault();
            const term = this.dataset.term;
            fillSearchAndCheck(term);
        });
    });

    // 删除单条
    dropdown.querySelectorAll('.shd-item-del').forEach(btn => {
        btn.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            deleteSearchTerm(this.dataset.del);
            renderSearchDropdown(document.getElementById('searchInput').value.trim());
        });
    });

    // 清空全部
    const clearBtn = dropdown.querySelector('#shdClearAll');
    if (clearBtn) {
        clearBtn.addEventListener('mousedown', function(e) {
            e.preventDefault();
            clearSearchHistory();
            hideSearchDropdown();
        });
    }
}

function hideSearchDropdown() {
    const dropdown = document.getElementById('searchHistoryDropdown');
    if (dropdown) dropdown.style.display = 'none';
}

// 回填搜索词，并检查是否有历史报告
function fillSearchAndCheck(term) {
    const input = document.getElementById('searchInput');
    if (input) input.value = term;
    hideSearchDropdown();
    const report = findReportByTitle(term);
    if (report) {
        showSearchHistoryConfirm(term, report);
    }
}

// 显示确认弹框
function showSearchHistoryConfirm(term, report) {
    const overlay = document.getElementById('searchHistoryConfirmOverlay');
    const dateEl = document.getElementById('shcDate');
    if (!overlay || !dateEl) return;
    dateEl.textContent = report.time || '未知时间';
    overlay.style.display = 'flex';

    // 重新生成：关闭弹框，保留输入词
    document.getElementById('shcRegenBtn').onclick = function() {
        overlay.style.display = 'none';
    };

    // 查看历史报告：跳转到报告详情
    document.getElementById('shcViewBtn').onclick = function() {
        overlay.style.display = 'none';
        openReportById(report.id);
    };
}

// 根据 taskId 打开历史报告
function openReportById(taskId) {
    taskId = (taskId || '').trim();
    if (!taskId) {
        console.error('[openReportById] taskId 为空');
        return;
    }
    console.log('[openReportById] 准备打开报告 taskId=', taskId);

    // 切换到报告界面
    currentApp = 'report';
    switchToApp('report');

    // 延迟调用 viewReport 确保 UI 已切换
    setTimeout(() => {
        console.log('[openReportById] 调用 viewReport, taskId=', taskId);
        if (typeof viewReport === 'function') {
            viewReport(taskId);
        } else {
            console.error('[openReportById] viewReport 不是函数');
            window.open(`/api/report/result/${taskId}`, '_blank');
        }
    }, 150);
}

function initSearchHistoryDropdown() {
    const input = document.getElementById('searchInput');
    if (!input) return;

    // 获得焦点时展示历史
    input.addEventListener('focus', function() {
        renderSearchDropdown(this.value.trim());
    });

    // 输入时过滤历史
    input.addEventListener('input', function() {
        renderSearchDropdown(this.value.trim());
    });

    // 失去焦点时隐藏（延迟，让 mousedown 先触发）
    input.addEventListener('blur', function() {
        setTimeout(hideSearchDropdown, 150);
    });

    // 点击页面其他区域关闭
    document.addEventListener('click', function(e) {
        const wrapper = document.querySelector('.search-input-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
            hideSearchDropdown();
        }
    });
}

// ── 历史存档抽屉 ──
const HISTORY_STORAGE_KEY = 'yuqing_report_history';

function getReportHistory() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function saveReportToHistory(title, taskId) {
    const history = getReportHistory();
    const entry = {
        id: taskId || Date.now().toString(),
        title: title || '未命名报告',
        time: new Date().toLocaleString('zh-CN'),
        createdAt: Date.now(),
        status: 'done'
    };
    // 去重：同 taskId 不重复存
    if (taskId && history.some(h => h.id === taskId)) return;
    history.unshift(entry);
    // 最多保留 20 条
    if (history.length > 20) history.splice(20);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));

    // 如果抽屉是打开的，立即重新渲染
    const drawer = document.getElementById('historyDrawer');
    if (drawer && drawer.classList.contains('open')) {
        renderHistoryDrawer();
    }
}

// 暴露给报告完成时调用
window.saveReportToHistory = saveReportToHistory;

function renderHistoryDrawer() {
    const body = document.getElementById('historyDrawerBody');
    if (!body) return;
    let history = getReportHistory();
    // 按生成时间倒序排列
    history.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (history.length === 0) {
        body.innerHTML = '<div class="history-empty">暂无历史报告<br><span style="font-size:11px;opacity:0.6;">完成一次分析后，报告将自动存档于此</span></div>';
        return;
    }
    body.innerHTML = history.map(item => {
        const safeTitle = escapeHtml(item.title || '');
        const safeTime  = escapeHtml(item.time  || '');
        const safeId    = escapeHtml(item.id    || '');
        return `
        <div class="history-card" data-id="${safeId}" title="${safeTitle}">
            <div class="history-card-title">${safeTitle}</div>
            <div class="history-card-meta">
                <span class="history-card-badge done">已完成</span>
                <span>${safeTime}</span>
            </div>
        </div>`;
    }).join('');
    // 点击卡片：直接打开对应的历史报告
    body.querySelectorAll('.history-card').forEach(card => {
        card.addEventListener('click', () => {
            const taskId = card.dataset.id;
            closeHistoryDrawer();
            if (taskId) {
                openReportById(taskId);
            }
        });
    });
}

function openHistoryDrawer() {
    renderHistoryDrawer();
    document.getElementById('historyDrawer').classList.add('open');
    document.getElementById('historyDrawerOverlay').classList.add('visible');
    syncReportHistoryFromBackend();
}

// 从后端同步历史报告到 localStorage
function syncReportHistoryFromBackend() {
    fetch('/api/report/history')
    .then(response => response.json())
    .then(data => {
        if (data.success && data.history && data.history.length > 0) {
            const localHistory = getReportHistory();
            const localIds = new Set(localHistory.map(h => h.id));
            let updated = false;
            data.history.forEach(item => {
                if (!localIds.has(item.id)) {
                    localHistory.push(item);
                    updated = true;
                }
            });
            if (updated) {
                localHistory.sort((a, b) => {
                    const timeA = new Date(a.time || 0).getTime();
                    const timeB = new Date(b.time || 0).getTime();
                    return timeB - timeA;
                });
                if (localHistory.length > 50) localHistory.splice(50);
                localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(localHistory));
                renderHistoryDrawer();
            }
        }
    })
    .catch(err => console.error('[syncReportHistoryFromBackend] 同步失败:', err));
}

function closeHistoryDrawer() {
    document.getElementById('historyDrawer').classList.remove('open');
    document.getElementById('historyDrawerOverlay').classList.remove('visible');
}

function initHistoryDrawer() {
    const archiveBtn = document.getElementById('historyArchiveBtn');
    const closeBtn = document.getElementById('historyDrawerClose');
    const overlay = document.getElementById('historyDrawerOverlay');
    if (archiveBtn) archiveBtn.addEventListener('click', openHistoryDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeHistoryDrawer);
    if (overlay) overlay.addEventListener('click', closeHistoryDrawer);
}

// 初始化论坛功能
function initializeForum() {
    // 初始化时加载一次论坛日志
    refreshForumMessages();
    attachForumScrollHandler();
}

// 加载论坛日志
let forumLogPosition = 0;  // 记录已接收的日志位置

function loadForumLog() {
    // 【优化】使用历史API获取完整日志
    fetch('/api/forum/log/history', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            position: 0,  // 从头开始获取所有历史
            max_lines: 5000  // 获取最近5000行历史
        })
    })
    .then(response => response.json())
    .then(data => {
        // 【FIX Bug #5】检查是否仍然在forum页面
        if (currentApp !== 'forum') {
            console.log('忽略forum日志响应（已切换到其他app）');
            return;
        }

        if (!data.success) {
            // 加载失败，显示错误
            const renderer = logRenderers['forum'];
            if (renderer) {
                renderer.clear('[错误] 加载Forum日志失败');
                renderer.render();
            }
            return;
        }

        const logLines = data.log_lines || [];
        forumLogPosition = data.position || 0;  // 记录当前位置

        // 清空并重新加载日志
        if (logLines.length > 0) {
            clearConsoleLayer('forum', '[系统] 论坛引擎 历史日志');
            logRenderers['forum'].render(); // 立即渲染清空提示

            // 批量添加历史日志，避免卡顿
            const batchSize = 100;
            let index = 0;

            function addBatch() {
                const batch = logLines.slice(index, index + batchSize);
                batch.forEach(line => appendConsoleTextLine('forum', line));
                index += batchSize;

                if (index < logLines.length && currentApp === 'forum') {
                    requestAnimationFrame(addBatch);
                }
            }

            addBatch();
        } else {
            clearConsoleLayer('forum', '[系统] 论坛引擎 暂无日志');
        }

        // 同时获取解析的消息（用于聊天区域）
        fetch('/api/forum/log')
        .then(response => response.json())
        .then(data => {
            if (!data.success) return;

            const parsedMessages = data.parsed_messages || [];
            applyForumMessages(parsedMessages, { reset: true });
            forumLogLineCount = data.log_lines ? data.log_lines.length : 0;
        });
    })
    .catch(error => {
        console.error('加载论坛历史日志失败:', error);
        // 【优化】显示错误提示
        if (currentApp === 'forum') {
            const renderer = logRenderers['forum'];
            if (renderer) {
                renderer.clear('[错误] 加载Forum历史日志失败: ' + error.message);
                renderer.render();
            }
        }
    });
}

// 刷新论坛日志
function refreshForumLog() {
    fetch('/api/forum/log')
    .then(response => response.json())
    .then(data => {
        if (!data.success) return;

        const logLines = data.log_lines || [];
        const parsedMessages = data.parsed_messages || [];
        const logShrunk = logLines.length < forumLogLineCount || parsedMessages.length < forumMessagesCache.length;

        if (logLines.length > forumLogLineCount) {
            const newLines = logLines.slice(forumLogLineCount);
            newLines.forEach(line => appendConsoleTextLine('forum', line));
        }

        applyForumMessages(parsedMessages, { reset: logShrunk });

        forumLogLineCount = logLines.length;
    })
    .catch(error => {
        console.error('刷新论坛日志失败:', error);
    });
}

function getForumMessageCount() {
    const chatArea = document.getElementById('forumChatArea');
    if (!chatArea) return 0;
    return chatArea.querySelectorAll('.forum-message').length;
}

// 刷新Report Engine日志
// 检查Report Engine锁定状态并自动生成报告
let autoGenerateTriggered = false; // 防止重复触发

function checkReportLockStatus() {
    fetch('/api/report/status')
    .then(response => response.json())
    .then(data => {
        const reportButton = document.querySelector('[data-app="report"]');

        if (data.success && data.engines_ready) {
            // 文件准备就绪，解锁按钮
            reportButton.classList.remove('locked');
            reportButton.title = '报告引擎 - 智能报告生成\n所有引擎都有新文件，可以生成报告';

            // 检查是否已经有报告在显示
            const reportPreview = document.getElementById('reportPreview');
            const hasReport = reportPreview && reportPreview.querySelector('iframe');

            // 如果当前在report页面且还没有触发自动生成且没有正在进行的任务且没有已显示的报告，则自动生成报告
            if (currentApp === 'report' && !autoGenerateTriggered && !reportTaskId && !hasReport) {
                autoGenerateTriggered = true;
                console.log('检测到锁消失且无现有报告，自动开始生成报告');
                setTimeout(() => {
                    generateReport();
                }, 1000); // 延迟1秒开始生成
            }
        } else {
            // 文件未准备就绪，锁定按钮
            reportButton.classList.add('locked');

            // 构建详细的提示信息
            let titleInfo = '\n';

            if (data.missing_files && data.missing_files.length > 0) {
                titleInfo += '等待新文件:\n' + data.missing_files.join('\n');
            } else {
                titleInfo += '等待三个Agent工作完毕';
            }

            reportButton.title = titleInfo;
        }
    })
    .catch(error => {
        console.error('检查Report Engine状态失败:', error);
        // 出错时默认锁定
        const reportButton = document.querySelector('[data-app="report"]');
        reportButton.classList.add('locked');
        reportButton.title = '报告引擎状态检查失败';
    });
}

// 【重构】刷新Report日志（使用新的日志管理器）
function refreshReportLog() {
    // 兼容旧代码：直接调用日志管理器的刷新
    if (reportLogManager && reportLogManager.isRunning) {
        reportLogManager.refresh();
    } else {
        console.log('[RefreshReportLog] 日志管理器未运行，跳过刷新');
    }
}

// 加载Report Engine日志（初始化时使用）
function loadReportLog() {
    // 使用新的日志管理器
    if (!reportLogManager.isRunning) {
        // 清空控制台
        clearConsoleLayer('report', '[系统] 报告引擎 日志监控已启动');

        // 重置计数器并启动
        reportLogManager.reset();
        reportLogManager.start();
    } else {
        // 如果已经在运行，只是刷新一次
        reportLogManager.refresh();
    }
}

// 解析论坛消息并添加到对话区
function parseForumMessage(logLine) {
    try {
        // 解析日志行格式: [HH:MM:SS] [SOURCE] content
        const timeMatch = logLine.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
        if (!timeMatch) return null;

        const timestamp = timeMatch[1];
        const restContent = logLine.substring(timeMatch[0].length).trim();

        // 解析源标签
        const sourceMatch = restContent.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (!sourceMatch) return null;

        const source = sourceMatch[1];
        const content = sourceMatch[2];

        // 处理四种消息类型：三个Engine和HOST，过滤掉系统消息和空内容
        if (!['QUERY', 'INSIGHT', 'MEDIA', 'HOST'].includes(source.toUpperCase()) || 
            !content || content.includes('=== ForumEngine')) {
            return null;
        }

        // 根据源类型确定消息类型
        let messageType = 'agent';
        let displayName = '';

        switch(source.toUpperCase()) {
            case 'INSIGHT':
                displayName = '洞察引擎';
                break;
            case 'MEDIA':
                displayName = '媒体引擎';
                break;
            case 'QUERY':
                displayName = '搜索引擎';
                break;
            case 'HOST':
                messageType = 'host';
                displayName = '论坛主持人';
                break;
        }

        // 处理内容中的转义字符
        const displayContent = content.replace(/\\n/g, '\n').replace(/\\r/g, '');

        // 返回解析后的消息对象
        return {
            type: messageType,
            source: displayName,
            content: displayContent,
            timestamp: timestamp
        };

    } catch (error) {
        console.error('解析论坛消息失败:', error);
        return null;
    }
}

// 添加论坛消息到对话区
function addForumMessage(data, options = {}) {
    const { prepend = false, suppressScroll = false } = options;
    const chatArea = document.getElementById('forumChatArea');
    if (!chatArea) return;
    const messageDiv = document.createElement('div');

    const messageType = data.type || 'system';
    messageDiv.className = `forum-message ${messageType}`;

    // 根据来源添加特定的CSS类用于颜色区分
    if (data.source) {
        const sourceClass = data.source.toLowerCase().replace(/\s+/g, '-');
        messageDiv.classList.add(sourceClass);

        // 添加具体的engine类
        if (data.source.toLowerCase().includes('query')) {
            messageDiv.classList.add('query-engine');
        } else if (data.source.toLowerCase().includes('insight')) {
            messageDiv.classList.add('insight-engine');
        } else if (data.source.toLowerCase().includes('media')) {
            messageDiv.classList.add('media-engine');
        } else if (data.source.toLowerCase().includes('host')) {
            messageDiv.classList.add('host');
        }
    }

    // 构建消息头部，显示来源名称
    const headerText = data.sender || data.source || getMessageHeader(messageType);

    messageDiv.innerHTML = `
        <div class="forum-message-header">${headerText}</div>
        <div class="forum-message-content">${formatMessageContent(data.content)}</div>
        <div class="forum-timestamp">${data.timestamp || new Date().toLocaleTimeString('zh-CN')}</div>
    `;

    if (prepend && chatArea.firstChild) {
        chatArea.insertBefore(messageDiv, chatArea.firstChild);
    } else {
        chatArea.appendChild(messageDiv);
    }

    // 自动滚动到底部（除非用户正在浏览历史）
    if (!suppressScroll && forumAutoScrollEnabled) {
        scrollForumViewToBottom();
    }
}

function scrollForumViewToBottom(force = false) {
    const renderer = logRenderers['forum'];
    if (renderer) {
        requestAnimationFrame(() => renderer.scrollToBottom());
    }

    if (force) {
        forumAutoScrollEnabled = true;
    } else if (!forumAutoScrollEnabled) {
        return;
    }

    const chatArea = document.getElementById('forumChatArea');
    if (chatArea) {
        requestAnimationFrame(() => {
            chatArea.scrollTop = chatArea.scrollHeight;
        });
    }
}

function scrollReportViewToBottom() {
    const renderer = logRenderers['report'];
    if (renderer) {
        requestAnimationFrame(() => renderer.scrollToBottom());
    }
}

// 格式化消息内容
function formatMessageContent(content) {
    if (!content) return '';

    // 将换行符转换为HTML换行
    return content.replace(/\n/g, '<br>');
}

// 获取消息头部
function getMessageHeader(type) {
    switch(type) {
        case 'user': return '用户';
        case 'agent': return 'AI助手';
        case 'system': return '系统';
        case 'host': return '论坛主持人';
        default: return '未知';
    }
}

// Report Engine 相关函数
let reportTaskId = null;
let reportPollingInterval = null;
let reportEventSource = null;
let reportLogRefreshInterval = null; // 日志刷新定时器
let reportAutoPreviewLoaded = false;
let reportStreamReconnectTimer = null;
let reportStreamRetryDelay = 3000;
let streamHeartbeatTimeout = null;
let streamHeartbeatInterval = null;
let connectionProbeTimer = null;
const CONNECTION_PROBE_INTERVAL = 15000;

// 加载报告界面
function loadReportInterface() {
    const reportContent = document.getElementById('reportContent');

    // 检查ReportEngine状态
    fetch('/api/report/status')
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // 更新ReportEngine状态指示器
            const indicator = document.getElementById('status-report');
            if (indicator) {
                if (data.initialized) {
                    indicator.className = 'status-indicator running';
                    appStatus.report = 'running';
                } else {
                    indicator.className = 'status-indicator';
                    appStatus.report = 'stopped';
                }
            }

            // 渲染报告界面
            renderReportInterface(data);

            // 【修复】加载Report界面时启动日志刷新
            if (currentApp === 'report') {
                reportLogManager.start();
            }
        } else {
            reportContent.innerHTML = `
                <div class="report-status error">
                    <strong>错误:</strong> ${data.error}
                </div>
            `;
        }
    })
    .catch(error => {
        console.error('加载报告界面失败:', error);
        reportContent.innerHTML = `
            <div class="report-status error">
                <strong>加载失败:</strong> ${error.message}
            </div>
        `;
    });
}

// 渲染报告界面
function renderReportInterface(statusData) {
    const reportContent = document.getElementById('reportContent');

    let interfaceHTML = `
        <!-- 固定的状态信息块 -->
        <div class="engine-status-info" id="engineStatusBlock">
            <div class="report-status" id="engineStatusContent">
                <div>正在初始化...</div>
            </div>
        </div>

        <!-- 控制按钮区域 -->
        <div class="report-controls">
            <button class="report-button primary" id="generateReportButton">生成最终报告</button>
            <div class="report-download-group">
                <button class="report-button" id="downloadReportButton" disabled>下载HTML</button>
                <button class="report-button" id="downloadPdfButton" disabled>下载PDF</button>
                <button class="report-button" id="downloadMdButton" disabled>下载MD</button>
            </div>
        </div>

        <!-- 任务进度区域 -->
        <div id="taskProgressArea"></div>

        <!-- 报告预览区域 -->
        <div class="report-preview" id="reportPreview">
            <div class="report-loading">
                点击"生成最终报告"开始生成综合分析报告
            </div>
        </div>
    `;

    reportContent.innerHTML = interfaceHTML;
    initializeReportControls();
    resetReportStreamOutput('等待新的Report任务启动...');
    updateReportStreamStatus('idle');

    // 立即更新状态信息
    updateEngineStatusDisplay(statusData);

    // 如果有当前任务，显示任务状态
    if (statusData.current_task) {
        updateTaskProgressStatus(statusData.current_task);
        if (statusData.current_task.status === 'running') {
            const taskId = statusData.current_task.task_id;
            resetReportLogsForNewTask(taskId, '检测到正在运行的报告任务，日志已重新开始');
            reportTaskId = taskId;
            reportAutoPreviewLoaded = false;
            startProgressPolling(taskId);
            if (window.EventSource) {
                openReportStream(reportTaskId);
            } else {
                appendReportStreamLine('浏览器不支持SSE，已切换为轮询模式', 'warn', { badge: 'SSE', force: true });
            }
        } else if (statusData.current_task.status === 'completed') {
            lastCompletedReportTask = statusData.current_task;
            updateDownloadButtonState(statusData.current_task);
        }
    } else {
        updateDownloadButtonState(null);
        safeCloseReportStream();
        reportTaskId = null;
    }
}

function initializeReportControls() {
    const generateButton = document.getElementById('generateReportButton');
    if (generateButton && !generateButton.dataset.bound) {
        generateButton.dataset.bound = 'true';
        generateButton.addEventListener('click', () => {
            if (reportTaskId) {
                showMessage('已有报告生成任务在运行', 'info');
                return;
            }
            const reportButton = document.querySelector('[data-app="report"]');
            if (reportButton && reportButton.classList.contains('locked')) {
                showMessage('需等待三个Agent完成最新分析后才能生成最终报告', 'error');
                return;
            }
            generateReport();
        });
    }

    const downloadButton = document.getElementById('downloadReportButton');
    const downloadPdfButton = document.getElementById('downloadPdfButton');
    const downloadMdButton = document.getElementById('downloadMdButton');
    if (downloadButton && !downloadButton.dataset.bound) {
        downloadButton.dataset.bound = 'true';
        downloadButton.addEventListener('click', () => downloadReport());
    }
    if (downloadPdfButton && !downloadPdfButton.dataset.bound) {
        downloadPdfButton.dataset.bound = 'true';
        downloadPdfButton.addEventListener('click', () => downloadPdfFromPreview());
    }
    if (downloadMdButton && !downloadMdButton.dataset.bound) {
        downloadMdButton.dataset.bound = 'true';
        downloadMdButton.addEventListener('click', () => downloadMarkdownFromIr());
    }

    if (reportTaskId) {
        setGenerateButtonState(true);
    } else {
        setGenerateButtonState(false);
    }

    if (lastCompletedReportTask) {
        updateDownloadButtonState(lastCompletedReportTask);
    }
}

function setGenerateButtonState(forceLoading = false) {
    const generateButton = document.getElementById('generateReportButton');
    if (!generateButton) return;

    if (forceLoading || reportTaskId) {
        if (!generateButton.dataset.originalText) {
            generateButton.dataset.originalText = generateButton.textContent || '生成最终报告';
        }
        generateButton.disabled = true;
        generateButton.textContent = '生成中...';
    } else {
        const originalText = generateButton.dataset.originalText || '生成最终报告';
        generateButton.disabled = false;
        generateButton.textContent = originalText;
    }
}

function updateDownloadButtonState(task) {
    const downloadButton = document.getElementById('downloadReportButton');
    const downloadPdfButton = document.getElementById('downloadPdfButton');
    const downloadMdButton = document.getElementById('downloadMdButton');
    if (!downloadButton || !downloadPdfButton || !downloadMdButton) return;

    const htmlReady = task && task.status === 'completed' && (
        task.report_file_ready ||
        task.report_file_path ||
        task.has_result // 有内容即可允许尝试下载/预览
    );
    const irReady = task && task.status === 'completed' && (
        task.ir_file_ready ||
        task.ir_file_path
    );
    const pdfReady = !!irReady;
    const mdReady = !!irReady;

    if (htmlReady) {
        downloadButton.disabled = false;
        downloadButton.dataset.taskId = task.task_id;
        downloadButton.dataset.filename = task.report_file_name || '';
        const label = task.report_file_name ? `下载HTML (${task.report_file_name})` : '下载HTML';
        downloadButton.textContent = label;
        downloadPdfButton.disabled = !pdfReady;
        downloadPdfButton.dataset.taskId = task.task_id;
        downloadMdButton.disabled = !mdReady;
        downloadMdButton.dataset.taskId = task.task_id;
        downloadMdButton.dataset.filename = task.markdown_file_name || '';
        lastCompletedReportTask = task;
    } else if (!lastCompletedReportTask || (task && task.status !== 'completed')) {
        downloadButton.disabled = true;
        downloadButton.dataset.taskId = '';
        downloadButton.dataset.filename = '';
        downloadButton.textContent = '下载HTML';
        downloadPdfButton.disabled = true;
        downloadPdfButton.dataset.taskId = '';
        downloadMdButton.disabled = true;
        downloadMdButton.dataset.taskId = '';
        downloadMdButton.dataset.filename = '';
        if (!reportTaskId) {
            lastCompletedReportTask = null;
        }
    }
}

function downloadReport(taskId = null) {
    const downloadButton = document.getElementById('downloadReportButton');
    const targetTaskId = taskId || (downloadButton ? downloadButton.dataset.taskId : '');

    if (!targetTaskId) {
        showMessage('暂无可下载的报告，请先生成最终报告', 'error');
        return;
    }

    let preferredFileName = '';
    if (downloadButton && downloadButton.dataset.filename) {
        preferredFileName = downloadButton.dataset.filename;
    } else if (lastCompletedReportTask && lastCompletedReportTask.task_id === targetTaskId) {
        preferredFileName = lastCompletedReportTask.report_file_name || '';
    }

    fetch(`/api/report/download/${targetTaskId}`)
    .then(response => {
        if (!response.ok) {
            const contentType = response.headers.get('Content-Type') || '';
            if (contentType.includes('application/json')) {
                return response.json().then(err => {
                    throw new Error(err.error || '下载失败');
                });
            }
            throw new Error('下载失败');
        }
        const disposition = response.headers.get('Content-Disposition') || '';
        return response.blob().then(blob => ({ blob, disposition }));
    })
    .then(({ blob, disposition }) => {
        let filename = preferredFileName;
        if (!filename) {
            const match = disposition.match(/filename="?([^";]+)"?/i);
            filename = match ? match[1] : `final_report_${targetTaskId}.html`;
        }

        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || 'final_report.html';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        showMessage('报告文件已开始下载', 'success');
    })
    .catch(error => {
        console.error('下载报告失败:', error);
        showMessage('下载报告失败: ' + error.message, 'error');
    });
}

async function downloadPdfFromPreview(taskIdFromCaller = null) {
    const btn = document.getElementById('downloadPdfButton');
    const taskId = taskIdFromCaller || btn?.dataset.taskId || lastCompletedReportTask?.task_id;

    if (!taskId) {
        showMessage('无可用的报告任务，请先生成报告', 'error');
        return;
    }

    if (btn) btn.disabled = true;
    showMessage('正在生成优化的PDF，请稍候...', 'info');

    try {
        // 调用后端PDF导出API
        const response = await fetch(`/api/report/export/pdf/${taskId}?optimize=true`, {
            method: 'GET'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'PDF导出失败');
        }

        // 获取PDF文件名（从响应头）
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'report.pdf';
        if (contentDisposition) {
            const matches = /filename="?([^"]+)"?/.exec(contentDisposition);
            if (matches && matches[1]) {
                filename = matches[1];
            }
        }

        // 下载PDF
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);

        showMessage('PDF生成完成，已开始下载', 'success');
    } catch (err) {
        console.error('导出PDF失败:', err);
        showMessage('导出PDF失败: ' + err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 前端 PDF 导出（html2canvas + jsPDF，不依赖后端 WeasyPrint）
async function exportPdfFromIframe(taskId) {
    const dlBtn = document.getElementById('immersiveDownloadBtn');
    if (dlBtn) {
        dlBtn.disabled = true;
        dlBtn.querySelector('span').textContent = '导出中...';
    }

    try {
        // 优先尝试后端导出
        const resp = await fetch(`/api/report/export/pdf/${taskId}?optimize=true`);
        if (resp.ok) {
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const cd = resp.headers.get('Content-Disposition') || '';
            const m = /filename="?([^"]+)"?/.exec(cd);
            a.download = m ? m[1] : 'report.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showMessage('PDF下载完成', 'success');
            return;
        }
    } catch (e) {
        console.log('[exportPdf] 后端导出不可用，使用前端方案');
    }

    // 前端方案：html2canvas + jsPDF
    try {
        const iframe = document.getElementById('report-iframe');
        if (!iframe || !iframe.contentWindow) {
            showMessage('报告未加载完成', 'error');
            return;
        }

        showMessage('正在生成PDF，请稍候（大报告可能需要30秒）...', 'info');

        const iframeBody = iframe.contentWindow.document.body;
        const canvas = await html2canvas(iframeBody, {
            scale: 2,
            useCORS: true,
            logging: false,
            width: iframeBody.scrollWidth,
            height: iframeBody.scrollHeight,
            windowWidth: iframeBody.scrollWidth,
            windowHeight: iframeBody.scrollHeight
        });

        const imgData = canvas.toDataURL('image/jpeg', 0.92);
        const imgWidth = canvas.width;
        const imgHeight = canvas.height;

        // A4 尺寸 (mm)
        const pdfWidth = 210;
        const pdfHeight = 297;
        const ratio = pdfWidth / imgWidth;
        const scaledHeight = imgHeight * ratio;

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');

        let yOffset = 0;
        let page = 0;
        while (yOffset < scaledHeight) {
            if (page > 0) pdf.addPage();
            pdf.addImage(imgData, 'JPEG', 0, -yOffset, pdfWidth, scaledHeight);
            yOffset += pdfHeight;
            page++;
        }

        pdf.save('舆情分析报告.pdf');
        showMessage('PDF生成完成，已开始下载', 'success');
    } catch (err) {
        console.error('[exportPdf] 前端导出失败:', err);
        showMessage('PDF导出失败: ' + err.message, 'error');
    } finally {
        if (dlBtn) {
            dlBtn.disabled = false;
            dlBtn.querySelector('span').textContent = '下载PDF';
        }
    }
}

async function downloadMarkdownFromIr(taskIdFromCaller = null) {
    const btn = document.getElementById('downloadMdButton');
    const taskId = taskIdFromCaller || btn?.dataset.taskId || lastCompletedReportTask?.task_id;

    if (!taskId) {
        showMessage('无可用的报告任务，请先生成报告', 'error');
        return;
    }

    if (btn) btn.disabled = true;
    showMessage('正在生成Markdown，请稍候...', 'info');

    try {
        const response = await fetch(`/api/report/export/md/${taskId}`, { method: 'GET' });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Markdown导出失败');
        }

        const contentDisposition = response.headers.get('Content-Disposition') || '';
        let filename = 'report.md';
        const matches = /filename=\"?([^\";]+)\"?/i.exec(contentDisposition);
        if (matches && matches[1]) {
            filename = matches[1];
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);

        showMessage('Markdown 导出完成，已开始下载', 'success');
    } catch (err) {
        console.error('导出Markdown失败:', err);
        showMessage('导出Markdown失败: ' + err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 渲染任务状态（使用新的进度条样式）
function renderTaskStatus(task) {
    // 状态文本的中文映射
    const statusText = {
        'running': '正在生成',
        'completed': '已完成',
        'error': '生成失败',
        'pending': '等待中'
    };

    // 状态徽章样式
    const statusBadgeClass = {
        'running': 'task-status-running',
        'completed': 'task-status-completed',
        'error': 'task-status-error',
        'pending': 'task-status-running'
    };

    const htmlReady = task.status === 'completed' && (task.report_file_ready || task.report_file_path || task.has_result);
    const irReady = task.status === 'completed' && (task.ir_file_ready || task.ir_file_path);

    // 为运行状态添加加载指示器
    const loadingIndicator = task.status !== 'completed' && task.status !== 'error' 
        ? '<span class="report-loading-spinner"></span>' 
        : '';

    let statusHTML = `
        <div class="task-progress-container">
            <div class="task-progress-header">
                <div class="task-progress-title">
                    ${loadingIndicator}报告生成任务
                </div>
                <div class="task-progress-bar">
                    <div class="task-progress-fill" style="width: ${Math.min(Math.max(task.progress || 0, 0), 100)}%"></div>
                    <div class="task-progress-text">${task.progress || 0}%</div>
                </div>
            </div>

            <div class="task-info-line">
                <div class="task-info-item">
                    <span class="task-info-label">任务ID:</span>
                    <span class="task-info-value">${task.task_id}</span>
                </div>
                <div class="task-info-item">
                    <span class="task-info-label">查询内容:</span>
                    <span class="task-info-value">${task.query}</span>
                </div>
                <div class="task-info-item">
                    <span class="task-info-label">开始时间:</span>
                    <span class="task-info-value">${new Date(task.created_at).toLocaleString()}</span>
                </div>
                <div class="task-info-item">
                    <span class="task-info-label">更新时间:</span>
                    <span class="task-info-value">${new Date(task.updated_at).toLocaleString()}</span>
                </div>
            </div>
    `;

    if (task.report_file_path) {
        statusHTML += `
            <div class="task-info-line">
                <div class="task-info-item">
                    <span class="task-info-label">保存路径:</span>
                    <span class="task-info-value">${task.report_file_path}</span>
                </div>
            </div>
        `;
    }

    if (task.error_message) {
        statusHTML += `
            <div class="task-error-message">
                <strong>错误信息:</strong> ${task.error_message}
            </div>
        `;
    }

    if (task.status === 'completed') {
        statusHTML += `
            <div class="task-actions">
                <button class="report-button primary" onclick="viewReport('${task.task_id}')">重新加载</button>
            </div>
        `;
    }

    statusHTML += '</div>';
    return statusHTML;
}

// 生成报告
function generateReport() {
    if (reportTaskId) {
        showMessage('已有报告生成任务在运行', 'info');
        return;
    }

    const reportButton = document.querySelector('[data-app="report"]');
    if (reportButton && reportButton.classList.contains('locked')) {
        showMessage('需等待三个Agent完成最新分析后才能生成最终报告', 'error');
        return;
    }

    const query = document.getElementById('searchInput').value.trim() || '智能舆情分析报告';

    // 【修复】先停止现有的日志轮询，避免与后端清空日志的竞态条件
    reportLogManager.stop();

    reportAutoPreviewLoaded = false;
    safeCloseReportStream(true);

    // 清空控制台显示
    clearConsoleLayer('report', '[系统] 开始生成报告，日志已重置');
    resetReportStreamOutput('报告引擎正在调度任务...');

    setGenerateButtonState(true);

    // 在现有状态信息后添加任务进度状态，而不是替换
    addTaskProgressStatus('正在启动报告生成任务...', 'loading');

    // 构建请求数据，包含自定义模板（如果有的话）
    const requestData = { query: query };
    if (customTemplate && customTemplate.trim()) {
        requestData.custom_template = customTemplate;
        console.log('使用自定义模板生成报告');
    }

    fetch('/api/report/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            reportTaskId = data.task_id;
            showMessage('报告生成已启动', 'success');

            // 更新任务状态显示
            updateTaskProgressStatus({
                task_id: data.task_id,
                query: query,
                status: 'running',
                progress: 5, // 初始进度设为5%，确保进度条可见
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            appendReportStreamLine('任务创建成功，正在建立流式连接...', 'info', { force: true });

            // 【修复】在API成功后重置计数器，此时后端已清空日志文件
            // 避免在API调用期间旧interval读取旧日志导致的竞态条件
            reportLogManager.reset();

            // 【优化】启动日志轮询
            // 确保从任务开始就能读取日志
            reportLogManager.start();

            // 【兜底】立即启动进度轮询，SSE连上后会自动停止
            startProgressPolling(reportTaskId);

            if (window.EventSource) {
                openReportStream(reportTaskId);
            } else {
                appendReportStreamLine('浏览器不支持SSE，已切换为轮询模式', 'warn', { badge: 'SSE', force: true });
            }
        } else {
            updateTaskProgressStatus(null, 'error', '启动失败: ' + data.error);
            // 重置标志允许重新尝试
            autoGenerateTriggered = false;
            reportTaskId = null;
            setGenerateButtonState(false);
            appendReportStreamLine('任务启动失败: ' + (data.error || '未知错误'), 'error');
            updateReportStreamStatus('error');
            safeCloseReportStream();
        }
    })
    .catch(error => {
        console.error('生成报告失败:', error);
        updateTaskProgressStatus(null, 'error', '生成报告失败: ' + error.message);
        // 重置标志允许重新尝试
        autoGenerateTriggered = false;
        reportTaskId = null;
        setGenerateButtonState(false);
        appendReportStreamLine('任务启动阶段异常: ' + error.message, 'error');
        updateReportStreamStatus('error');
        safeCloseReportStream();
    });
}

// 【修复】启动Report Engine日志实时刷新
// 【新函数】使用新的日志管理器
// 旧的startReportLogRefresh和stopReportLogRefresh已废弃，请使用reportLogManager

// 开始/停止进度轮询（SSE不可用或断开时兜底使用）
function stopProgressPolling() {
    if (reportPollingInterval) {
        clearInterval(reportPollingInterval);
        reportPollingInterval = null;
    }
}

function startProgressPolling(taskId) {
    if (!taskId) return;
    stopProgressPolling();
    // 先立即拉取一次，避免长时间停留在5%
    checkTaskProgress(taskId);
    reportPollingInterval = setInterval(() => {
        checkTaskProgress(taskId);
    }, 2000);
}

// 检查任务进度
function checkTaskProgress(taskId) {
    fetch(`/api/report/progress/${taskId}`)
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            updateProgressDisplay(data.task);

            // 在检查进度时也刷新日志（使用新的日志管理器）
            // reportLogManager会自动处理轮询

            if (data.task.status === 'completed') {
                stopProgressPolling();
                showMessage('报告生成完成！', 'success');

                // 自动显示报告
                viewReport(taskId);
                reportAutoPreviewLoaded = true;

                // 重置自动生成标志，允许下次有新内容时自动生成
                autoGenerateTriggered = false;
                reportTaskId = null;
                setGenerateButtonState(false);
            } else if (data.task.status === 'error') {
                stopProgressPolling();
                showMessage('报告生成失败: ' + data.task.error_message, 'error');

                // 重置自动生成标志，允许重新尝试
                autoGenerateTriggered = false;
                reportTaskId = null;
                setGenerateButtonState(false);
            }
        }
    })
    .catch(error => {
        console.error('检查进度失败:', error);
    });
}

// 添加任务进度状态（使用固定区域）
function addTaskProgressStatus(message, status) {
    const taskArea = document.getElementById('taskProgressArea');

    if (taskArea) {
        const loadingIndicator = status === 'loading' ? '<span class="report-loading-spinner"></span>' : '';

        taskArea.innerHTML = `
            <div class="task-progress-container">
                <div class="task-progress-header">
                    ${loadingIndicator}任务状态: ${message}
                </div>
            </div>
        `;
    }
}

// 更新任务进度状态（使用固定区域）
function updateTaskProgressStatus(task, status = null, errorMessage = null) {
    const taskArea = document.getElementById('taskProgressArea');

    if (!taskArea) {
        console.error('taskProgressArea not found');
        return;
    }

    if (task) {
        taskArea.innerHTML = renderTaskStatus(task);
        if (task.status === 'completed') {
            lastCompletedReportTask = task;
        } else if (task.status === 'running') {
            lastCompletedReportTask = null;
        }
        updateDownloadButtonState(task);
    } else if (status && errorMessage) {
        const loadingIndicator = status === 'loading' ? '<span class="report-loading-spinner"></span>' : '';
        const statusBadgeClass = status === 'error' ? 'task-status-error' : 'task-status-running';
        const statusText = status === 'error' ? '错误' : '处理中';

        taskArea.innerHTML = `
            <div class="task-progress-container">
                <div class="task-progress-header">
                    ${loadingIndicator}任务状态: ${statusText}
                </div>
                <div style="margin-top: 10px; font-size: 14px;">
                    ${errorMessage}
                </div>
            </div>
        `;
    }
}

// 更新进度显示（保持向后兼容）
function updateProgressDisplay(task) {
    if (task && task.task_id && task.status === 'running') {
        resetReportLogsForNewTask(task.task_id, '检测到新的报告任务，日志已同步重置');
    }
    updateTaskProgressStatus(task);
}

// ====== Report Engine SSE流式辅助函数 ======
// 重置流式日志入口，将提示语写入控制台，保持与右侧黑框一致
function resetReportStreamOutput(message = '等待新的Report任务启动...') {
    appendReportStreamLine(message, 'info', { badge: 'REPORT', force: true });
}

// 根据状态同步流式指示灯，与后端心跳保持一致
function updateReportStreamStatus(state) {
    if (state === 'connected') {
        reportStreamConnected = true;
    } else if (['idle', 'error', 'connecting', 'reconnecting'].includes(state)) {
        reportStreamConnected = false;
    }

    const statusEl = document.getElementById('reportStreamStatus');
    if (statusEl) {
        const textMap = {
            idle: '未连接',
            connecting: '连接中',
            connected: '实时更新中',
            reconnecting: '等待重连',
            error: '已断开'
        };
        statusEl.textContent = textMap[state] || state;
        statusEl.dataset.state = state;
    }

    refreshConnectionStatus();
}

// 往黑色控制台输出区域追加一条流式日志
function appendReportStreamLine(message, level = 'info', options = {}) {
    if (level === 'chunk' && !options.force) {
        return; // 章节内容流式写入不再逐条输出
    }

    // 格式化时间戳
    const timestamp = new Date().toLocaleTimeString('zh-CN');

    // 构建文本内容而不是 DOM 元素
    let textContent = `[${timestamp}]`;
    if (options.badge) {
        textContent += ` [${options.badge}]`;
    }
    textContent += ` ${message}`;

    // 使用统一的文本添加方法，避免直接操作 DOM
    appendConsoleTextLine('report', textContent, `console-line report-stream-line ${level}`);
}

function startStreamHeartbeat() {
    clearStreamHeartbeat();
    const emitHeartbeat = () => {
        appendReportStreamLine('报告引擎正在流式生成，请耐心等待...', 'info', { badge: 'REPORT', force: true });
    };

    const scheduleFirstTick = () => {
        const now = Date.now();
        const msToNextMinute = 60000 - (now % 60000);
        streamHeartbeatTimeout = setTimeout(() => {
            emitHeartbeat();
            streamHeartbeatInterval = setInterval(emitHeartbeat, 60000);
        }, msToNextMinute);
    };

    scheduleFirstTick();
}

function clearStreamHeartbeat() {
    if (streamHeartbeatTimeout) {
        clearTimeout(streamHeartbeatTimeout);
        streamHeartbeatTimeout = null;
    }
    if (streamHeartbeatInterval) {
        clearInterval(streamHeartbeatInterval);
        streamHeartbeatInterval = null;
    }
}

// 建立SSE连接，实时订阅Report Engine推送
function openReportStream(taskId, isRetry = false) {
    if (!taskId) return;
    if (!window.EventSource) {
        appendReportStreamLine('浏览器不支持SSE，已自动回退为轮询模式', 'warn', { badge: 'SSE', force: true });
        updateReportStreamStatus('error');
        clearStreamHeartbeat();
        startProgressPolling(taskId);
        return;
    }
    if (reportEventSource && reportEventSource.__taskId === taskId) {
        if (reportEventSource.readyState !== EventSource.CLOSED) {
            return;
        }
        safeCloseReportStream(true, true);
    } else if (reportEventSource) {
        safeCloseReportStream(true, true);
    }

    if (reportStreamReconnectTimer) {
        clearTimeout(reportStreamReconnectTimer);
        reportStreamReconnectTimer = null;
    }

    if (!isRetry) {
        reportStreamRetryDelay = 3000;
    }

    updateReportStreamStatus('connecting');
    appendReportStreamLine(
        isRetry ? '尝试重连报告引擎流式通道...' : '正在建立报告引擎流式连接...',
        'info',
        { badge: 'SSE', force: true }
    );

    reportEventSource = new EventSource(`/api/report/stream/${taskId}`);
    reportEventSource.__taskId = taskId;
    reportEventSource.onopen = () => {
        reportStreamRetryDelay = 3000;
        updateReportStreamStatus('connected');
        appendReportStreamLine(isRetry ? 'SSE重连成功' : '报告引擎流式连接已建立', 'success', { badge: 'SSE' });
        reportLogStreaming = true;
        // SSE已经推送日志，关闭轮询避免重复
        reportLogManager.stop();
        reportLogManager.reset();
        startStreamHeartbeat();
    };
    reportEventSource.onerror = () => {
        appendReportStreamLine('检测到网络抖动，SSE正在等待自动重连...', 'warn', { badge: 'SSE' });
        updateReportStreamStatus('reconnecting');
        clearStreamHeartbeat();
        safeCloseReportStream(true, true);
        // SSE断开期间恢复轮询，避免日志缺口
        if (reportTaskId) {
            reportLogManager.start();
        }
        startProgressPolling(taskId);
        scheduleReportStreamReconnect(taskId);
    };

    const events = ['status', 'stage', 'chapter_status', 'chapter_chunk', 'warning', 'error', 'debug', 'html_ready', 'completed', 'heartbeat', 'log'];
    events.forEach(evt => {
        reportEventSource.addEventListener(evt, (event) => dispatchReportStreamEvent(evt, event));
    });
    reportEventSource.onmessage = (event) => dispatchReportStreamEvent(event.type || 'message', event);
}

// 关闭SSE连接，可根据场景选择是否立即重置指示灯
function safeCloseReportStream(keepIndicator = false, preserveRetryDelay = false) {
    if (reportEventSource) {
        reportEventSource.close();
        reportEventSource = null;
    }
    reportLogStreaming = false;
    if (reportStreamReconnectTimer) {
        clearTimeout(reportStreamReconnectTimer);
        reportStreamReconnectTimer = null;
    }
    // 清除日志刷新（使用新的日志管理器）
    reportLogManager.stop();

    clearStreamHeartbeat();
    if (!keepIndicator) {
        updateReportStreamStatus('idle');
    } else {
        reportStreamConnected = false;
        refreshConnectionStatus();
    }
    if (!preserveRetryDelay) {
        reportStreamRetryDelay = 3000;
    }
}

function scheduleReportStreamReconnect(taskId) {
    if (!taskId || reportStreamReconnectTimer) {
        return;
    }
    reportStreamReconnectTimer = setTimeout(() => {
        reportStreamReconnectTimer = null;
        if (reportTaskId === taskId) {
            openReportStream(taskId, true);
        }
    }, reportStreamRetryDelay);
    reportStreamRetryDelay = Math.min(reportStreamRetryDelay * 2, 15000);
}

// 统一的事件派发入口，负责解析JSON并交给业务处理
function dispatchReportStreamEvent(eventType, event) {
    try {
        const data = JSON.parse(event.data);
        handleReportStreamEvent(eventType, data);
    } catch (error) {
        console.warn('解析流式事件失败:', error);
    }
}

// 结合事件类型输出控件/状态，确保网络抖动时也能及时反馈
function handleReportStreamEvent(eventType, eventData) {
    if (!eventData) return;
    const payload = eventData.payload || {};
    const task = payload.task;

    if (eventType === 'status' && task) {
        if (task.status === 'running') {
            resetReportLogsForNewTask(task.task_id, '收到流式状态事件，已重置日志');
        }
        updateTaskProgressStatus(task);
        reportTaskId = task.status === 'running' ? task.task_id : null;
        if (task.status === 'completed') {
            lastCompletedReportTask = task;
            setGenerateButtonState(false);
            // 自动存档到历史记录
            const _q = document.getElementById('searchInput');
            const _title = (_q && _q.value.trim()) || task.task_id || '舆情分析报告';
            if (window.saveReportToHistory) window.saveReportToHistory(_title, task.task_id);
        } else if (task.status === 'running') {
            setGenerateButtonState(true);
        }
    }

    switch (eventType) {
        case 'stage':
            appendReportStreamLine(
                payload.message || `阶段: ${payload.stage || ''}`,
                'info',
                {
                    badge: payload.stage || '阶段',
                    genericMessage: '报告引擎正在逐步生成，请耐心等待...'
                }
            );
            break;
        case 'chapter_status':
            appendReportStreamLine(
                `${payload.title || payload.chapterId || '章节'} ${payload.status === 'completed' ? '已完成' : '生成中'}`,
                payload.status === 'completed' ? 'success' : 'info',
                {
                    badge: '章节',
                    genericMessage: payload.status === 'completed'
                        ? `${payload.title || payload.chapterId || '章节'} 已完成`
                        : '章节流式生成中，请稍候...'
                }
            );
            break;
        case 'chapter_chunk':
            if (payload.delta) {
                appendReportStreamLine(
                    formatStreamChunk(payload.delta),
                    'chunk',
                    {
                        badge: payload.title || payload.chapterId || '章节流',
                        genericMessage: '章节内容流式写入中...'
                    }
                );
            }
            break;
        case 'warning':
            appendReportStreamLine(payload.message || '检测到可重试的网络波动', 'warn', { badge: 'WARNING' });
            break;
        case 'debug':
            appendReportStreamLine(payload.message || 'Debug信息', 'info', { badge: 'DEBUG' });
            break;
        case 'log': {
            if (payload.line) {
                const level = (payload.level || '').toLowerCase();
                let levelClass = '';
                if (level === 'error' || level === 'critical') {
                    levelClass = 'error';
                } else if (level === 'warning') {
                    levelClass = 'warning';
                } else if (level === 'debug') {
                    levelClass = 'debug';
                }
                appendConsoleTextLine('report', payload.line, `console-line report-stream-line ${levelClass}`.trim());
            }
            break;
        }
        case 'html_ready':
            appendReportStreamLine('HTML渲染完成，正在刷新预览...', 'success');
            if (task) {
                updateDownloadButtonState(task);
            }
            if (eventData.task_id && !reportAutoPreviewLoaded) {
                viewReport(eventData.task_id);
                reportAutoPreviewLoaded = true;
            }
            break;
        case 'completed':
            appendReportStreamLine(payload.message || '任务完成', 'success');
            stopProgressPolling();

            // 【修复】任务完成前强制刷新最后一次日志，确保所有日志都被读取
            if (reportLogManager && reportLogManager.isRunning) {
                reportLogManager.refresh();
            }

            // 延迟500ms后关闭SSE，确保最后一次日志刷新完成
            setTimeout(() => {
                safeCloseReportStream();
            }, 500);

            reportTaskId = null;
            setGenerateButtonState(false);
            if (task) {
                lastCompletedReportTask = task;
                updateDownloadButtonState(task);
            }
            if (eventData.task_id && !reportAutoPreviewLoaded) {
                viewReport(eventData.task_id);
                reportAutoPreviewLoaded = true;
            }
            break;
        case 'cancelled':
            appendReportStreamLine(payload.message || '任务已取消', 'warn');
            stopProgressPolling();
            safeCloseReportStream();
            updateReportStreamStatus('idle');
            reportTaskId = null;
            setGenerateButtonState(false);
            break;
        case 'error':
            appendReportStreamLine(payload.message || '任务失败', 'error', { badge: 'ERROR' });
            stopProgressPolling();
            safeCloseReportStream();
            updateReportStreamStatus('error');
            reportTaskId = null;
            setGenerateButtonState(false);
            break;
        case 'heartbeat':
            // 只有在非重连状态时才更新为connected并显示心跳消息
            // 避免在错误/重连期间显示误导性的"连接正常"消息
            const statusEl = document.getElementById('reportStreamStatus');
            const currentState = statusEl ? statusEl.dataset.state : null;

            // 如果当前处于重连或错误状态，忽略心跳消息
            if (currentState === 'reconnecting' || currentState === 'error') {
                break;
            }

            updateReportStreamStatus('connected');
            // 心跳消息不显示在控制台，避免刷屏
            // appendReportStreamLine(payload.message || '流式连接正常，请稍候...', 'info', {
            //     badge: 'SSE',
            //     genericMessage: '流式连接正常，请耐心等待...'
            // });
            break;
        default:
            if (payload.message) {
                appendReportStreamLine(payload.message, 'info');
            }
            break;
    }
}

// 清洗流式chunk，裁剪多余空白，避免影响UI
function formatStreamChunk(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// 查看报告
function viewReport(taskId) {
    taskId = (taskId || '').trim();
    console.log('[viewReport] taskId=', taskId);
    if (!taskId) { console.error('[viewReport] taskId 为空'); return; }

    window.AppViewController.switchView('REPORT');

    const previewContainer = document.getElementById('reportPreview');
    if (!previewContainer) { console.error('[viewReport] reportPreview 不存在'); return; }

    previewContainer.innerHTML = '<div class="report-loading"><span class="report-loading-spinner"></span>加载报告中...</div>';

    window.API.getReportResult(taskId)
    .then(function (rawHtml) {
        console.log('[viewReport] HTML length:', rawHtml?.length);

        const fullHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                html { background: transparent !important; }
                body {
                    background: rgba(10, 15, 30, 0.95) !important;
                    color: #e0e0e0 !important;
                    max-width: 960px !important;
                    margin: 100px auto 60px auto !important;
                    padding: 60px 80px !important;
                    border-radius: 20px !important;
                    box-shadow: 0 30px 100px rgba(0,0,0,0.5) !important;
                    min-height: auto !important;
                }
                header.report-header, #export-overlay { display: none !important; }
                body > * { margin-left: 0 !important; margin-right: 0 !important; max-width: 100% !important; box-sizing: border-box !important; color: #e0e0e0 !important; }
                h1 { text-align: center; border-bottom: 2px solid #45a29e; padding-bottom: 0.5em; color: #e0e0e0 !important; }
                h2, h3, h4, h5, h6 { color: #e0e0e0 !important; }
                p { line-height: 1.8; color: #c0c0c0 !important; }
                a { color: #66c0c0 !important; }
                table { width: 100%; border-collapse: collapse; color: #e0e0e0 !important; }
                th, td { border: 1px solid #45a29e; padding: 8px; color: #e0e0e0 !important; }
                th { background: rgba(69, 162, 158, 0.3) !important; }
                code { background: rgba(69, 162, 158, 0.2) !important; color: #7fdbdb !important; padding: 2px 6px; border-radius: 4px; }
                blockquote { border-left: 4px solid #45a29e; padding-left: 16px; color: #aaa !important; margin: 16px 0; }
            </style>
        </head>
        <body>
            ${rawHtml}
        </body>
        </html>
        `;

        const iframe = document.createElement('iframe');
        iframe.id = 'report-iframe';
        iframe.style.cssText = 'width:100%;border:none;min-height:100vh;display:block;background:transparent;';

        const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        iframe.src = blobUrl;

        previewContainer.innerHTML = '';
        previewContainer.appendChild(iframe);

        let dlBtn = document.getElementById('immersiveDownloadBtn');
        if (!dlBtn) {
            dlBtn = document.createElement('button');
            dlBtn.id = 'immersiveDownloadBtn';
            dlBtn.className = 'immersive-back-btn';
            dlBtn.style.cssText = 'display:flex !important;top:64px;left:auto;right:28px;';
            dlBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;flex-shrink:0;opacity:0.85;">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <span>下载PDF</span>`;
            document.body.appendChild(dlBtn);
        }
        dlBtn.style.display = 'flex';
        dlBtn.onclick = function () { exportPdfFromIframe(taskId); };

        iframe.onload = function () {
            try {
                const body = iframe.contentWindow.document.body;
                const doc = iframe.contentWindow.document.documentElement;
                const height = Math.max(body.scrollHeight, body.offsetHeight, doc.clientHeight, doc.scrollHeight, doc.offsetHeight);
                iframe.style.height = Math.max(height, 800) + 'px';
            } catch (e) {
                iframe.style.height = '100vh';
            }

            try {
                const iframeDoc = iframe.contentWindow.document;
                const headings = iframeDoc.querySelectorAll('h1, h2, h3');
                if (headings.length > 0) {
                    let toc = document.getElementById('reportToc');
                    if (!toc) {
                        toc = document.createElement('nav');
                        toc.id = 'reportToc';
                        toc.className = 'report-toc';
                    }
                    if (toc.parentElement !== document.body) {
                        document.body.appendChild(toc);
                    }
                    toc.removeAttribute('hidden');

                    let tocHtml = '<div class="toc-header">目录</div><ul class="toc-list">';
                    headings.forEach(function (h, idx) {
                        if (h.closest('header.report-header')) return;
                        const id = h.id || 'heading-' + idx;
                        if (!h.id) h.id = id;
                        const level = h.tagName.toLowerCase();
                        const fullText = h.textContent.trim();
                        const shortText = fullText.length > 50 ? fullText.substring(0, 50) + '…' : fullText;
                        tocHtml += '<li class="toc-item toc-' + level + '"><a href="#" data-target="' + id + '" title="' + fullText.replace(/"/g, '&quot;') + '">' + shortText + '</a></li>';
                    });
                    tocHtml += '</ul>';
                    toc.innerHTML = tocHtml;

                    let handle = document.getElementById('tocHandle');
                    if (!handle) {
                        handle = document.createElement('div');
                        handle.id = 'tocHandle';
                        handle.className = 'toc-handle';
                        handle.innerHTML = '<svg class="toc-icon-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg><svg class="toc-icon-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
                        document.body.appendChild(handle);
                    }
                    handle.style.display = 'flex';
                    toc.classList.remove('toc-collapsed');
                    handle.classList.add('toc-handle-expanded');

                    handle.onclick = function (e) {
                        e.stopPropagation();
                        toc.classList.toggle('toc-collapsed');
                        handle.classList.toggle('toc-handle-expanded');
                    };

                    toc.querySelectorAll('.toc-item a').forEach(function (a) {
                        a.addEventListener('click', function (e) {
                            e.preventDefault();
                            const targetId = a.dataset.target;
                            try {
                                const target = iframeDoc.getElementById(targetId);
                                if (target) {
                                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                    toc.querySelectorAll('.toc-item').forEach(function (li) { li.classList.remove('active'); });
                                    a.parentElement.classList.add('active');
                                    setTimeout(function () {
                                        toc.classList.add('toc-collapsed');
                                        handle.classList.remove('toc-handle-expanded');
                                    }, 300);
                                }
                            } catch (err) {}
                        });
                    });
                }
            } catch (tocErr) {
                console.warn('[viewReport] TOC 生成失败:', tocErr);
            }
        };
    })
    .catch(function (error) {
        console.error('[viewReport] 报告读取失败:', error);
        previewContainer.innerHTML = '<div class="report-loading" style="color:rgba(255,100,100,0.8);">报告读取失败，请稍后重试</div>';
    });
}

// 退出沉浸式阅读器
function exitImmersiveReader() {
    window.isViewingHistory = false;

    window.AppViewController.switchView('HOME');

    const dlBtn = document.getElementById('immersiveDownloadBtn');
    if (dlBtn) dlBtn.style.display = 'none';

    currentApp = 'report';
    switchToApp('insight');
}

// 检查报告状态（不重新加载整个界面）
function checkReportStatus() {
    // 只更新状态信息，不重新渲染整个界面
    fetch('/api/report/status')
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // 更新ReportEngine状态指示器
            const indicator = document.getElementById('status-report');
            if (indicator) {
                if (data.initialized) {
                    indicator.className = 'status-indicator running';
                    appStatus.report = 'running';
                } else {
                    indicator.className = 'status-indicator';
                    appStatus.report = 'stopped';
                }
            }

            // 更新状态信息（如果存在）
            updateEngineStatusDisplay(data);

            showMessage('状态检查完成', 'success');
        } else {
            showMessage('状态检查失败: ' + data.error, 'error');
        }
    })
    .catch(error => {
        console.error('检查报告状态失败:', error);
        showMessage('状态检查失败: ' + error.message, 'error');
    });
}

// 更新引擎状态显示（只更新文本内容）
function updateEngineStatusDisplay(statusData) {
    const statusContent = document.getElementById('engineStatusContent');

    if (statusContent) {
        // 确定状态样式
        const statusClass = statusData.initialized ? 'success' : 'error';

        // 更新状态信息内容
        let statusHTML = '';
        if (statusData.initialized) {
            statusHTML = `
                <strong>报告引擎状态:</strong> 已初始化<br>
                <strong>文件检查:</strong> ${statusData.engines_ready ? '准备就绪' : '文件未就绪'}<br>
                <strong>找到文件:</strong> ${statusData.files_found ? statusData.files_found.join(', ') : '无'}<br>
                ${statusData.missing_files && statusData.missing_files.length > 0 ? 
                  `<strong>缺失文件:</strong> ${statusData.missing_files.join(', ')}` : ''}
            `;
        } else {
            statusHTML = `<strong>报告引擎状态:</strong> 未初始化`;
        }

        // 更新内容和样式
        statusContent.innerHTML = statusHTML;
        statusContent.className = `report-status ${statusClass}`;
    }
}