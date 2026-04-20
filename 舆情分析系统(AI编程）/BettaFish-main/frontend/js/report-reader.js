/**
 * report-reader.js — Phase 3: 沉浸式星空报告阅读器
 *
 * 职责：
 *   1. 监听报告 iframe 加载，激活浮动工具栏 + 大纲导航
 *   2. 从 iframe 内容提取 h2/h3 标题，生成左侧大纲
 *   3. 毛玻璃 pill 浮动工具栏（打印/PDF/HTML/MD 导出）
 *   4. 双栈 PDF 导出：克隆纯白 DOM → html2canvas → jsPDF
 *
 * 公开接口（window.ReportReader）：
 *   ReportReader.onReportLoaded(iframe)  — 报告 iframe 就绪后调用
 *   ReportReader.exportPdfDualStack()    — 双栈 PDF 导出
 */

(function () {
    'use strict';

    /* ─────────────────────────────────────────────
       1. 打印专用 CSS（注入克隆 DOM）
    ───────────────────────────────────────────── */
    const PRINT_CSS = `
        *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            box-shadow: none !important;
            text-shadow: none !important;
        }
        html, body {
            background: #ffffff !important;
            color: #1a1a1a !important;
            font-family: 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif !important;
            font-size: 15px !important;
            line-height: 1.8 !important;
            margin: 0 !important;
            padding: 0 !important;
            width: 794px !important;
        }
        .container, section, article, main, div, header, footer, nav, aside {
            background: #ffffff !important;
            color: #1a1a1a !important;
            border-color: #e0e0e0 !important;
        }
        h1, h2, h3, h4, h5, h6 {
            color: #111111 !important;
            page-break-after: avoid;
        }
        a { color: #0066cc !important; text-decoration: none !important; }
        table { border-collapse: collapse !important; width: 100% !important; }
        th, td {
            border: 1px solid #cccccc !important;
            padding: 8px 12px !important;
            background: #ffffff !important;
            color: #1a1a1a !important;
        }
        th { background: #f5f5f5 !important; font-weight: 600 !important; }
        pre, code {
            background: #f8f8f8 !important;
            color: #333333 !important;
            border: 1px solid #e0e0e0 !important;
        }
        blockquote {
            border-left: 3px solid #0066cc !important;
            background: #f8f9ff !important;
            color: #333333 !important;
        }
        .chart-container, canvas {
            background: #ffffff !important;
            max-width: 100% !important;
        }
        .toc, nav, .no-print, button, .btn,
        .theme-toggle, .dark-mode-toggle,
        [class*="toggle"], [class*="switch"],
        .report-controls, .engine-status-info,
        .embedded-hide {
            display: none !important;
        }
        h2 { page-break-before: auto; }
        .content-section { page-break-inside: avoid; }
        img, canvas, figure { page-break-inside: avoid; }
    `;

    /* ─────────────────────────────────────────────
       2. 状态
    ───────────────────────────────────────────── */
    let _currentIframe = null;
    let _currentHtml   = null;
    let _fabOpen       = false;
    let _toolbarInjected = false;

    /* ─────────────────────────────────────────────
       3. 工具函数
    ───────────────────────────────────────────── */
    function el(id) { return document.getElementById(id); }

    function showMsg(text, type) {
        if (window.showMessage) window.showMessage(text, type);
    }

    /* ─────────────────────────────────────────────
       4. 大纲生成 + 智能伸缩导视系统
    ───────────────────────────────────────────── */
    function buildToc(iframeDoc) {
        const tocList = el('tocList');
        const tocNav  = el('reportToc');
        if (!tocList || !tocNav || !iframeDoc) return;

        const headings = iframeDoc.querySelectorAll('h2, h3');
        if (headings.length < 2) {
            tocNav.hidden = true;
            return;
        }

        tocList.innerHTML = '';

        const isImmersive = document.body.classList.contains('immersive-reader');

        headings.forEach((h, i) => {
            if (!h.id) h.id = `rr-heading-${i}`;

            const li = document.createElement('li');
            li.className = `toc-item toc-${h.tagName.toLowerCase()}`;

            const a = document.createElement('a');
            a.href = 'javascript:void(0)';
            a.textContent = h.textContent.trim().slice(0, 50);
            a.dataset.headingId = h.id;

            a.addEventListener('click', () => {
                try {
                    const iframe = document.getElementById('report-iframe');
                    let targetDoc = iframeDoc;
                    if (iframe && iframe.contentDocument) {
                        targetDoc = iframe.contentDocument;
                    }
                    const target = targetDoc.getElementById(h.id) || targetDoc.querySelector(`[id="${h.id}"]`);
                    if (target) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } else {
                        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                } catch (e) {}
                tocList.querySelectorAll('.toc-item').forEach(x => x.classList.remove('active'));
                li.classList.add('active');

                if (isImmersive) {
                    setTimeout(() => tocNav.classList.remove('toc-expanded'), 350);
                }
            });

            li.appendChild(a);
            tocList.appendChild(li);
        });

        tocNav.hidden = false;

        if (isImmersive) {
            tocNav.classList.add('toc-collapsed');
            tocNav.classList.remove('toc-expanded');

            let existingHandle = tocNav.querySelector('.toc-handle');
            if (!existingHandle) {
                const handle = document.createElement('div');
                handle.className = 'toc-handle';
                handle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(180,210,255,0.7)" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>`;
                handle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    tocNav.classList.toggle('toc-expanded');
                });
                tocNav.appendChild(handle);
            }

            tocNav.addEventListener('mouseleave', () => {
                tocNav.classList.remove('toc-expanded');
            });
        }

        _watchScrollForToc(iframeDoc, headings, tocList);
    }

    function _watchScrollForToc(iframeDoc, headings, tocList) {
        const scrollRoot = iframeDoc.scrollingElement || iframeDoc.documentElement;

        let _scrollTicking = false;
        function onScroll() {
            if (_scrollTicking) return;
            _scrollTicking = true;
            requestAnimationFrame(() => {
                const scrollTop = scrollRoot.scrollTop;
                let activeIdx = 0;
                headings.forEach((h, i) => {
                    if (h.offsetTop - 80 <= scrollTop) activeIdx = i;
                });
                tocList.querySelectorAll('.toc-item').forEach((li, i) => {
                    li.classList.toggle('active', i === activeIdx);
                });
                _scrollTicking = false;
            });
        }

        try {
            iframeDoc.addEventListener('scroll', onScroll, { passive: true });
        } catch (e) {}
    }

    /* ─────────────────────────────────────────────
       5. 毛玻璃浮动工具栏（替代旧 FAB）
       pill 形设计，悬浮在阅读容器右上角
    ───────────────────────────────────────────── */
    function injectFloatingToolbar() {
        if (_toolbarInjected) {
            // 已注入，直接显示
            const tb = el('rrFloatingToolbar');
            if (tb) tb.style.display = '';
            return;
        }

        const toolbar = document.createElement('div');
        toolbar.id = 'rrFloatingToolbar';
        toolbar.innerHTML = `
            <button class="rr-tb-btn" id="rrTbPrint" title="打印报告">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 6 2 18 2 18 9"></polyline>
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                    <rect x="6" y="14" width="12" height="8"></rect>
                </svg>
            </button>
            <button class="rr-tb-btn" id="rrTbPdf" title="导出 PDF">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
            </button>
            <button class="rr-tb-btn" id="rrTbHtml" title="下载 HTML">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="16 18 22 12 16 6"/>
                    <polyline points="8 6 2 12 8 18"/>
                </svg>
            </button>
            <button class="rr-tb-btn" id="rrTbMd" title="下载 Markdown">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 6h16M4 12h10M4 18h7"/>
                </svg>
            </button>
        `;

        // 注入样式
        const style = document.createElement('style');
        style.textContent = `
            #rrFloatingToolbar {
                position: fixed;
                top: 24px;
                right: 120px;
                z-index: 100000;
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 6px 10px;
                border-radius: 999px;
                background: rgba(10, 20, 40, 0.45);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
                border: 1px solid rgba(120, 180, 255, 0.18);
                box-shadow: 0 2px 16px rgba(0,0,0,0.28), 0 0 0 1px rgba(59,158,255,0.06) inset;
                font-family: -apple-system, 'SF Pro Display', 'PingFang SC', sans-serif;
                transition: opacity 0.25s ease, transform 0.25s ease;
            }
            .rr-tb-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 34px;
                height: 34px;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: rgba(180, 210, 255, 0.72);
                cursor: pointer;
                transition: background 0.2s, color 0.2s, transform 0.2s, box-shadow 0.2s;
            }
            .rr-tb-btn svg {
                width: 16px;
                height: 16px;
            }
            .rr-tb-btn:hover {
                background: rgba(120, 180, 255, 0.15);
                color: rgba(210, 230, 255, 0.95);
                transform: translateY(-1px);
                box-shadow: 0 2px 8px rgba(59, 158, 255, 0.15);
            }
            .rr-tb-btn:active {
                transform: translateY(0) scale(0.95);
            }
            /* 非沉浸模式下隐藏 */
            body:not(.immersive-reader) #rrFloatingToolbar {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(toolbar);
        _toolbarInjected = true;

        // 绑定事件
        el('rrTbPrint').addEventListener('click', () => {
            if (_currentIframe) {
                try { _currentIframe.contentWindow.print(); } catch (e) { window.print(); }
            }
        });

        el('rrTbPdf').addEventListener('click', () => {
            exportPdfDualStack();
        });

        el('rrTbHtml').addEventListener('click', () => {
            const orig = el('downloadReportButton');
            if (orig && !orig.disabled) orig.click();
            else showMsg('HTML 报告尚未就绪', 'error');
        });

        el('rrTbMd').addEventListener('click', () => {
            const orig = el('downloadMdButton');
            if (orig && !orig.disabled) orig.click();
            else showMsg('Markdown 报告尚未就绪', 'error');
        });
    }

    function hideFloatingToolbar() {
        const tb = el('rrFloatingToolbar');
        if (tb) tb.style.display = 'none';
    }

    /* ─────────────────────────────────────────────
       6. 旧 FAB 控制（保留兼容，非沉浸模式下使用）
    ───────────────────────────────────────────── */
    function initFab() {
        const fab     = el('reportFab');
        const mainBtn = el('fabMainBtn');
        const menu    = el('fabMenu');
        if (!fab || !mainBtn || !menu) return;

        mainBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _fabOpen = !_fabOpen;
            menu.classList.toggle('open', _fabOpen);
            mainBtn.setAttribute('aria-expanded', String(_fabOpen));
            mainBtn.classList.toggle('active', _fabOpen);
        });

        document.addEventListener('click', () => {
            if (_fabOpen) {
                _fabOpen = false;
                menu.classList.remove('open');
                mainBtn.setAttribute('aria-expanded', 'false');
                mainBtn.classList.remove('active');
            }
        });

        const pdfBtn = el('fabPdfBtn');
        if (pdfBtn) {
            pdfBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _closeFab();
                exportPdfDualStack();
            });
        }

        const htmlBtn = el('fabHtmlBtn');
        if (htmlBtn) {
            htmlBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _closeFab();
                const orig = el('downloadReportButton');
                if (orig && !orig.disabled) orig.click();
                else showMsg('HTML 报告尚未就绪', 'error');
            });
        }

        const mdBtn = el('fabMdBtn');
        if (mdBtn) {
            mdBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _closeFab();
                const orig = el('downloadMdButton');
                if (orig && !orig.disabled) orig.click();
                else showMsg('Markdown 报告尚未就绪', 'error');
            });
        }
    }

    function _closeFab() {
        _fabOpen = false;
        const menu    = el('fabMenu');
        const mainBtn = el('fabMainBtn');
        if (menu)    menu.classList.remove('open');
        if (mainBtn) { mainBtn.setAttribute('aria-expanded', 'false'); mainBtn.classList.remove('active'); }
    }

    function showFab() {
        const fab = el('reportFab');
        if (fab) fab.hidden = false;
    }

    function hideFab() {
        const fab = el('reportFab');
        if (fab) fab.hidden = true;
    }

    /* ─────────────────────────────────────────────
       7. 双栈 PDF 导出
    ───────────────────────────────────────────── */
    async function exportPdfDualStack() {
        // 先尝试后端 API
        const pdfBtn = el('downloadPdfButton');
        if (pdfBtn && !pdfBtn.disabled) {
            showMsg('正在通过后端生成 PDF…', 'info');
            pdfBtn.click();
            return;
        }

        if (!_currentHtml) {
            showMsg('报告内容尚未加载，请先查看报告', 'error');
            return;
        }
        await _frontendPdfExport(_currentHtml);
    }

    async function _frontendPdfExport(htmlContent) {
        if (!window.html2canvas || !window.jspdf) {
            showMsg('PDF 依赖库未加载，请刷新页面重试', 'error');
            return;
        }

        showMsg('正在构建打印专用视图…', 'info');

        const printFrame = document.createElement('iframe');
        printFrame.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;height:1123px;border:none;visibility:hidden;pointer-events:none;z-index:-1;';
        document.body.appendChild(printFrame);

        try {
            const printDoc = printFrame.contentDocument || printFrame.contentWindow.document;
            printDoc.open();
            printDoc.write(_buildPrintHtml(htmlContent));
            printDoc.close();

            await _waitForIframeReady(printFrame, 3000);

            showMsg('正在截图生成 PDF，请稍候…', 'info');

            const printBody = printDoc.body;
            const totalHeight = Math.max(
                printBody.scrollHeight,
                printBody.offsetHeight,
                printDoc.documentElement.scrollHeight
            );

            const canvas = await html2canvas(printBody, {
                scale: 2,
                useCORS: true,
                allowTaint: false,
                backgroundColor: '#ffffff',
                width: 794,
                height: totalHeight,
                windowWidth: 794,
                windowHeight: totalHeight,
                scrollX: 0,
                scrollY: 0,
                logging: false,
                imageTimeout: 8000,
                onclone: (clonedDoc) => {
                    clonedDoc.body.style.background = '#ffffff';
                    clonedDoc.documentElement.style.background = '#ffffff';
                },
            });

            const { jsPDF } = window.jspdf;
            const A4_W = 210;
            const A4_H = 297;
            const imgW = A4_W;
            const imgH = (canvas.height * A4_W) / canvas.width;

            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4',
                compress: true,
            });

            let yOffset = 0;
            let pageNum = 0;

            while (yOffset < imgH) {
                if (pageNum > 0) pdf.addPage();

                const srcY      = (yOffset / imgH) * canvas.height;
                const srcH      = Math.min((A4_H / imgH) * canvas.height, canvas.height - srcY);
                const pageImgH  = (srcH / canvas.height) * imgH;

                const pageCanvas = document.createElement('canvas');
                pageCanvas.width  = canvas.width;
                pageCanvas.height = Math.ceil(srcH);
                const pCtx = pageCanvas.getContext('2d');
                pCtx.fillStyle = '#ffffff';
                pCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
                pCtx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);

                const pageData = pageCanvas.toDataURL('image/jpeg', 0.92);
                pdf.addImage(pageData, 'JPEG', 0, 0, imgW, pageImgH, '', 'FAST');

                yOffset += A4_H;
                pageNum++;

                if (pageNum >= 50) break;
            }

            const filename = `report_${new Date().toISOString().slice(0, 10)}.pdf`;
            pdf.save(filename);
            showMsg('PDF 已生成并开始下载', 'success');

        } catch (err) {
            console.error('[ReportReader] PDF 导出失败:', err);
            showMsg('PDF 导出失败: ' + err.message, 'error');
        } finally {
            if (printFrame.parentNode) {
                printFrame.parentNode.removeChild(printFrame);
            }
        }
    }

    function _buildPrintHtml(rawHtml) {
        const printStyleTag = `<style id="__print_override__">${PRINT_CSS}</style>`;
        if (rawHtml.includes('</head>')) {
            return rawHtml.replace('</head>', `${printStyleTag}\n</head>`);
        }
        return printStyleTag + rawHtml;
    }

    function _waitForIframeReady(iframe, timeout = 3000) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, timeout);
            iframe.addEventListener('load', () => {
                clearTimeout(timer);
                setTimeout(resolve, 500);
            }, { once: true });
        });
    }

    /* ─────────────────────────────────────────────
       8. 报告加载完成钩子
    ───────────────────────────────────────────── */
    function onReportLoaded(iframe, htmlContent) {
        _currentIframe = iframe;
        if (htmlContent) _currentHtml = htmlContent;

        const tryInit = () => {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (!iframeDoc || !iframeDoc.body) {
                    setTimeout(tryInit, 200);
                    return;
                }
                buildToc(iframeDoc);
                showFab();
                // 沉浸模式下显示浮动工具栏
                if (document.body.classList.contains('immersive-reader')) {
                    injectFloatingToolbar();
                }
            } catch (e) {
                showFab();
                if (document.body.classList.contains('immersive-reader')) {
                    injectFloatingToolbar();
                }
            }
        };

        if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
            tryInit();
        } else {
            iframe.addEventListener('load', tryInit, { once: true });
            setTimeout(tryInit, 1500);
        }
    }

    /* ─────────────────────────────────────────────
       9. MutationObserver：自动检测 #reportPreview 里的 iframe
       修复：匹配所有 IFRAME 标签，不再依赖特定 id
    ───────────────────────────────────────────── */
    function _watchReportPreview() {
        const preview = el('reportPreview');
        if (!preview) {
            setTimeout(_watchReportPreview, 500);
            return;
        }

        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.tagName === 'IFRAME') {
                        node.addEventListener('load', () => {
                            let html = null;
                            try {
                                const doc = node.contentDocument || node.contentWindow.document;
                                html = doc.documentElement.outerHTML;
                            } catch (e) { /* 跨域 */ }
                            onReportLoaded(node, html);
                        }, { once: true });
                        // 已加载完
                        if (node.contentDocument && node.contentDocument.readyState === 'complete') {
                            let html = null;
                            try { html = node.contentDocument.documentElement.outerHTML; } catch (e) {}
                            onReportLoaded(node, html);
                        }
                    }
                }
                for (const node of m.removedNodes) {
                    if (node.tagName === 'IFRAME') {
                        hideFab();
                        hideFloatingToolbar();
                        const tocNav = el('reportToc');
                        if (tocNav) tocNav.hidden = true;
                        _currentIframe = null;
                        _currentHtml   = null;
                    }
                }
            }
        });

        observer.observe(preview, { childList: true, subtree: false });
    }

    /* ─────────────────────────────────────────────
       10. 监听 reportContent（reportPreview 的父级）
    ───────────────────────────────────────────── */
    function _watchReportContent() {
        const content = el('reportContent');
        if (!content) {
            setTimeout(_watchReportContent, 500);
            return;
        }

        const observer = new MutationObserver(() => {
            const preview = el('reportPreview');
            if (preview) {
                observer.disconnect();
                _watchReportPreview();
            }
        });

        observer.observe(content, { childList: true, subtree: true });

        if (el('reportPreview')) _watchReportPreview();
    }

    /* ─────────────────────────────────────────────
       11. 初始化
    ───────────────────────────────────────────── */
    function init() {
        initFab();
        _watchReportContent();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ─────────────────────────────────────────────
       12. 公开接口
    ───────────────────────────────────────────── */
    window.ReportReader = {
        onReportLoaded,
        exportPdfDualStack,
    };

})();
