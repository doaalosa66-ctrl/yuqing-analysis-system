/**
 * forum-state.js — Phase 2: 运算态状态机
 *
 * 职责：
 *   1. 监听搜索提交，切换 Spotlight → Forum State
 *   2. 驱动三个 Agent 节点的呼吸/激活/完成动画
 *   3. 接收后端日志（通过 window.ForumState.push()），打字机输出到终端
 *   4. 提供 mockStartSse() 供前端独立测试
 *
 * 接口（挂载到 window.ForumState）：
 *   ForumState.push(line, app)   — 接收一条日志，app: 'query'|'media'|'insight'|'forum'
 *   ForumState.activate(agent)   — 激活某个节点
 *   ForumState.complete(agent)   — 标记某个节点完成
 *   ForumState.reset()           — 重置到初始态
 *   ForumState.mockStartSse()    — 模拟 SSE 数据流（测试用）
 */

(function () {
    'use strict';

    /* ─────────────────────────────────────────────
       1. 常量 & 配置
    ───────────────────────────────────────────── */
    const AGENTS = ['query', 'media', 'insight'];

    // Agent 显示名 & 颜色 token（与 CSS 变量对应）
    const AGENT_META = {
        query:   { label: '全网实时资讯', color: '#0A84FF', dim: 'rgba(10,132,255,0.18)'  },
        media:   { label: '权威深度报道', color: '#30D158', dim: 'rgba(48,209,88,0.18)'   },
        insight: { label: '内部核心智库', color: '#FF9F0A', dim: 'rgba(255,159,10,0.18)'  },
        forum:   { label: '系统',          color: '#EBEBF5', dim: 'rgba(235,235,245,0.12)' },
        host:    { label: '主持人',         color: '#EBEBF5', dim: 'rgba(235,235,245,0.12)' },
    };

    // stage/status → 中文消息映射
    const STAGE_MESSAGES = {
        // 启动阶段
        'starting':        '🚀 接收到搜索指令，正在唤醒三大智库引擎...',
        'initializing':    '🚀 接收到搜索指令，正在唤醒三大智库引擎...',
        'init':            '🚀 接收到搜索指令，正在唤醒三大智库引擎...',
        // 各引擎运行
        'query':           '🔍 [全网实时资讯] 正在全网抓取实时资讯...',
        'query_running':   '🔍 [全网实时资讯] 正在提取核心观点，请稍候...',
        'media':           '📰 [权威深度报道] 正在解析权威媒体深度报道...',
        'media_running':   '📰 [权威深度报道] 正在将深度报道喂给大模型进行提炼...',
        'insight':         '🧠 [内部核心智库] 正在检索内部知识库...',
        'insight_running': '🧠 [内部核心智库] 正在进行语义聚类与观点碰撞...',
        // 报告生成
        'report':          '✍️ 三路数据汇总完毕，ReportEngine 正在极速撰写最终报告...',
        'report_running':  '✍️ 报告引擎正在逐章生成，请耐心等待...',
        'generating':      '✍️ 三路数据汇总完毕，ReportEngine 正在极速撰写最终报告...',
        // 完成
        'completed':       '✅ 报告生成完毕，正在渲染预览...',
        'done':            '✅ 报告生成完毕，正在渲染预览...',
        'html_ready':      '✅ 报告已就绪，正在加载预览...',
        // 错误
        'error':           '❌ 任务遇到异常，请检查配置后重试',
    };

    // 打字机速度（ms/字符）
    const TYPEWRITER_SPEED = 18;
    // 日志队列最大条数（超出后移除最旧的）
    const MAX_LOG_LINES = 60;

    /* ─────────────────────────────────────────────
       2. 状态
    ───────────────────────────────────────────── */
    let _active = false;          // Forum State 是否可见
    let _logQueue = [];           // 待打字机输出的队列 [{text, agent}]
    let _typing = false;          // 打字机是否正在工作
    let _lineCount = 0;           // 已渲染行数

    /* ─────────────────────────────────────────────
       3. DOM 引用（延迟获取，确保 DOM 已就绪）
    ───────────────────────────────────────────── */
    function el(id) { return document.getElementById(id); }

    /* ─────────────────────────────────────────────
       4. 显示 / 隐藏 Forum State
    ───────────────────────────────────────────── */
    let _searchActive = false;  // 只有 performSearch 主动设置后，pushStage 才允许 show()

    function show() {
        const fs = el('forumState');
        if (!fs || _active) return;
        _active = true;
        fs.classList.add('visible');
        fs.removeAttribute('aria-hidden');
        _updateConnectors();
    }

    function hide() {
        const fs = el('forumState');
        if (!fs) return;
        _active = false;
        _searchActive = false;
        fs.classList.remove('visible');
        fs.setAttribute('aria-hidden', 'true');
    }

    function setSearchActive(val) {
        _searchActive = !!val;
    }

    /* ─────────────────────────────────────────────
       5. 节点状态控制
    ───────────────────────────────────────────── */
    function activate(agent) {
        const node = el(`node-${agent}`);
        if (!node) return;
        node.classList.remove('idle', 'done');
        node.classList.add('active');
        const statusEl = el(`node-${agent}-status`);
        if (statusEl) statusEl.textContent = '运行中';
    }

    function complete(agent) {
        const node = el(`node-${agent}`);
        if (!node) return;
        node.classList.remove('active');
        node.classList.add('done');
        const statusEl = el(`node-${agent}-status`);
        if (statusEl) statusEl.textContent = '✅ 完成';
    }

    function resetNodes() {
        AGENTS.forEach(agent => {
            const node = el(`node-${agent}`);
            if (!node) return;
            node.classList.remove('active', 'done');
            node.classList.add('idle');
            const statusEl = el(`node-${agent}-status`);
            if (statusEl) statusEl.textContent = '待命';
        });
    }

    /* ─────────────────────────────────────────────
       6. SVG 连接线定位
       在节点渲染后计算各节点圆心坐标，更新 SVG line
    ───────────────────────────────────────────── */
    function _updateConnectors() {
        requestAnimationFrame(() => {
            const svg = el('forumConnectors');
            if (!svg) return;

            const centers = {};
            AGENTS.forEach(agent => {
                const orb = document.querySelector(`#node-${agent} .node-orb`);
                if (!orb) return;
                const r = orb.getBoundingClientRect();
                const sr = svg.getBoundingClientRect();
                centers[agent] = {
                    x: r.left + r.width / 2 - sr.left,
                    y: r.top  + r.height / 2 - sr.top,
                };
            });

            function setLine(id, a, b) {
                const line = el(id);
                if (!line || !centers[a] || !centers[b]) return;
                line.setAttribute('x1', centers[a].x);
                line.setAttribute('y1', centers[a].y);
                line.setAttribute('x2', centers[b].x);
                line.setAttribute('y2', centers[b].y);
            }

            setLine('conn-q-m', 'query',  'media');
            setLine('conn-m-i', 'media',  'insight');
            setLine('conn-q-i', 'query',  'insight');

            // 脉冲点初始位置
            function setPulse(id, a) {
                const p = el(id);
                if (!p || !centers[a]) return;
                p.setAttribute('cx', centers[a].x);
                p.setAttribute('cy', centers[a].y);
            }
            setPulse('pulse-q-m', 'query');
            setPulse('pulse-m-i', 'media');
        });
    }

    window.addEventListener('resize', () => {
        if (_active) _updateConnectors();
    });

    /* ─────────────────────────────────────────────
       7. 打字机日志输出
    ───────────────────────────────────────────── */
    function push(rawLine, app) {
        if (!rawLine) return;

        // 解析日志格式 [HH:MM:SS] [SOURCE] content
        // 兼容原始格式和直接传入的纯文本
        let agent = (app || 'forum').toLowerCase();
        let text  = rawLine;
        let timestamp = '';

        const timeMatch = rawLine.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
        if (timeMatch) {
            timestamp = timeMatch[1];
            const rest = rawLine.substring(timeMatch[0].length).trim();
            const srcMatch = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
            if (srcMatch) {
                const src = srcMatch[1].toLowerCase();
                if (['query','media','insight','host'].includes(src)) {
                    agent = src === 'host' ? 'forum' : src;
                }
                text = srcMatch[2] || rest;
            } else {
                text = rest;
            }
        }

        // 过滤空行和系统分隔线
        if (!text.trim() || text.includes('=== ForumEngine')) return;

        // 激活对应节点
        if (AGENTS.includes(agent)) activate(agent);

        _logQueue.push({ text, agent, timestamp });
        _drainQueue();
    }

    function _drainQueue() {
        if (_typing || _logQueue.length === 0) return;
        _typing = true;
        _typeNextLine();
    }

    function _typeNextLine() {
        if (_logQueue.length === 0) {
            _typing = false;
            return;
        }

        const { text, agent, timestamp } = _logQueue.shift();
        _renderLine(text, agent, timestamp, () => {
            // 每行完成后短暂停顿，再输出下一行
            setTimeout(_typeNextLine, 80);
        });
    }

    function _renderLine(text, agent, timestamp, onDone) {
        const body = el('terminalBody');
        if (!body) { onDone && onDone(); return; }

        // 超出最大行数时移除最旧的
        _lineCount++;
        if (_lineCount > MAX_LOG_LINES) {
            const oldest = body.querySelector('.t-line');
            if (oldest) oldest.remove();
        }

        const meta = AGENT_META[agent] || AGENT_META.forum;

        // 构建行容器
        const line = document.createElement('div');
        line.className = `t-line t-line--${agent}`;

        // 时间戳
        if (timestamp) {
            const ts = document.createElement('span');
            ts.className = 't-ts';
            ts.textContent = timestamp;
            line.appendChild(ts);
        }

        // Agent 标签
        const tag = document.createElement('span');
        tag.className = 't-tag';
        tag.textContent = meta.label;
        tag.style.color = meta.color;
        tag.style.background = meta.dim;
        line.appendChild(tag);

        // 文本容器（打字机在这里写入）
        const content = document.createElement('span');
        content.className = 't-content';
        line.appendChild(content);

        body.appendChild(line);

        // 滚动到底部
        body.scrollTop = body.scrollHeight;

        // 打字机效果
        _typewriterInto(content, text, TYPEWRITER_SPEED, () => {
            body.scrollTop = body.scrollHeight;
            onDone && onDone();
        });
    }

    function _typewriterInto(el, text, speed, onDone) {
        let i = 0;
        // 对于长文本加速（超过 60 字符时缩短间隔）
        const effectiveSpeed = text.length > 60 ? Math.max(4, speed - 10) : speed;

        function tick() {
            if (i >= text.length) {
                onDone && onDone();
                return;
            }
            el.textContent += text[i++];
            setTimeout(tick, effectiveSpeed);
        }
        tick();
    }

    /* ─────────────────────────────────────────────
       8. 重置
    ───────────────────────────────────────────── */
    function reset() {
        _logQueue = [];
        _typing   = false;
        _lineCount = 0;
        resetNodes();
        const body = el('terminalBody');
        if (body) body.innerHTML = '';
        hide();
    }

    /* ─────────────────────────────────────────────
       9. 搜索提交钩子已移除
       页面切换统一由 index.html 的 performSearch() 控制
    ───────────────────────────────────────────── */

    /* ─────────────────────────────────────────────
       10. Mock SSE（测试用）
    ───────────────────────────────────────────── */
    function mockStartSse() {
        reset();
        show();
        resetNodes();

        const now = () => {
            const d = new Date();
            return [d.getHours(), d.getMinutes(), d.getSeconds()]
                .map(n => String(n).padStart(2, '0')).join(':');
        };

        const logs = [
            { delay: 300,  app: 'query',   text: '正在连接公开信源，目标平台：微博 / 抖音 / 知乎 / 新闻聚合…' },
            { delay: 1200, app: 'query',   text: '已接入 12 个平台，开始抓取原始数据，预计获取 20,000+ 条…' },
            { delay: 2400, app: 'media',   text: '多模态解析启动，正在提取抖音视频关键帧与字幕文本…' },
            { delay: 3600, app: 'query',   text: '数据清洗完成，有效语料 18,342 条，去重率 8.7%' },
            { delay: 4500, app: 'insight', text: '语义聚类启动，正在识别主要舆论簇…' },
            { delay: 5800, app: 'media',   text: '图像情感分析完成，检测到 3 类视觉情绪模式' },
            { delay: 7000, app: 'insight', text: '发现争议焦点 4 项，正在进行证据交叉校验…' },
            { delay: 8500, app: 'insight', text: '观点碰撞第一轮完成，核心结论已收敛，准备生成报告草案' },
        ];

        logs.forEach(({ delay, app, text }) => {
            setTimeout(() => {
                const ts = now();
                // 构造与真实后端一致的日志格式
                const line = `[${ts}] [${app.toUpperCase()}] ${text}`;
                push(line, app);
            }, delay);
        });

        // 模拟各节点完成
        setTimeout(() => complete('query'),   9000);
        setTimeout(() => complete('media'),   9500);
        setTimeout(() => complete('insight'), 10200);
    }

    /* ─────────────────────────────────────────────
       10b. pushStage — 将后端 stage/status 映射为中文消息推送到终端
    ───────────────────────────────────────────── */
    function pushStage(stage, extraMsg) {
        if (!stage) return;
        const key = String(stage).toLowerCase().trim();
        const msg = extraMsg || STAGE_MESSAGES[key];
        if (!msg) return;

        // 根据 stage 决定归属哪个 agent
        let agent = 'forum';
        if (key.startsWith('query'))   agent = 'query';
        else if (key.startsWith('media'))   agent = 'media';
        else if (key.startsWith('insight')) agent = 'insight';
        else if (key.startsWith('report') || key === 'generating') agent = 'forum';

        // 确保 Forum State 可见（仅在用户已发起搜索后）
        if (!_active && _searchActive) show();

        // 激活对应节点
        if (AGENTS.includes(agent)) activate(agent);

        _logQueue.push({ text: msg, agent, timestamp: '' });
        _drainQueue();
    }

    /* ─────────────────────────────────────────────
       11. 初始化
    ───────────────────────────────────────────── */
    function init() {
        // _hookSearch 已移除，页面切换由 performSearch 统一控制
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ─────────────────────────────────────────────
       12. 公开接口
    ───────────────────────────────────────────── */
    window.ForumState = {
        push,
        pushStage,
        activate,
        complete,
        reset,
        show,
        hide,
        setSearchActive,
        mockStartSse,
    };

})();
