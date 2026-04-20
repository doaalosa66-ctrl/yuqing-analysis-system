(function () {
    'use strict';

    var VIEW_MAP = {
        HOME: {
            show: ['spotlightShell'],
            hide: ['forumState', 'reportPreview'],
        },
        FORUM: {
            show: ['forumState'],
            hide: ['spotlightShell', 'reportPreview'],
        },
        REPORT: {
            show: ['reportPreview'],
            hide: ['spotlightShell', 'forumState'],
        },
    };

    var _currentView = 'HOME';

    function _getEl(id) {
        return document.getElementById(id);
    }

    function _hideEl(id) {
        var el = _getEl(id);
        if (!el) return;
        el.style.display = 'none';
        el.setAttribute('data-vc-hidden', '1');
    }

    function _showEl(id) {
        var el = _getEl(id);
        if (!el) return;
        el.style.display = '';
        el.removeAttribute('data-vc-hidden');
    }

    function _ensureReportPreview() {
        var el = _getEl('reportPreview');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'reportPreview';
        el.className = 'report-preview';
        el.style.display = 'none';
        document.body.appendChild(el);
        return el;
    }

    function switchView(viewName) {
        viewName = (viewName || '').toUpperCase();
        var config = VIEW_MAP[viewName];
        if (!config) {
            console.warn('[ViewController] unknown view:', viewName);
            return;
        }

        if (viewName === 'REPORT') {
            _ensureReportPreview();
        }

        var allIds = ['spotlightShell', 'forumState', 'reportPreview'];
        allIds.forEach(function (id) {
            if (config.show.indexOf(id) !== -1) {
                _showEl(id);
            } else {
                _hideEl(id);
            }
        });

        if (viewName === 'REPORT') {
            var rp = _getEl('reportPreview');
            if (rp) {
                rp.style.cssText = [
                    'display: block !important',
                    'position: fixed !important',
                    'top: 0 !important',
                    'left: 0 !important',
                    'width: 100vw !important',
                    'height: 100vh !important',
                    'z-index: 10000 !important',
                    'overflow-y: auto !important',
                    'background:',
                    '  radial-gradient(ellipse 80% 60% at 50% 0%, rgba(10,132,255,0.18) 0%, transparent 65%),',
                    '  radial-gradient(ellipse 60% 40% at 80% 100%, rgba(48,209,88,0.10) 0%, transparent 55%),',
                    '  radial-gradient(ellipse 50% 50% at 10% 50%, rgba(94,92,230,0.12) 0%, transparent 60%),',
                    '  linear-gradient(180deg, #050a14 0%, #000000 100%) !important',
                ].join('; ');
                document.body.classList.add('immersive-reader');
            }
        } else {
            document.body.classList.remove('immersive-reader');
            var rp2 = _getEl('reportPreview');
            if (rp2) {
                var iframe = rp2.querySelector('iframe');
                if (iframe) {
                    if (iframe.src && iframe.src.startsWith('blob:')) {
                        URL.revokeObjectURL(iframe.src);
                    }
                    iframe.src = 'about:blank';
                    iframe.remove();
                }
                rp2.style.display = 'none';
                rp2.innerHTML = '';
            }
            var toc = _getEl('reportToc');
            if (toc) {
                toc.classList.add('toc-collapsed');
                toc.hidden = true;
            }
            var handle = _getEl('tocHandle');
            if (handle) {
                handle.classList.remove('toc-handle-expanded');
                handle.style.display = 'none';
            }
            var dlBtn = _getEl('immersiveDownloadBtn');
            if (dlBtn) dlBtn.style.display = 'none';
        }

        if (viewName === 'FORUM') {
            var fs = _getEl('forumState');
            if (fs) fs.setAttribute('aria-hidden', 'false');
        } else {
            var fs2 = _getEl('forumState');
            if (fs2) fs2.setAttribute('aria-hidden', 'true');
        }

        _currentView = viewName;
        console.log('[ViewController] switched to', viewName);
    }

    function getCurrentView() {
        return _currentView;
    }

    window.AppViewController = {
        switchView: switchView,
        getCurrentView: getCurrentView,
    };
})();
