(function () {
'use strict';

/* ── 1. 星空 Canvas（增强版：流星 + 星云粒子 + 高透明度） ── */
const canvas = document.getElementById('starfield');
const ctx    = canvas.getContext('2d');
let W, H, stars = [], meteors = [], animId;

function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
}

// 星点：三种尺寸层次，提升透明度上限
function initStars(count) {
    stars = [];
    for (let i = 0; i < count; i++) {
        const tier = Math.random();
        stars.push({
            x:      Math.random() * W,
            y:      Math.random() * H,
            // 三层：微星 / 普通星 / 亮星
            r:      tier < 0.6 ? Math.random() * 0.8 + 0.3
                  : tier < 0.9 ? Math.random() * 1.2 + 0.8
                  :              Math.random() * 2.0 + 1.5,
            alpha:  Math.random() * 0.5 + 0.5,   // 0.5~1.0，更亮
            dAlpha: (Math.random() * 0.006 + 0.002) * (Math.random() < 0.5 ? 1 : -1),
            speed:  Math.random() * 0.04 + 0.005,
            hue:    tier > 0.9 ? (Math.random() < 0.5 ? 210 : 40) : 0,
            sat:    tier > 0.9 ? Math.floor(Math.random() * 40 + 15) : 0,
        });
    }
}

// 流星池
function spawnMeteor() {
    const angle = Math.PI / 6 + Math.random() * Math.PI / 8; // 约 30-52°
    const speed = Math.random() * 6 + 5;
    meteors.push({
        x:     Math.random() * W * 1.2 - W * 0.1,
        y:     Math.random() * H * 0.4,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed,
        len:   Math.random() * 120 + 60,
        alpha: 0.9,
        life:  1,
        dLife: Math.random() * 0.018 + 0.012,
    });
}

// 随机触发流星（平均每 1-3 秒一批，每批 1-3 颗）
let meteorTimer = 0;
let nextMeteorIn = 1000 + Math.random() * 2000;

function drawFrame(ts) {
    ctx.clearRect(0, 0, W, H);

    // ── 星点 ──
    for (const s of stars) {
        s.alpha += s.dAlpha;
        if (s.alpha >= 1.0) { s.alpha = 1.0; s.dAlpha *= -1; }
        if (s.alpha <= 0.3) { s.alpha = 0.3; s.dAlpha *= -1; }
        s.y -= s.speed;
        if (s.y < -2) s.y = H + 2;

        if (s.sat > 0) {
            ctx.fillStyle = `hsla(${s.hue},${s.sat}%,92%,${s.alpha.toFixed(3)})`;
        } else {
            ctx.fillStyle = `rgba(235,235,245,${s.alpha.toFixed(3)})`;
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();

        // 亮星加十字光晕
        if (s.r > 1.8) {
            ctx.strokeStyle = `rgba(235,235,245,${(s.alpha * 0.25).toFixed(3)})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(s.x - s.r * 3, s.y);
            ctx.lineTo(s.x + s.r * 3, s.y);
            ctx.moveTo(s.x, s.y - s.r * 3);
            ctx.lineTo(s.x, s.y + s.r * 3);
            ctx.stroke();
        }
    }

    // ── 流星 ──
    meteorTimer += 16;
    if (meteorTimer >= nextMeteorIn) {
        const batch = Math.floor(Math.random() * 2) + 5; // 每批 5-6 颗
        for (let b = 0; b < batch; b++) spawnMeteor();
        meteorTimer = 0;
        nextMeteorIn = 1000 + Math.random() * 2000;
    }

    for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.x += m.vx;
        m.y += m.vy;
        m.life -= m.dLife;

        if (m.life <= 0) { meteors.splice(i, 1); continue; }

        const tailX = m.x - m.vx * (m.len / Math.hypot(m.vx, m.vy));
        const tailY = m.y - m.vy * (m.len / Math.hypot(m.vx, m.vy));

        const grad = ctx.createLinearGradient(tailX, tailY, m.x, m.y);
        grad.addColorStop(0, `rgba(255,255,255,0)`);
        grad.addColorStop(0.7, `rgba(200,220,255,${(m.life * 0.5).toFixed(3)})`);
        grad.addColorStop(1, `rgba(255,255,255,${(m.life * 0.9).toFixed(3)})`);

        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(m.x, m.y);
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.life * 1.5;
        ctx.lineCap = 'round';
        ctx.stroke();

        // 流星头部光点
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.life * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220,235,255,${(m.life * 0.8).toFixed(3)})`;
        ctx.fill();
    }

    animId = requestAnimationFrame(drawFrame);
}

function boot() {
    resize();
    initStars(420);   // 从 280 升至 420
    drawFrame(0);
}

window.addEventListener('resize', () => {
    resize();
    initStars(420);
});

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    canvas.style.display = 'none';
} else {
    boot();
}

/* ── 2. 参数面板展开/收起 ── */
const paramsBtn = document.getElementById('paramsToggleBtn');
const panel     = document.getElementById('spotlightPanel');

if (paramsBtn && panel) {
    paramsBtn.addEventListener('click', () => {
        const isOpen = panel.classList.toggle('open');
        paramsBtn.classList.toggle('active', isOpen);
        paramsBtn.setAttribute('aria-expanded', String(isOpen));
    });

    // 点击面板外部关闭
    document.addEventListener('click', (e) => {
        if (!panel.contains(e.target) && !paramsBtn.contains(e.target)) {
            panel.classList.remove('open');
            paramsBtn.classList.remove('active');
            paramsBtn.setAttribute('aria-expanded', 'false');
        }
    });
}

/* ── 3. 上传模板：同步状态到面板指示灯 ── */
const fileInput   = document.getElementById('templateFileInput');
const fileDot     = document.getElementById('fileDot');
const fileLabel   = document.getElementById('fileStatusLabel');
const uploadHint  = document.getElementById('uploadStatus');

if (fileInput) {
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            if (fileDot)  { fileDot.className = 'breath-dot'; }
            if (fileLabel) fileLabel.textContent = file.name;
        }
    });
}

// 监听原业务逻辑写入 uploadStatus 的内容，同步到面板提示
if (uploadHint) {
    const observer = new MutationObserver(() => {
        const txt = uploadHint.textContent.trim();
        if (!txt) return;
        // 根据原有 class 判断成功/失败
        if (uploadHint.classList.contains('success')) {
            uploadHint.className = 'spotlight-upload-hint success';
        } else if (uploadHint.classList.contains('error')) {
            uploadHint.className = 'spotlight-upload-hint error';
        } else {
            uploadHint.className = 'spotlight-upload-hint';
        }
    });
    observer.observe(uploadHint, { childList: true, subtree: true, attributes: true });
}

/* ── 4. 搜索提交时：Spotlight 收缩到顶部，主工作区淡入 ── */
const searchBtn   = document.getElementById('searchButton');
const shell       = document.getElementById('spotlightShell');
const mainContent = document.querySelector('.main-content');
const statusBar   = document.querySelector('.status-bar');

function activateWorkspace() {
    if (!shell) return;
    shell.classList.add('submitted');
    if (mainContent) mainContent.classList.add('visible');
    if (statusBar)   statusBar.classList.add('visible');
}
// 暴露到全局
window.activateWorkspace = activateWorkspace;

/* 搜索按钮的独立 activateWorkspace 监听已移除，
   页面切换统一由 performSearch() 控制 */

})();