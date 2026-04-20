/**
 * OmniSight - 绝对互斥视图控制器 (ViewController)
 * 职责：掌控全局 DOM 的显示与隐藏，确保同一时间只有一个主干业务流处于激活状态。
 */
window.AppViewController = {
    // 注册所有顶级容器的 ID (必须与 index.html 保持一致)
    containers: {
        HOME: 'spotlightShell',
        FORUM: 'forumState',
        CONTENT: 'mainContent',
        REPORT: 'reportPreview',
        DASHBOARD: 'dashboardView'
    },

    /**
     * 核心切换逻辑：绝对清场，定向放行
     * @param {string} targetView - 目标视图名称 ('HOME', 'FORUM', 'REPORT')
     */
    switchView: function(targetView) {
        console.log(`[ViewController] 正在强行清场，准备切换至视图: ${targetView}`);

        // 1. 无差别绝对清场：把所有容器强行物理隐藏
        for (const key in this.containers) {
            const el = document.getElementById(this.containers[key]);
            if (el) {
                el.style.display = 'none';
                el.classList.remove('active', 'visible', 'report-preview-active');
            }
        }

        // 2. 精准放行：根据目标视图，只显示对应的容器
        switch (targetView) {
            case 'HOME':
                // 首页状态：只显示搜索大框
                const home = document.getElementById(this.containers.HOME);
                if (home) {
                    home.style.display = 'flex'; // 或 block，取决于你的 CSS
                    home.classList.add('active');
                }
                break;

            case 'FORUM':
                // 运行状态：同时显示顶部日志(FORUM)和主体内容区(CONTENT)
                const forum = document.getElementById(this.containers.FORUM);
                const content = document.getElementById(this.containers.CONTENT);
                if (forum) {
                    forum.style.display = 'flex';
                    forum.classList.add('visible');
                }
                if (content) {
                    content.style.display = 'block';
                }
                break;

            case 'REPORT':
                // 报告状态：只显示全屏沉浸式报告
                const report = document.getElementById(this.containers.REPORT);
                if (report) {
                    report.style.display = 'block';
                    report.classList.add('report-preview-active');
                }
                break;

            case 'DASHBOARD':
                const dashboard = document.getElementById(this.containers.DASHBOARD);
                if (dashboard) {
                    dashboard.style.display = 'flex';
                    dashboard.classList.add('active');
                }
                break;

            default:
                console.warn(`[ViewController] 未知的视图: ${targetView}`);
        }
    }
};

console.log('[System] 视图控制器 (viewController.js) 加载完毕。');
