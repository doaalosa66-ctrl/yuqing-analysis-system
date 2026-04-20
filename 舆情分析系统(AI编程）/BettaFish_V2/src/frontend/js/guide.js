(function(){
var STEPS = [0.75, 0.85, 1.0, 1.15, 1.3, 1.5];
var idx = 2;

window.guideZoom = function(dir) {
    if (dir === 0) { idx = 2; }
    else if (dir > 0 && idx < STEPS.length - 1) { idx++; }
    else if (dir < 0 && idx > 0) { idx--; }
    var c = document.getElementById('guideContent');
    var l = document.getElementById('guideZoomLabel');
    if (c) c.style.transform = 'scale(' + STEPS[idx] + ')';
    if (l) l.textContent = Math.round(STEPS[idx] * 100) + '%';
};

// 模态开关动画
var overlay = document.getElementById('guideOverlay');
var modal   = document.getElementById('guideModal');

if (overlay) {
    // 监听 class 变化驱动动画
    var observer = new MutationObserver(function() {
        var open = overlay.classList.contains('open');
        overlay.style.opacity  = open ? '1' : '0';
        overlay.style.pointerEvents = open ? 'auto' : 'none';
        if (modal) modal.style.transform = open
            ? 'scale(1) translateY(0)'
            : 'scale(0.94) translateY(12px)';
        document.body.style.overflow = open ? 'hidden' : '';
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });

    // 点击遮罩关闭
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay.classList.remove('open');
    });
}

// ESC 关闭
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        var o = document.getElementById('guideOverlay');
        if (o) o.classList.remove('open');
    }
});

// Ctrl+滚轮缩放
if (modal) {
    modal.addEventListener('wheel', function(e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        window.guideZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
}
})();