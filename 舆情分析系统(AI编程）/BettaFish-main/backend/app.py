"""
Flask主应用 - 舆情分析系统后端
"""

import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PYTHONUTF8'] = '1'
os.environ['PYTHONUNBUFFERED'] = '1'

import subprocess
import time
import threading
from datetime import datetime
from queue import Queue
from flask import Flask, render_template, request, jsonify, Response
from flask_socketio import SocketIO, emit
import atexit
from loguru import logger
import importlib
from MindSpider.main import MindSpider

try:
    from ReportEngine.flask_interface import report_bp, initialize_report_engine
    REPORT_ENGINE_AVAILABLE = True
except ImportError as e:
    logger.error(f"ReportEngine导入失败: {e}")
    REPORT_ENGINE_AVAILABLE = False

_FRONTEND_DIR = _PROJECT_ROOT / "frontend"  # 修复：强制指向 frontend 目录

app = Flask(__name__,
            template_folder=str(_FRONTEND_DIR),
            static_folder=str(_FRONTEND_DIR),
            static_url_path="/static")
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # 👈 强制 Flask 不要缓存任何静态文件(JS/CSS)
app.config['SECRET_KEY'] = 'Dedicated-to-creating-a-concise-and-versatile-public-opinion-analysis-platform'
app.config['TEMPLATES_AUTO_RELOAD'] = True
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 纯Python搜索任务注册表
_search_tasks = {}

# eventlet 在客户端主动断开时偶尔会抛出 ConnectionAbortedError，这里做一次防御性包裹，
# 避免无意义的堆栈污染日志（仅在 eventlet 可用时启用）。
def _patch_eventlet_disconnect_logging():
    try:
        import eventlet.wsgi  # type: ignore
    except Exception as exc:  # pragma: no cover - 仅在生产环境有效
        logger.debug(f"eventlet 不可用，跳过断开补丁: {exc}")
        return

    try:
        original_finish = eventlet.wsgi.HttpProtocol.finish  # type: ignore[attr-defined]
    except Exception as exc:  # pragma: no cover
        logger.debug(f"eventlet 缺少 HttpProtocol.finish，跳过断开补丁: {exc}")
        return

    def _safe_finish(self, *args, **kwargs):  # pragma: no cover - 运行时才会触发
        try:
            return original_finish(self, *args, **kwargs)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as exc:
            try:
                environ = getattr(self, 'environ', {}) or {}
                method = environ.get('REQUEST_METHOD', '')
                path = environ.get('PATH_INFO', '')
                logger.warning(f"客户端已主动断开，忽略异常: {method} {path} ({exc})")
            except Exception:
                logger.warning(f"客户端已主动断开，忽略异常: {exc}")
            return

    eventlet.wsgi.HttpProtocol.finish = _safe_finish  # type: ignore[attr-defined]
    logger.info("已对 eventlet 连接中断进行安全防护")

_patch_eventlet_disconnect_logging()

# 注册ReportEngine Blueprint
if REPORT_ENGINE_AVAILABLE:
    app.register_blueprint(report_bp, url_prefix='/api/report')
    logger.info("ReportEngine接口已注册")
else:
    logger.info("ReportEngine不可用，跳过接口注册")

# 创建日志目录
LOG_DIR = _PROJECT_ROOT / 'logs'
LOG_DIR.mkdir(exist_ok=True)

CONFIG_MODULE_NAME = 'config'
CONFIG_FILE_PATH = _PROJECT_ROOT / 'config.py'
CONFIG_KEYS = [
    'HOST',
    'PORT',
    'DB_DIALECT',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'DB_CHARSET',
    'INSIGHT_ENGINE_API_KEY',
    'INSIGHT_ENGINE_BASE_URL',
    'INSIGHT_ENGINE_MODEL_NAME',
    'MEDIA_ENGINE_API_KEY',
    'MEDIA_ENGINE_BASE_URL',
    'MEDIA_ENGINE_MODEL_NAME',
    'QUERY_ENGINE_API_KEY',
    'QUERY_ENGINE_BASE_URL',
    'QUERY_ENGINE_MODEL_NAME',
    'REPORT_ENGINE_API_KEY',
    'REPORT_ENGINE_BASE_URL',
    'REPORT_ENGINE_MODEL_NAME',
    'FORUM_HOST_API_KEY',
    'FORUM_HOST_BASE_URL',
    'FORUM_HOST_MODEL_NAME',
    'KEYWORD_OPTIMIZER_API_KEY',
    'KEYWORD_OPTIMIZER_BASE_URL',
    'KEYWORD_OPTIMIZER_MODEL_NAME',
    'TAVILY_API_KEY',
    'SEARCH_TOOL_TYPE',
    'BOCHA_WEB_SEARCH_API_KEY',
    'ANSPIRE_API_KEY',
    'CACHE_ENABLED',
    'CACHE_TTL_HOURS',
]


def _load_config_module():
    """Load or reload the config module to ensure latest values are available."""
    importlib.invalidate_caches()
    module = sys.modules.get(CONFIG_MODULE_NAME)
    try:
        if module is None:
            module = importlib.import_module(CONFIG_MODULE_NAME)
        else:
            module = importlib.reload(module)
    except ModuleNotFoundError:
        return None
    return module


def read_config_values():
    """Return the current configuration values that are exposed to the frontend."""
    try:
        # 重新加载配置以获取最新的 Settings 实例
        from config import reload_settings
        current_settings = reload_settings()

        values = {}
        for key in CONFIG_KEYS:
            # 从 Pydantic Settings 实例读取值
            value = getattr(current_settings, key, None)
            # Convert to string for uniform handling on the frontend.
            if value is None:
                values[key] = ''
            else:
                values[key] = str(value)
        return values
    except Exception as exc:
        logger.exception(f"读取配置失败: {exc}")
        return {}


def _serialize_config_value(value):
    """Serialize Python values back to a config.py assignment-friendly string."""
    if isinstance(value, bool):
        return 'True' if value else 'False'
    if isinstance(value, (int, float)):
        return str(value)
    if value is None:
        return 'None'

    value_str = str(value)
    escaped = value_str.replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'


def write_config_values(updates):
    """Persist configuration updates to .env file (Pydantic Settings source)."""
    from pathlib import Path
    
    # 确定 .env 文件路径（与 config.py 中的逻辑一致）
    project_root = _PROJECT_ROOT
    cwd_env = Path.cwd() / ".env"
    env_file_path = cwd_env if cwd_env.exists() else (project_root / ".env")
    
    # 读取现有的 .env 文件内容
    env_lines = []
    env_key_indices = {}  # 记录每个键在文件中的索引位置
    if env_file_path.exists():
        env_lines = env_file_path.read_text(encoding='utf-8').splitlines()
        # 提取已存在的键及其索引
        for i, line in enumerate(env_lines):
            line_stripped = line.strip()
            if line_stripped and not line_stripped.startswith('#'):
                if '=' in line_stripped:
                    key = line_stripped.split('=')[0].strip()
                    env_key_indices[key] = i
    
    # 更新或添加配置项
    for key, raw_value in updates.items():
        # 格式化值用于 .env 文件（不需要引号，除非是字符串且包含空格）
        if raw_value is None or raw_value == '':
            env_value = ''
        elif isinstance(raw_value, (int, float)):
            env_value = str(raw_value)
        elif isinstance(raw_value, bool):
            env_value = 'True' if raw_value else 'False'
        else:
            value_str = str(raw_value)
            # 如果包含空格或特殊字符，需要引号
            if ' ' in value_str or '\n' in value_str or '#' in value_str:
                escaped = value_str.replace('\\', '\\\\').replace('"', '\\"')
                env_value = f'"{escaped}"'
            else:
                env_value = value_str
        
        # 更新或添加配置项
        if key in env_key_indices:
            # 更新现有行
            env_lines[env_key_indices[key]] = f'{key}={env_value}'
        else:
            # 添加新行到文件末尾
            env_lines.append(f'{key}={env_value}')
    
    # 写入 .env 文件
    env_file_path.parent.mkdir(parents=True, exist_ok=True)
    env_file_path.write_text('\n'.join(env_lines) + '\n', encoding='utf-8')
    
    # 重新加载配置模块（这会重新读取 .env 文件并创建新的 Settings 实例）
    _load_config_module()


system_state_lock = threading.Lock()
system_state = {
    'started': False,
    'starting': False,
    'shutdown_in_progress': False
}


def _set_system_state(*, started=None, starting=None):
    """Safely update the cached system state flags."""
    with system_state_lock:
        if started is not None:
            system_state['started'] = started
        if starting is not None:
            system_state['starting'] = starting


def _get_system_state():
    """Return a shallow copy of the system state flags."""
    with system_state_lock:
        return system_state.copy()


def _prepare_system_start():
    """Mark the system as starting if it is not already running or starting."""
    with system_state_lock:
        if system_state['started']:
            return False, '系统已启动'
        if system_state['starting']:
            return False, '系统正在启动'
        system_state['starting'] = True
        return True, None

def _mark_shutdown_requested():
    """标记关机已请求；若已有关机流程则返回 False。"""
    with system_state_lock:
        if system_state.get('shutdown_in_progress'):
            return False
        system_state['shutdown_in_progress'] = True
        return True


def _emit_start_progress(app, status, message):
    """向前端推送启动进度。"""
    try:
        socketio.emit('system_start_progress', {'app': app, 'status': status, 'message': message})
    except Exception:
        pass


def initialize_system_components():
    """启动所有依赖组件（数据库、ForumEngine、ReportEngine）。Streamlit 子应用已废弃，系统改用纯 Python runner。"""
    import time as _time
    _t0 = _time.time()
    logs = []
    errors = []
    logger.info("[系统启动] ========== initialize_system_components 开始 ==========")

    # ---- 数据库 ----
    _emit_start_progress('db', 'starting', '正在初始化数据库...')
    try:
        spider = MindSpider()
        if spider.initialize_database():
            logger.info("[系统启动] 数据库初始化成功")
            _emit_start_progress('db', 'running', '数据库初始化成功')
        else:
            logger.error("[系统启动] 数据库初始化失败（返回False）")
            _emit_start_progress('db', 'error', '数据库初始化失败')
            errors.append("数据库初始化失败")
    except Exception as exc:
        logger.exception(f"[系统启动] 数据库初始化异常: {exc}")
        _emit_start_progress('db', 'error', f'数据库异常: {exc}')
        errors.append(f"数据库异常: {exc}")

    # ---- ForumEngine ----
    try:
        stop_forum_engine()
    except Exception:
        pass
    processes['forum']['status'] = 'stopped'

    _emit_start_progress('forum', 'starting', '正在启动 ForumEngine...')
    logger.info("[系统启动] 启动 ForumEngine...")
    try:
        start_forum_engine()
        processes['forum']['status'] = 'running'
        logs.append("ForumEngine 启动完成")
        _emit_start_progress('forum', 'running', 'ForumEngine 启动成功')
        logger.info("[系统启动] ✓ ForumEngine 启动成功")
    except Exception as exc:
        error_msg = f"ForumEngine 启动失败: {exc}"
        logs.append(error_msg)
        errors.append(error_msg)
        _emit_start_progress('forum', 'error', error_msg)
        logger.exception(f"[系统启动] ✗ ForumEngine 启动异常: {exc}")

    # ---- ReportEngine ----
    if REPORT_ENGINE_AVAILABLE:
        _emit_start_progress('report', 'starting', '正在初始化 ReportEngine...')
        logger.info("[系统启动] 初始化 ReportEngine...")
        try:
            if initialize_report_engine():
                logs.append("ReportEngine 初始化成功")
                _emit_start_progress('report', 'running', 'ReportEngine 初始化成功')
                logger.info("[系统启动] ✓ ReportEngine 初始化成功")
            else:
                msg = "ReportEngine 初始化失败"
                logs.append(msg)
                errors.append(msg)
                _emit_start_progress('report', 'error', msg)
                logger.error("[系统启动] ✗ ReportEngine 初始化失败（返回False）")
        except Exception as exc:
            msg = f"ReportEngine 初始化异常: {exc}"
            logs.append(msg)
            errors.append(msg)
            _emit_start_progress('report', 'error', msg)
            logger.exception(f"[系统启动] ✗ ReportEngine 初始化异常: {exc}")
    else:
        logger.warning("[系统启动] ReportEngine 不可用，跳过初始化")

    _t2 = _time.time()
    logger.info(f"[系统启动] ========== 启动完成 总耗时={_t2-_t0:.1f}s, 错误={len(errors)} ==========")
    if errors:
        logger.warning(f"[系统启动] 错误汇总: {errors}")

    return True, logs, errors

# 初始化ForumEngine的forum.log文件
def init_forum_log():
    """初始化forum.log文件"""
    try:
        forum_log_file = LOG_DIR / "forum.log"
        # 检查文件不存在则创建并且写一个开始，存在就清空写一个开始
        if not forum_log_file.exists():
            with open(forum_log_file, 'w', encoding='utf-8') as f:
                start_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                f.write(f"=== ForumEngine 系统初始化 - {start_time} ===\n")
            logger.info(f"ForumEngine: forum.log 已初始化")
        else:
            with open(forum_log_file, 'w', encoding='utf-8') as f:
                start_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                f.write(f"=== ForumEngine 系统初始化 - {start_time} ===\n")
            logger.info(f"ForumEngine: forum.log 已初始化")
    except Exception as e:
        logger.exception(f"ForumEngine: 初始化forum.log失败: {e}")

# 初始化forum.log
init_forum_log()

# 启动ForumEngine智能监控
def start_forum_engine():
    """启动ForumEngine论坛"""
    try:
        from ForumEngine.monitor import start_forum_monitoring
        logger.info("ForumEngine: 启动论坛...")
        success = start_forum_monitoring()
        if not success:
            logger.info("ForumEngine: 论坛启动失败")
    except Exception as e:
        logger.exception(f"ForumEngine: 启动论坛失败: {e}")

# 停止ForumEngine智能监控
def stop_forum_engine():
    """停止ForumEngine论坛"""
    try:
        from ForumEngine.monitor import stop_forum_monitoring
        logger.info("ForumEngine: 停止论坛...")
        stop_forum_monitoring()
        logger.info("ForumEngine: 论坛已停止")
    except Exception as e:
        logger.exception(f"ForumEngine: 停止论坛失败: {e}")

def parse_forum_log_line(line):
    """解析forum.log行内容，提取对话信息"""
    import re
    
    # 匹配格式: [时间] [来源] 内容（来源允许大小写及空格）
    pattern = r'\[(\d{2}:\d{2}:\d{2})\]\s*\[([^\]]+)\]\s*(.*)'
    match = re.match(pattern, line)
    
    if not match:
        return None

    timestamp, raw_source, content = match.groups()
    source = raw_source.strip().upper()

    # 过滤掉系统消息和空内容
    if source == 'SYSTEM' or not content.strip():
        return None
    
    # 支持三个Agent和主持人
    if source not in ['QUERY', 'INSIGHT', 'MEDIA', 'HOST']:
        return None
    
    # 解码日志中的转义换行，保留多行格式
    cleaned_content = content.replace('\\n', '\n').replace('\\r', '').strip()
    
    # 根据来源确定消息类型和发送者
    if source == 'HOST':
        message_type = 'host'
        sender = 'Forum Host'
    else:
        message_type = 'agent'
        sender = f'{source.title()} Engine'
    
    return {
        'type': message_type,
        'sender': sender,
        'content': cleaned_content,
        'timestamp': timestamp,
        'source': source
    }

# Forum日志监听器
# 存储每个客户端的历史日志发送位置
forum_log_positions = {}

def monitor_forum_log():
    """监听forum.log文件变化并推送到前端"""
    import time
    from pathlib import Path

    forum_log_file = LOG_DIR / "forum.log"
    last_position = 0
    processed_lines = set()  # 用于跟踪已处理的行，避免重复

    # 如果文件存在，获取初始位置但不跳过内容
    if forum_log_file.exists():
        with open(forum_log_file, 'r', encoding='utf-8', errors='ignore') as f:
            # 记录文件大小，但不添加到processed_lines
            # 这样用户打开forum标签时可以获取历史
            f.seek(0, 2)  # 移到文件末尾
            last_position = f.tell()

    while True:
        try:
            if forum_log_file.exists():
                with open(forum_log_file, 'r', encoding='utf-8', errors='ignore') as f:
                    f.seek(last_position)
                    new_lines = f.readlines()

                    if new_lines:
                        for line in new_lines:
                            line = line.rstrip('\n\r')
                            if line.strip():
                                line_hash = hash(line.strip())

                                # 避免重复处理同一行
                                if line_hash in processed_lines:
                                    continue

                                processed_lines.add(line_hash)

                                # 解析日志行并发送forum消息
                                parsed_message = parse_forum_log_line(line)
                                if parsed_message:
                                    socketio.emit('forum_message', parsed_message)

                                # 只有在控制台显示forum时才发送控制台消息
                                timestamp = datetime.now().strftime('%H:%M:%S')
                                formatted_line = f"[{timestamp}] {line}"
                                socketio.emit('console_output', {
                                    'app': 'forum',
                                    'line': formatted_line
                                })

                        last_position = f.tell()

                        # 清理processed_lines集合，避免内存泄漏（保留最近1000行的哈希）
                        if len(processed_lines) > 1000:
                            # 保留最近500行的哈希
                            recent_hashes = list(processed_lines)[-500:]
                            processed_lines = set(recent_hashes)

            time.sleep(1)  # 每秒检查一次
        except Exception as e:
            logger.error(f"Forum日志监听错误: {e}")
            time.sleep(5)

# 启动Forum日志监听线程
forum_monitor_thread = threading.Thread(target=monitor_forum_log, daemon=True)
forum_monitor_thread.start()

# 全局变量存储进程信息
processes = {
    'insight': {'process': None, 'status': 'stopped', 'output': [], 'log_file': None},
    'media': {'process': None, 'status': 'stopped', 'output': [], 'log_file': None},
    'query': {'process': None, 'status': 'stopped', 'output': [], 'log_file': None},
    'forum': {'process': None, 'status': 'stopped', 'output': [], 'log_file': None}
}

def _log_shutdown_step(message: str):
    """统一记录关机步骤，便于排查。"""
    logger.info(f"[Shutdown] {message}")


def _describe_running_children():
    """列出当前存活的子进程。"""
    running = []
    for name, info in processes.items():
        proc = info.get('process')
        if proc is not None and proc.poll() is None:
            running.append(f"{name}(pid={proc.pid})")
    return running

# 输出队列
output_queues = {
    'insight': Queue(),
    'media': Queue(),
    'query': Queue(),
    'forum': Queue()
}

def write_log_to_file(app_name, line):
    """将日志写入文件"""
    try:
        log_file_path = LOG_DIR / f"{app_name}.log"
        with open(log_file_path, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
            f.flush()
    except Exception as e:
        logger.error(f"Error writing log for {app_name}: {e}")

def read_log_from_file(app_name, tail_lines=None):
    """从文件读取日志"""
    try:
        log_file_path = LOG_DIR / f"{app_name}.log"
        if not log_file_path.exists():
            return []
        
        with open(log_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            lines = [line.rstrip('\n\r') for line in lines if line.strip()]
            
            if tail_lines:
                return lines[-tail_lines:]
            return lines
    except Exception as e:
        logger.exception(f"Error reading log for {app_name}: {e}")
        return []

def read_process_output(process, app_name):
    """读取进程输出并写入文件"""
    import select
    import sys
    
    while True:
        try:
            if process.poll() is not None:
                # 进程结束，读取剩余输出
                remaining_output = process.stdout.read()
                if remaining_output:
                    lines = remaining_output.decode('utf-8', errors='replace').split('\n')
                    for line in lines:
                        line = line.strip()
                        if line:
                            timestamp = datetime.now().strftime('%H:%M:%S')
                            formatted_line = f"[{timestamp}] {line}"
                            write_log_to_file(app_name, formatted_line)
                            socketio.emit('console_output', {
                                'app': app_name,
                                'line': formatted_line
                            })
                break
            
            # 使用非阻塞读取
            if sys.platform == 'win32':
                # Windows下使用不同的方法
                output = process.stdout.readline()
                if output:
                    line = output.decode('utf-8', errors='replace').strip()
                    if line:
                        timestamp = datetime.now().strftime('%H:%M:%S')
                        formatted_line = f"[{timestamp}] {line}"
                        
                        # 写入日志文件
                        write_log_to_file(app_name, formatted_line)
                        
                        # 发送到前端
                        socketio.emit('console_output', {
                            'app': app_name,
                            'line': formatted_line
                        })
                else:
                    # 没有输出时短暂休眠
                    time.sleep(0.1)
            else:
                # Unix系统使用select
                ready, _, _ = select.select([process.stdout], [], [], 0.1)
                if ready:
                    output = process.stdout.readline()
                    if output:
                        line = output.decode('utf-8', errors='replace').strip()
                        if line:
                            timestamp = datetime.now().strftime('%H:%M:%S')
                            formatted_line = f"[{timestamp}] {line}"
                            
                            # 写入日志文件
                            write_log_to_file(app_name, formatted_line)
                            
                            # 发送到前端
                            socketio.emit('console_output', {
                                'app': app_name,
                                'line': formatted_line
                            })
                            
        except Exception as e:
            error_msg = f"Error reading output for {app_name}: {e}"
            logger.exception(error_msg)
            write_log_to_file(app_name, f"[{datetime.now().strftime('%H:%M:%S')}] {error_msg}")
            break

def check_app_status():
    """检查应用状态（简化版：仅检查 forum 进程存活）"""
    status_changed = False
    for app_name, info in processes.items():
        if info['process'] is not None:
            if info['process'].poll() is not None:
                prev_status = info.get('status', 'unknown')
                info['process'] = None
                info['status'] = 'stopped'
                if prev_status not in ('stopped', 'unknown'):
                    ts = datetime.now().strftime('%H:%M:%S')
                    msg = f"[{ts}] [{app_name.upper()}] ⚠️ 引擎进程已退出（上一状态：{prev_status}）"
                    write_log_to_file(app_name, msg)
                    socketio.emit('console_output', {'app': app_name, 'line': msg})
                    status_changed = True

    if status_changed:
        socketio.emit('status_update', {
            app_name: {'status': info['status']}
            for app_name, info in processes.items()
        })

def cleanup_processes():
    """清理所有进程"""
    _log_shutdown_step("开始清理子进程")
    processes['forum']['status'] = 'stopped'
    try:
        stop_forum_engine()
    except Exception:  # pragma: no cover
        logger.exception("停止ForumEngine失败")
    _log_shutdown_step("子进程清理完成")
    _set_system_state(started=False, starting=False)

def cleanup_processes_concurrent(timeout: float = 6.0):
    """并发清理所有子进程，超时后强制杀掉残留进程。"""
    _log_shutdown_step(f"开始并发清理子进程（超时 {timeout}s）")
    running_before = _describe_running_children()
    if running_before:
        _log_shutdown_step("当前存活子进程: " + ", ".join(running_before))
    else:
        _log_shutdown_step("未检测到存活子进程，仍将发送关闭指令")

    threads = []

    forum_thread = threading.Thread(target=stop_forum_engine, daemon=True)
    threads.append(forum_thread)
    forum_thread.start()

    end_time = time.time() + timeout
    for t in threads:
        remaining = end_time - time.time()
        if remaining <= 0:
            break
        t.join(timeout=remaining)

    processes['forum']['status'] = 'stopped'
    _log_shutdown_step("并发清理结束，标记系统未启动")
    _set_system_state(started=False, starting=False)

def _schedule_server_shutdown(delay_seconds: float = 0.1):
    """在清理完成后尽快退出，避免阻塞当前请求。"""
    def _shutdown():
        time.sleep(delay_seconds)
        try:
            socketio.stop()
        except Exception as exc:  # pragma: no cover
            logger.warning(f"SocketIO 停止时异常，继续退出: {exc}")
        _log_shutdown_step("SocketIO 停止指令已发送，即将退出主进程")
        os._exit(0)

    threading.Thread(target=_shutdown, daemon=True).start()

def _start_async_shutdown(cleanup_timeout: float = 3.0):
    """异步触发清理并强制退出，避免HTTP请求阻塞。"""
    _log_shutdown_step(f"收到关机指令，启动异步清理（超时 {cleanup_timeout}s）")

    def _force_exit():
        _log_shutdown_step("关机超时，触发强制退出")
        os._exit(0)

    # 硬超时保护，即便清理线程异常也能退出
    hard_timeout = cleanup_timeout + 2.0
    force_timer = threading.Timer(hard_timeout, _force_exit)
    force_timer.daemon = True
    force_timer.start()

    def _cleanup_and_exit():
        try:
            cleanup_processes_concurrent(timeout=cleanup_timeout)
        except Exception as exc:  # pragma: no cover
            logger.exception(f"关机清理异常: {exc}")
        finally:
            _log_shutdown_step("清理线程结束，调度主进程退出")
            _schedule_server_shutdown(0.05)

    threading.Thread(target=_cleanup_and_exit, daemon=True).start()

# 注册清理函数
atexit.register(cleanup_processes)

@app.route('/')
def index():
    """主页"""
    return render_template('index.html')

@app.route('/favicon.ico')
def favicon():
    return '', 204

@app.route('/api/status')
def get_status():
    """获取所有应用状态"""
    check_app_status()
    return jsonify({
        app_name: {
            'status': info['status'],
            'output_lines': len(info['output'])
        }
        for app_name, info in processes.items()
    })

@app.route('/api/start/<app_name>')
def start_app(app_name):
    """启动指定应用"""
    if app_name not in processes:
        return jsonify({'success': False, 'message': '未知应用'})

    if app_name == 'forum':
        try:
            start_forum_engine()
            processes['forum']['status'] = 'running'
            return jsonify({'success': True, 'message': 'ForumEngine已启动'})
        except Exception as exc:  # pragma: no cover
            logger.exception("手动启动ForumEngine失败")
            return jsonify({'success': False, 'message': f'ForumEngine启动失败: {exc}'})

    return jsonify({'success': False, 'message': 'Streamlit引擎已废弃，请使用搜索功能'})

@app.route('/api/stop/<app_name>')
def stop_app(app_name):
    """停止指定应用"""
    if app_name not in processes:
        return jsonify({'success': False, 'message': '未知应用'})

    if app_name == 'forum':
        try:
            stop_forum_engine()
            processes['forum']['status'] = 'stopped'
            return jsonify({'success': True, 'message': 'ForumEngine已停止'})
        except Exception as exc:  # pragma: no cover
            logger.exception("手动停止ForumEngine失败")
            return jsonify({'success': False, 'message': f'ForumEngine停止失败: {exc}'})

    return jsonify({'success': False, 'message': 'Streamlit引擎已废弃'})

@app.route('/api/output/<app_name>')
def get_output(app_name):
    """获取应用输出"""
    if app_name not in processes:
        return jsonify({'success': False, 'message': '未知应用'})
    
    # 特殊处理Forum Engine
    if app_name == 'forum':
        try:
            forum_log_content = read_log_from_file('forum')
            return jsonify({
                'success': True,
                'output': forum_log_content,
                'total_lines': len(forum_log_content)
            })
        except Exception as e:
            return jsonify({'success': False, 'message': f'读取forum日志失败: {str(e)}'})
    
    # 从文件读取完整日志
    output_lines = read_log_from_file(app_name)
    
    return jsonify({
        'success': True,
        'output': output_lines
    })

@app.route('/api/test_log/<app_name>')
def test_log(app_name):
    """测试日志写入功能"""
    if app_name not in processes:
        return jsonify({'success': False, 'message': '未知应用'})
    
    # 写入测试消息
    test_msg = f"[{datetime.now().strftime('%H:%M:%S')}] 测试日志消息 - {datetime.now()}"
    write_log_to_file(app_name, test_msg)
    
    # 通过Socket.IO发送
    socketio.emit('console_output', {
        'app': app_name,
        'line': test_msg
    })
    
    return jsonify({
        'success': True,
        'message': f'测试消息已写入 {app_name} 日志'
    })

@app.route('/api/forum/start')
def start_forum_monitoring_api():
    """手动启动ForumEngine论坛"""
    try:
        from ForumEngine.monitor import start_forum_monitoring
        success = start_forum_monitoring()
        if success:
            return jsonify({'success': True, 'message': 'ForumEngine论坛已启动'})
        else:
            return jsonify({'success': False, 'message': 'ForumEngine论坛启动失败'})
    except Exception as e:
        return jsonify({'success': False, 'message': f'启动论坛失败: {str(e)}'})

@app.route('/api/forum/stop')
def stop_forum_monitoring_api():
    """手动停止ForumEngine论坛"""
    try:
        from ForumEngine.monitor import stop_forum_monitoring
        stop_forum_monitoring()
        return jsonify({'success': True, 'message': 'ForumEngine论坛已停止'})
    except Exception as e:
        return jsonify({'success': False, 'message': f'停止论坛失败: {str(e)}'})

@app.route('/api/forum/log')
def get_forum_log():
    """获取ForumEngine的forum.log内容"""
    try:
        forum_log_file = LOG_DIR / "forum.log"
        if not forum_log_file.exists():
            return jsonify({
                'success': True,
                'log_lines': [],
                'parsed_messages': [],
                'total_lines': 0
            })
        
        with open(forum_log_file, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
            lines = [line.rstrip('\n\r') for line in lines if line.strip()]
        
        # 解析每一行日志并提取对话信息
        parsed_messages = []
        for line in lines:
            parsed_message = parse_forum_log_line(line)
            if parsed_message:
                parsed_messages.append(parsed_message)
        
        return jsonify({
            'success': True,
            'log_lines': lines,
            'parsed_messages': parsed_messages,
            'total_lines': len(lines)
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'读取forum.log失败: {str(e)}'})

@app.route('/api/forum/log/history', methods=['POST'])
def get_forum_log_history():
    """获取Forum历史日志（支持从指定位置开始）"""
    try:
        data = request.get_json()
        start_position = data.get('position', 0)  # 客户端上次接收的位置
        max_lines = data.get('max_lines', 1000)   # 最多返回的行数

        forum_log_file = LOG_DIR / "forum.log"
        if not forum_log_file.exists():
            return jsonify({
                'success': True,
                'log_lines': [],
                'position': 0,
                'has_more': False
            })

        with open(forum_log_file, 'r', encoding='utf-8', errors='ignore') as f:
            # 从指定位置开始读取
            f.seek(start_position)
            lines = []
            line_count = 0

            for line in f:
                if line_count >= max_lines:
                    break
                line = line.rstrip('\n\r')
                if line.strip():
                    # 添加时间戳
                    timestamp = datetime.now().strftime('%H:%M:%S')
                    formatted_line = f"[{timestamp}] {line}"
                    lines.append(formatted_line)
                    line_count += 1

            # 记录当前位置
            current_position = f.tell()

            # 检查是否还有更多内容
            f.seek(0, 2)  # 移到文件末尾
            end_position = f.tell()
            has_more = current_position < end_position

        return jsonify({
            'success': True,
            'log_lines': lines,
            'position': current_position,
            'has_more': has_more
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'读取forum历史失败: {str(e)}'})

@app.route('/api/search', methods=['POST'])
def search():
    """纯Python搜索接口 - 直接调用引擎，不依赖Streamlit"""
    print("\n" + "="*50 + "\n[后端断点] 1. /api/search 接口被触发！\n" + "="*50 + "\n", flush=True)
    import uuid as _uuid
    data = request.get_json()
    query = data.get('query', '').strip()
    force_refresh = data.get('force_refresh', False)

    if not query:
        return jsonify({'success': False, 'message': '搜索查询不能为空'})

    task_id = _uuid.uuid4().hex[:8]
    _search_tasks[task_id] = {
        'status': 'running', 'stage': '启动中',
        'query': query, 'result': None, 'error': None,
    }
    logger.info(f"[搜索] 任务创建 task_id={task_id} query={query!r}")

    def _do_search():
        print("[后端断点] 2. 后台搜索线程已成功启动！", flush=True)
        import time as _time
        from runner import run_pipeline
        _t0 = _time.time()
        logger.info(f"[搜索] 任务开始执行 task_id={task_id}")
        try:
            def cb(stage, msg):
                elapsed = _time.time() - _t0
                logger.info(f"[搜索] [{task_id}] [{stage}] {msg} (已用时 {elapsed:.1f}s)")
                _search_tasks[task_id]['stage'] = msg
                socketio.emit('search_progress', {
                    'task_id': task_id, 'stage': stage, 'message': msg,
                })

            result = run_pipeline(query, progress_cb=cb, force_refresh=force_refresh, task_id=task_id)
            elapsed = _time.time() - _t0
            report_path = result.get('report_filepath') or result.get('report_relative_path', '') if isinstance(result, dict) else ''
            warnings = result.get('warnings', []) if isinstance(result, dict) else []
            report_task_id = result.get('report_task_id', '') if isinstance(result, dict) else ''
            logger.info(f"[搜索] 任务完成 task_id={task_id} report_task_id={report_task_id!r} 耗时={elapsed:.1f}s report={report_path!r} warnings={warnings}")
            _search_tasks[task_id].update({'status': 'done', 'result': result, 'warnings': warnings})
            from_cache = result.get('from_cache', False) if isinstance(result, dict) else False
            socketio.emit('search_done', {
                'task_id': task_id,
                'report_task_id': report_task_id,
                'warnings': warnings,
                'from_cache': from_cache,
            })
        except Exception as e:
            elapsed = _time.time() - _t0
            logger.exception(f"[搜索] 任务失败 task_id={task_id} 耗时={elapsed:.1f}s error={e}")
            _search_tasks[task_id].update({'status': 'error', 'error': str(e)})
            socketio.emit('search_error', {'task_id': task_id, 'error': str(e)})

    threading.Thread(target=_do_search, daemon=True).start()
    return jsonify({'success': True, 'task_id': task_id, 'query': query}), 202


@app.route('/api/search/status/<task_id>')
def search_status(task_id):
    """查询搜索任务状态"""
    task = _search_tasks.get(task_id)
    if not task:
        return jsonify({'success': False, 'message': '任务不存在'}), 404
    # 展开 task 时先剔除 result 字段，避免把 html_content（2MB+）带入响应导致超时
    task_meta = {k: v for k, v in task.items() if k != 'result'}
    resp = {'success': True, 'task_id': task_id, **task_meta}
    # result 可能很大，状态查询时只返回元信息
    if task.get('result') and isinstance(task['result'], dict):
        resp['result'] = {
            'report_filepath': task['result'].get('report_filepath', ''),
            'report_relative_path': task['result'].get('report_relative_path', ''),
            'report_filename': task['result'].get('report_filename', ''),
            'from_cache': task['result'].get('from_cache', False),
        }
        # 透传 report_task_id，供前端直接用 Report Engine 接口取报告
        resp['report_task_id'] = task['result'].get('report_task_id', '')
    return jsonify(resp)


def _fix_mathjax_config(html: str) -> str:
    import re as _re
    if 'processEscapes' not in html:
        return html
    html = _re.sub(r',?\s*processEscapes\s*:\s*true', '', html)
    html = _re.sub(r'\{\s*,', '{', html)
    html = _re.sub(r',\s*\}', '}', html)
    html = _re.sub(r',\s*,', ',', html)
    return html


@app.route('/api/report/result/<task_id>', methods=['GET'])
def get_report_result(task_id):
    """战役 3/4：获取报告详情（带自动寻路功能的加强版）"""
    import os
    import markdown
    from pathlib import Path

    logger.info(f"[报告获取] ================== 收到请求 ==================")
    logger.info(f"[报告获取] 收到请求 ID: {task_id}")
    logger.info(f"[报告获取] 请求来源: {request.remote_addr} | User-Agent: {request.headers.get('User-Agent', 'unknown')}")

    base_dir = Path(__file__).resolve().parent.parent
    cwd = Path.cwd()
    possible_dirs = [
        ("base_dir/reports", base_dir / "reports"),
        ("cwd/reports", cwd / "reports"),
        ("cwd.parent/reports", cwd.parent / "reports"),
    ]
    logger.info(f"[报告获取] __file__ = {Path(__file__).resolve()}")
    logger.info(f"[报告获取] base_dir(__file__.parent.parent) = {base_dir}")
    logger.info(f"[报告获取] cwd() = {cwd}")
    logger.info(f"[报告获取] cwd.parent = {cwd.parent}")

    # 1. 尝试从内存获取
    task = _search_tasks.get(task_id)
    logger.info(f"[报告获取] 内存查找: task_id={task_id!r}, 命中={task is not None}")
    if task:
        logger.info(f"[报告获取] 内存任务状态: {task.get('status')!r}, keys={list(task.keys())}")
    if task and task.get('status') in ['completed', 'done']:
        logger.info(f"[报告获取] ✅ 内存命中，状态=completed/done")
        if 'report_html' in task:
            logger.info(f"[报告获取] ✅ 直接返回内存HTML，长度={len(task['report_html'])}")
            return task['report_html'], 200
        if 'report_file' in task:
            p = Path(task['report_file'])
            logger.info(f"[报告获取] 内存中有report_file字段: {p}")
            logger.info(f"[报告获取] report_file存在={p.exists()}, is_file={p.is_file() if p.exists() else 'N/A'}")
            if p.exists():
                try:
                    content = p.read_text(encoding='utf-8')
                    logger.info(f"[报告获取] ✅ 从内存report_file读取成功，长度={len(content)}")
                    return markdown.markdown(content, extensions=['tables', 'fenced_code']), 200
                except Exception as e:
                    logger.error(f"[报告获取] ❌ 读取内存report_file失败: {e}")
    else:
        logger.warning(f"[报告获取] ⚠️ 内存未命中或状态不匹配，task={task}")

    # 2. 自动寻路：遍历所有可能的路径进行搜索
    for label, reports_dir in possible_dirs:
        logger.info(f"[报告获取] ---- 检查路径 [{label}]: {reports_dir} ----")
        logger.info(f"[报告获取]   exists={reports_dir.exists()}, is_dir={reports_dir.is_dir() if reports_dir.exists() else 'N/A'}")

        if not (reports_dir.exists() and reports_dir.is_dir()):
            logger.warning(f"[报告获取]   跳过: 路径不存在或不是目录")
            continue

        try:
            all_md_files = list(reports_dir.rglob('*.md'))
            logger.info(f"[报告获取]   找到 {len(all_md_files)} 个 .md 文件")
            for i, f in enumerate(all_md_files):
                logger.info(f"[报告获取]   [{i+1}] {f.name}")
        except Exception as e:
            logger.error(f"[报告获取]   遍历目录失败: {e}")
            continue

        matched = False
        for file_path in reports_dir.rglob('*.md'):
            if task_id in file_path.name:
                logger.info(f"[报告获取] ✅ 命中文件: {file_path}")
                logger.info(f"[报告获取]   文件大小: {file_path.stat().st_size} bytes")
                try:
                    md_content = file_path.read_text(encoding='utf-8')
                    logger.info(f"[报告获取]   读取成功，MD长度={len(md_content)}")
                    html_content = markdown.markdown(md_content, extensions=['tables', 'fenced_code'])
                    logger.info(f"[报告获取]   转换后HTML长度={len(html_content)}")
                    logger.info(f"[报告获取] ================== 返回成功 ==================")
                    return html_content, 200
                except Exception as e:
                    logger.error(f"[报告获取] ❌ 读取/转换文件失败: {e}")
                matched = True
                break
            else:
                logger.info(f"[报告获取]   文件名不匹配: {file_path.name} (检查: {task_id!r} in {file_path.name!r} = {task_id in file_path.name})")

        if not matched:
            logger.warning(f"[报告获取]   在此目录下未找到匹配文件")

    logger.error(f"[报告获取] ❌ 在所有路径下均未找到包含 [{task_id}] 的文件")
    logger.info(f"[报告获取] ================== 返回 404 ==================")
    return '<div style="text-align:center;padding:50px;"><h2>404 报告未找到</h2><p>请检查 reports 文件夹位置</p></div>', 404


@app.route('/api/report/history', methods=['GET'])
def get_report_history():
    """战役 4：扫描报告目录获取列表（同名去重，保留最新）"""
    import os
    from datetime import datetime

    reports_dir = _PROJECT_ROOT / 'reports'
    if not reports_dir.exists():
        return jsonify({'success': True, 'history': []})

    raw_reports = []
    try:
        for fname in os.listdir(reports_dir):
            if fname.startswith('deep_search_report_') and fname.endswith('.md'):
                parts = fname.replace('deep_search_report_', '').replace('.md', '').rsplit('_', 2)
                if len(parts) >= 3:
                    title = parts[0]
                    date_str = parts[1]
                    time_str = parts[2]
                    report_id = f"{date_str}_{time_str}"
                    try:
                        dt = datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
                        timestamp = dt.timestamp()
                        time_display = dt.strftime('%Y/%m/%d %H:%M')
                    except Exception:
                        timestamp = 0
                        time_display = f"{date_str} {time_str}"
                    raw_reports.append({
                        'id': report_id,
                        'title': title,
                        'time': time_display,
                        'timestamp': timestamp,
                        'filename': fname
                    })
    except Exception as e:
        logger.error(f"[历史记录] 扫描目录失败: {e}")

    deduped_dict = {}
    for r in raw_reports:
        title = r['title']
        if title not in deduped_dict or r['timestamp'] > deduped_dict[title]['timestamp']:
            deduped_dict[title] = r

    final_history = list(deduped_dict.values())
    final_history.sort(key=lambda x: x['timestamp'], reverse=True)
    for r in final_history:
        r.pop('timestamp', None)

    return jsonify({'success': True, 'history': final_history})


@app.route('/api/config', methods=['GET'])
def get_config():
    """Expose selected configuration values to the frontend."""
    try:
        config_values = read_config_values()
        return jsonify({'success': True, 'config': config_values})
    except Exception as exc:
        logger.exception("读取配置失败")
        return jsonify({'success': False, 'message': f'读取配置失败: {exc}'}), 500


@app.route('/api/config', methods=['POST'])
def update_config():
    """Update configuration values and persist them to config.py."""
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict) or not payload:
        return jsonify({'success': False, 'message': '请求体不能为空'}), 400

    updates = {}
    for key, value in payload.items():
        if key in CONFIG_KEYS:
            updates[key] = value if value is not None else ''

    if not updates:
        return jsonify({'success': False, 'message': '没有可更新的配置项'}), 400

    try:
        write_config_values(updates)
        updated_config = read_config_values()
        return jsonify({'success': True, 'config': updated_config})
    except Exception as exc:
        logger.exception("更新配置失败")
        return jsonify({'success': False, 'message': f'更新配置失败: {exc}'}), 500


@app.route('/api/system/status')
def get_system_status():
    """返回系统启动状态。"""
    state = _get_system_state()
    return jsonify({
        'success': True,
        'started': state['started'],
        'starting': state['starting']
    })


@app.route('/api/system/start', methods=['POST'])
def start_system():
    """在接收到请求后启动完整系统（异步，立即返回）。"""
    allowed, message = _prepare_system_start()
    if not allowed:
        return jsonify({'success': False, 'message': message}), 400

    def _do_start():
        logger.info("[系统启动] 后台启动线程开始执行")
        try:
            success, logs, errors = initialize_system_components()
            if success:
                _set_system_state(started=True)
                logger.info(f"[系统启动] 全部组件启动成功, 准备发送 system_start_result(success=True)")
                socketio.emit('system_start_result', {'success': True, 'message': '系统启动成功', 'logs': logs})
                logger.info("[系统启动] system_start_result(success=True) 已发送")
            else:
                _set_system_state(started=False)
                logger.error(f"[系统启动] 启动失败, errors={errors}, 准备发送 system_start_result(success=False)")
                socketio.emit('system_start_result', {'success': False, 'message': '系统启动失败', 'logs': logs, 'errors': errors})
                logger.info("[系统启动] system_start_result(success=False) 已发送")
        except Exception as exc:
            logger.exception(f"[系统启动] 启动过程中出现未捕获异常: {exc}")
            _set_system_state(started=False)
            socketio.emit('system_start_result', {'success': False, 'message': f'系统启动异常: {exc}'})
        finally:
            _set_system_state(starting=False)
            logger.info("[系统启动] 后台启动线程结束")

    t = threading.Thread(target=_do_start, daemon=True)
    t.start()
    return jsonify({'success': True, 'message': '系统正在启动，请稍候...'}), 202

@app.route('/api/system/shutdown', methods=['POST'])
def shutdown_system():
    """优雅停止所有组件并关闭当前服务进程。"""
    state = _get_system_state()
    if state['starting']:
        return jsonify({'success': False, 'message': '系统正在启动/重启，请稍候'}), 400

    if not _mark_shutdown_requested():
        running = _describe_running_children()
        detail = '关机指令已下发，请稍等...'
        if running:
            detail = f"关机指令已下发，等待进程退出: {', '.join(running)}"
        if target_ports:
            detail = f"{detail}（端口: {', '.join(target_ports)}）"
        return jsonify({'success': True, 'message': detail, 'ports': target_ports})

    running = _describe_running_children()
    if running:
        _log_shutdown_step("开始关闭系统，正在等待子进程退出: " + ", ".join(running))
    else:
        _log_shutdown_step("开始关闭系统，未检测到存活子进程")

    try:
        _set_system_state(started=False, starting=False)
        _start_async_shutdown(cleanup_timeout=6.0)
        message = '关闭系统指令已下发，正在停止进程'
        if running:
            message = f"{message}: {', '.join(running)}"
        if target_ports:
            message = f"{message}（端口: {', '.join(target_ports)}）"
        return jsonify({'success': True, 'message': message, 'ports': target_ports})
    except Exception as exc:  # pragma: no cover - 兜底捕获
        logger.exception("系统关闭过程中出现异常")
        return jsonify({'success': False, 'message': f'系统关闭异常: {exc}'}), 500

@socketio.on('connect')
def handle_connect():
    """客户端连接"""
    emit('status', 'Connected to Flask server')

@socketio.on('request_status')
def handle_status_request():
    """请求状态更新"""
    check_app_status()
    emit('status_update', {
        app_name: {'status': info['status']}
        for app_name, info in processes.items()
    })

if __name__ == '__main__':
    # 从配置文件读取 HOST 和 PORT
    from config import settings
    HOST = settings.HOST
    PORT = settings.PORT
    
    logger.info("等待配置确认，系统将在前端指令后启动组件...")
    logger.info(f"Flask服务器已启动，访问地址: http://{HOST}:{PORT}")
    
    try:
        socketio.run(app, host=HOST, port=PORT, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        logger.info("\n正在关闭应用...")
        cleanup_processes()
        
    
