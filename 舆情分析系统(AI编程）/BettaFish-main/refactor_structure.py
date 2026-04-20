"""
BettaFish V2 目录重构脚本
将现有项目重组为商用级 BettaFish_V2 架构，并自动更新核心文件中的路径引用。

用法：
    python refactor_structure.py [--dry-run]

    --dry-run  仅打印将要执行的操作，不实际移动文件或修改代码
"""

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

# ─────────────────────────────────────────────
# 配置：源目录（当前项目根）与目标目录（新架构根）
# ─────────────────────────────────────────────
SRC_ROOT = Path(__file__).resolve().parent          # BettaFish-main/
DEST_ROOT = SRC_ROOT.parent / "BettaFish_V2"        # 与 BettaFish-main 同级

# ─────────────────────────────────────────────
# 目录搬迁映射表：(源相对路径, 目标相对路径)
# ─────────────────────────────────────────────
DIR_MOVES = [
    # 源码
    ("frontend",            "src/frontend"),
    ("backend",             "src/backend"),
    ("InsightEngine",       "src/engines/InsightEngine"),
    ("MediaEngine",         "src/engines/MediaEngine"),
    ("QueryEngine",         "src/engines/QueryEngine"),
    ("ReportEngine",        "src/engines/ReportEngine"),
    ("ForumEngine",         "src/engines/ForumEngine"),
    ("MindSpider",          "src/spider/MindSpider"),
    ("utils",               "src/backend/utils"),
    ("SingleEngineApp",     "src/backend/SingleEngineApp"),
    # 数据
    ("db_data",             "data/db"),
    ("data",                "data/cache"),
    # 输出
    ("reports",             "outputs/raw_md"),
    ("final_reports",       "outputs/final_exports"),
    # 运维
    ("logs",                "ops/logs"),
    # 测试（保留在 src 下）
    ("tests",               "src/tests"),
]

# ─────────────────────────────────────────────
# 单文件搬迁映射表：(源相对路径, 目标相对路径)
# ─────────────────────────────────────────────
FILE_MOVES = [
    ("config.py",           "src/backend/config.py"),
    ("runner.py",           "src/backend/runner.py"),
    ("requirements.txt",    "requirements.txt"),
    (".env",                "ops/config/.env"),
    (".env.example",        "ops/config/.env.example"),
    ("docker-compose.yml",  "docker-compose.yml"),
    ("Dockerfile",          "Dockerfile"),
    (".gitignore",          ".gitignore"),
    (".gitattributes",      ".gitattributes"),
    ("README.md",           "README.md"),
]

# ─────────────────────────────────────────────
# 路径替换规则：(文件相对于 DEST_ROOT, [(旧字符串, 新字符串), ...])
# ─────────────────────────────────────────────
PATH_PATCHES = {
    # ── backend/app.py ──────────────────────────────────────────────────────
    "src/backend/app.py": [
        # PROJECT_ROOT 现在是 src/backend 的上上级，即 BettaFish_V2/
        (
            '_PROJECT_ROOT = Path(__file__).resolve().parent.parent',
            '_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent'
        ),
        # frontend 目录移到 src/frontend
        (
            '_FRONTEND_DIR = _PROJECT_ROOT / "frontend"  # 修复：强制指向 frontend 目录',
            '_FRONTEND_DIR = _PROJECT_ROOT / "src" / "frontend"'
        ),
        # logs 目录移到 ops/logs
        (
            "LOG_DIR = _PROJECT_ROOT / 'logs'",
            "LOG_DIR = _PROJECT_ROOT / 'ops' / 'logs'"
        ),
        # config.py 移到 src/backend/config.py，sys.path 已包含 src/backend，无需改 import
        # reports 目录（历史报告扫描）移到 outputs/raw_md
        (
            "reports_dir = _PROJECT_ROOT / 'reports'",
            "reports_dir = _PROJECT_ROOT / 'outputs' / 'raw_md'"
        ),
        # get_report_result 中的 possible_dirs
        (
            '        ("base_dir/reports", base_dir / "reports"),\n'
            '        ("cwd/reports", cwd / "reports"),\n'
            '        ("cwd.parent/reports", cwd.parent / "reports"),',
            '        ("base_dir/outputs/raw_md", base_dir / "outputs" / "raw_md"),\n'
            '        ("cwd/outputs/raw_md", cwd / "outputs" / "raw_md"),\n'
            '        ("cwd.parent/outputs/raw_md", cwd.parent / "outputs" / "raw_md"),'
        ),
        # flask_interface 中的 possible_dirs（ReportEngine/flask_interface.py 里也有，单独处理）
        # runner import：runner.py 也在 src/backend，sys.path 已包含，无需改
    ],

    # ── ReportEngine/utils/config.py ────────────────────────────────────────
    "src/engines/ReportEngine/utils/config.py": [
        # 输出目录
        (
            'OUTPUT_DIR: str = Field("final_reports", description="主输出目录")',
            'OUTPUT_DIR: str = Field("outputs/final_exports", description="主输出目录")'
        ),
        (
            'CHAPTER_OUTPUT_DIR: str = Field(\n'
            '        "final_reports/chapters", description="章节JSON缓存目录"\n'
            '    )',
            'CHAPTER_OUTPUT_DIR: str = Field(\n'
            '        "outputs/final_exports/chapters", description="章节JSON缓存目录"\n'
            '    )'
        ),
        (
            'DOCUMENT_IR_OUTPUT_DIR: str = Field(\n'
            '        "final_reports/ir", description="整本IR/Manifest输出目录"\n'
            '    )',
            'DOCUMENT_IR_OUTPUT_DIR: str = Field(\n'
            '        "outputs/final_exports/ir", description="整本IR/Manifest输出目录"\n'
            '    )'
        ),
        # 模板目录
        (
            'TEMPLATE_DIR: str = Field("ReportEngine/report_template", description="多模板目录")',
            'TEMPLATE_DIR: str = Field("src/engines/ReportEngine/report_template", description="多模板目录")'
        ),
        # 日志文件
        (
            'LOG_FILE: str = Field("logs/report.log", description="日志输出文件")',
            'LOG_FILE: str = Field("ops/logs/report.log", description="日志输出文件")'
        ),
        (
            'JSON_ERROR_LOG_DIR: str = Field(\n'
            '        "logs/json_repair_failures", description="无法修复的JSON块落盘目录"\n'
            '    )',
            'JSON_ERROR_LOG_DIR: str = Field(\n'
            '        "ops/logs/json_repair_failures", description="无法修复的JSON块落盘目录"\n'
            '    )'
        ),
    ],

    # ── ReportEngine/flask_interface.py ─────────────────────────────────────
    "src/engines/ReportEngine/flask_interface.py": [
        # check_engines_ready 中的输入目录（Streamlit 报告目录，保持不变，这些是运行时产物）
        # possible_dirs 中的 reports 路径
        (
            '        base_dir / "reports",\n'
            '        Path.cwd() / "reports"',
            '        base_dir / "outputs" / "raw_md",\n'
            '        Path.cwd() / "outputs" / "raw_md"'
        ),
    ],

    # ── docker-compose.yml ───────────────────────────────────────────────────
    "docker-compose.yml": [
        (
            '      - ./logs:/app/logs',
            '      - ./ops/logs:/app/ops/logs'
        ),
        (
            '      - ./final_reports:/app/final_reports',
            '      - ./outputs/final_exports:/app/outputs/final_exports'
        ),
        (
            '      - ./db_data:/var/lib/postgresql/data',
            '      - ./data/db:/var/lib/postgresql/data'
        ),
        (
            '      - ./.env:/app/.env',
            '      - ./ops/config/.env:/app/.env'
        ),
    ],
}

# ─────────────────────────────────────────────
# 新建 .gitignore 追加内容（屏蔽大体积目录）
# ─────────────────────────────────────────────
GITIGNORE_ADDITIONS = """
# V2 架构：屏蔽数据、输出与日志
data/
outputs/
ops/logs/
ops/config/.env
__pycache__/
*.pyc
.env
"""


# ═════════════════════════════════════════════
# 工具函数
# ═════════════════════════════════════════════

def log(msg: str, dry_run: bool = False):
    prefix = "[DRY-RUN] " if dry_run else "[ACTION]  "
    print(prefix + msg)


def move_dir(src: Path, dest: Path, dry_run: bool):
    if not src.exists():
        print(f"[SKIP]    源目录不存在，跳过: {src}")
        return
    log(f"移动目录  {src.relative_to(SRC_ROOT)}  →  {dest.relative_to(DEST_ROOT)}", dry_run)
    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(str(src), str(dest), dirs_exist_ok=True)


def move_file(src: Path, dest: Path, dry_run: bool):
    if not src.exists():
        print(f"[SKIP]    源文件不存在，跳过: {src}")
        return
    log(f"移动文件  {src.relative_to(SRC_ROOT)}  →  {dest.relative_to(DEST_ROOT)}", dry_run)
    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src), str(dest))


def patch_file(rel_path: str, replacements: list, dry_run: bool):
    target = DEST_ROOT / rel_path
    if not target.exists():
        print(f"[SKIP]    补丁目标不存在，跳过: {target}")
        return

    content = target.read_text(encoding="utf-8")
    changed = False
    for old, new in replacements:
        if old in content:
            content = content.replace(old, new, 1)
            changed = True
            log(f"补丁  {rel_path}  替换: {repr(old[:60])}...", dry_run)
        else:
            print(f"[WARN]    未找到替换目标（可能已修改）: {repr(old[:60])}...")

    if changed and not dry_run:
        target.write_text(content, encoding="utf-8")


def create_placeholder_dirs(dry_run: bool):
    """创建空目录并放置 .gitkeep，确保 git 能追踪空目录。"""
    placeholders = [
        "docs/prd",
        "docs/architecture",
        "docs/api",
        "docs/prompts",
        "data/db",
        "data/cache",
        "outputs/raw_md",
        "outputs/final_exports",
        "ops/logs",
        "ops/scripts",
        "ops/config",
    ]
    for p in placeholders:
        d = DEST_ROOT / p
        log(f"创建目录  {p}", dry_run)
        if not dry_run:
            d.mkdir(parents=True, exist_ok=True)
            keeper = d / ".gitkeep"
            if not keeper.exists():
                keeper.touch()


def update_gitignore(dry_run: bool):
    gi = DEST_ROOT / ".gitignore"
    if not gi.exists():
        return
    content = gi.read_text(encoding="utf-8")
    if "data/" not in content:
        log("更新 .gitignore，追加 V2 屏蔽规则", dry_run)
        if not dry_run:
            gi.write_text(content + GITIGNORE_ADDITIONS, encoding="utf-8")


def update_sys_path_in_app(dry_run: bool):
    """
    app.py 的 sys.path.insert 插入的是 _PROJECT_ROOT（BettaFish_V2/），
    但引擎模块现在在 src/engines/，需要额外把 src/engines 和 src/backend 加入 sys.path。
    """
    target = DEST_ROOT / "src/backend/app.py"
    if not target.exists():
        return

    old_snippet = (
        "_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent\n"
        "if str(_PROJECT_ROOT) not in sys.path:\n"
        "    sys.path.insert(0, str(_PROJECT_ROOT))"
    )
    new_snippet = (
        "_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent\n"
        "if str(_PROJECT_ROOT) not in sys.path:\n"
        "    sys.path.insert(0, str(_PROJECT_ROOT))\n"
        "# V2 架构：引擎包在 src/engines，工具包在 src/backend\n"
        "_ENGINES_DIR = _PROJECT_ROOT / 'src' / 'engines'\n"
        "_BACKEND_DIR = _PROJECT_ROOT / 'src' / 'backend'\n"
        "for _p in [str(_ENGINES_DIR), str(_BACKEND_DIR)]:\n"
        "    if _p not in sys.path:\n"
        "        sys.path.insert(0, _p)"
    )

    content = target.read_text(encoding="utf-8")
    if old_snippet in content:
        log("app.py: 更新 sys.path，加入 src/engines 和 src/backend", dry_run)
        if not dry_run:
            target.write_text(content.replace(old_snippet, new_snippet, 1), encoding="utf-8")
    else:
        print("[WARN]    app.py sys.path 片段未找到，请手动检查")


# ═════════════════════════════════════════════
# 主流程
# ═════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="BettaFish V2 目录重构脚本")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不实际操作")
    args = parser.parse_args()
    dry_run = args.dry_run

    print("=" * 60)
    print(f"  BettaFish V2 重构脚本")
    print(f"  源目录  : {SRC_ROOT}")
    print(f"  目标目录: {DEST_ROOT}")
    print(f"  模式    : {'DRY-RUN（预览）' if dry_run else '实际执行'}")
    print("=" * 60)

    if DEST_ROOT.exists() and not dry_run:
        answer = input(f"\n目标目录 {DEST_ROOT} 已存在，继续将覆盖其中同名内容。继续？[y/N] ").strip().lower()
        if answer != "y":
            print("已取消。")
            sys.exit(0)

    # 1. 创建占位目录
    print("\n── 步骤 1：创建目标目录结构 ──")
    create_placeholder_dirs(dry_run)

    # 2. 搬迁目录
    print("\n── 步骤 2：搬迁目录 ──")
    for src_rel, dest_rel in DIR_MOVES:
        move_dir(SRC_ROOT / src_rel, DEST_ROOT / dest_rel, dry_run)

    # 3. 搬迁单文件
    print("\n── 步骤 3：搬迁单文件 ──")
    for src_rel, dest_rel in FILE_MOVES:
        move_file(SRC_ROOT / src_rel, DEST_ROOT / dest_rel, dry_run)

    # 4. 打补丁：路径替换
    print("\n── 步骤 4：更新代码中的路径引用 ──")
    for rel_path, replacements in PATH_PATCHES.items():
        patch_file(rel_path, replacements, dry_run)

    # 5. 更新 sys.path（app.py 专项）
    print("\n── 步骤 5：更新 app.py sys.path ──")
    update_sys_path_in_app(dry_run)

    # 6. 更新 .gitignore
    print("\n── 步骤 6：更新 .gitignore ──")
    update_gitignore(dry_run)

    print("\n" + "=" * 60)
    if dry_run:
        print("  DRY-RUN 完成。以上为预览，未做任何实际修改。")
        print("  确认无误后，去掉 --dry-run 参数重新运行即可。")
    else:
        print("  重构完成！")
        print(f"  新项目根目录: {DEST_ROOT}")
        print()
        print("  后续手动步骤：")
        print("  1. cd BettaFish_V2 && python src/backend/app.py  验证启动")
        print("  2. 检查 ops/config/.env 中的路径配置是否正确")
        print("  3. 更新 docker-compose.yml 中的 build context（如有）")
        print("  4. 将 docs/ 目录填入 PRD、架构图等文档资产")
    print("=" * 60)


if __name__ == "__main__":
    main()
