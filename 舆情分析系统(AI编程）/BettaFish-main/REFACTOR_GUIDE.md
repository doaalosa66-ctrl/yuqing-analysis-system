# BettaFish V2 目录重构指南

## 一、重构脚本说明

已为您生成 `refactor_structure.py`，该脚本将自动完成以下工作：

### 1. 目录结构重组

```
BettaFish_V2/
├── src/                          # 核心源码
│   ├── frontend/                 # 前端代码
│   ├── backend/                  # 后端主逻辑
│   │   ├── app.py               # Flask 主应用
│   │   ├── config.py            # 全局配置
│   │   ├── runner.py            # 搜索流程编排
│   │   ├── utils/               # 工具类
│   │   └── SingleEngineApp/     # 单引擎应用
│   ├── engines/                  # 核心引擎组
│   │   ├── InsightEngine/
│   │   ├── MediaEngine/
│   │   ├── QueryEngine/
│   │   ├── ReportEngine/
│   │   └── ForumEngine/
│   ├── spider/                   # 爬虫服务
│   │   └── MindSpider/
│   └── tests/                    # 测试代码
│
├── docs/                         # 文档与大脑
│   ├── prd/                      # 产品需求文档
│   ├── architecture/             # 架构设计
│   ├── api/                      # API 接口文档
│   └── prompts/                  # 核心提示词资产
│
├── data/                         # 原始数据
│   ├── db/                       # 数据库物理文件（原 db_data）
│   └── cache/                    # 运行时缓存（原 data）
│
├── outputs/                      # 历史生成物
│   ├── raw_md/                   # 原始 Markdown（原 reports）
│   └── final_exports/            # 最终导出成品（原 final_reports）
│
├── ops/                          # 系统运维与日志
│   ├── logs/                     # 运行日志
│   ├── scripts/                  # 快捷脚本
│   └── config/                   # 配置文件（.env）
│
├── .gitignore
├── requirements.txt
├── docker-compose.yml
├── Dockerfile
└── README.md
```

### 2. 自动路径更新

脚本会自动修改以下关键文件中的路径引用：

#### `src/backend/app.py`
- `_PROJECT_ROOT` 调整为三级父目录
- `_FRONTEND_DIR` 指向 `src/frontend`
- `LOG_DIR` 指向 `ops/logs`
- `reports_dir` 指向 `outputs/raw_md`
- 添加 `src/engines` 和 `src/backend` 到 `sys.path`

#### `src/engines/ReportEngine/utils/config.py`
- `OUTPUT_DIR`: `final_reports` → `outputs/final_exports`
- `CHAPTER_OUTPUT_DIR`: `final_reports/chapters` → `outputs/final_exports/chapters`
- `DOCUMENT_IR_OUTPUT_DIR`: `final_reports/ir` → `outputs/final_exports/ir`
- `TEMPLATE_DIR`: `ReportEngine/report_template` → `src/engines/ReportEngine/report_template`
- `LOG_FILE`: `logs/report.log` → `ops/logs/report.log`
- `JSON_ERROR_LOG_DIR`: `logs/json_repair_failures` → `ops/logs/json_repair_failures`

#### `src/engines/ReportEngine/flask_interface.py`
- `possible_dirs` 中的 `reports` 路径 → `outputs/raw_md`

#### `docker-compose.yml`
- 卷映射路径全部更新为新架构路径

### 3. .gitignore 更新

自动追加以下规则，屏蔽大体积目录：
```
data/
outputs/
ops/logs/
ops/config/.env
__pycache__/
*.pyc
```

---

## 二、使用步骤

### 1. 预览模式（推荐先执行）

```bash
cd "c:/Users/59849/Desktop/舆情分析系统(AI编程） (1)/舆情分析系统(AI编程）/BettaFish-main"
python refactor_structure.py --dry-run
```

这会打印所有将要执行的操作，但不实际修改任何文件。

### 2. 正式执行

确认预览无误后，去掉 `--dry-run` 参数：

```bash
python refactor_structure.py
```

脚本会：
- 在 `BettaFish-main` 同级创建 `BettaFish_V2` 目录
- 复制所有文件到新目录（保留原目录不变）
- 自动修改所有路径引用

### 3. 验证启动

```bash
cd ../BettaFish_V2
python src/backend/app.py
```

检查是否能正常启动，访问 `http://localhost:8080`

---

## 三、需要手动处理的文件

脚本已覆盖核心路径，但以下文件可能需要手动检查：

### 1. 各引擎的 `utils/config.py`

如果 `InsightEngine/utils/config.py`、`MediaEngine/utils/config.py`、`QueryEngine/utils/config.py` 中有硬编码路径，需手动更新。

**检查方法：**
```bash
cd BettaFish_V2
grep -r "logs/" src/engines/*/utils/config.py
grep -r "reports" src/engines/*/utils/config.py
grep -r "final_reports" src/engines/*/utils/config.py
```

### 2. `runner.py`（如果存在）

检查是否有硬编码的输出路径：
```bash
grep -n "reports\|logs\|final_reports" src/backend/runner.py
```

### 3. `MindSpider` 配置

检查爬虫模块是否有数据库路径或日志路径硬编码：
```bash
grep -rn "db_data\|logs/" src/spider/MindSpider/
```

### 4. 测试文件

测试代码中可能有硬编码路径：
```bash
grep -rn "logs/\|reports/\|final_reports/" src/tests/
```

---

## 四、Docker 相关调整

### 1. Dockerfile

如果 Dockerfile 中有 `WORKDIR` 或 `COPY` 指令，需要更新：

```dockerfile
# 旧版
WORKDIR /app
COPY backend /app/backend
COPY frontend /app/frontend

# 新版
WORKDIR /app
COPY src /app/src
COPY ops /app/ops
COPY data /app/data
COPY outputs /app/outputs
```

### 2. docker-compose.yml

脚本已自动更新卷映射，但如果有 `build.context` 或 `command` 需手动检查：

```yaml
services:
  bettafish:
    build:
      context: .
      dockerfile: Dockerfile
    command: python src/backend/app.py  # 更新启动命令
```

---

## 五、迁移后的启动流程

### 1. 本地启动

```bash
cd BettaFish_V2

# 1. 启动数据库（Docker）
docker-compose up -d db

# 2. 启动后端
python src/backend/app.py

# 3. 访问前端
# http://localhost:8080
```

### 2. Docker 完整启动

```bash
cd BettaFish_V2
docker-compose up -d
```

---

## 六、路径修改清单（供手动核对）

| 原路径 | 新路径 | 影响文件 |
|--------|--------|----------|
| `frontend/` | `src/frontend/` | `app.py` |
| `backend/` | `src/backend/` | - |
| `*Engine/` | `src/engines/*Engine/` | `sys.path` |
| `MindSpider/` | `src/spider/MindSpider/` | - |
| `utils/` | `src/backend/utils/` | - |
| `logs/` | `ops/logs/` | `app.py`, `ReportEngine/utils/config.py` |
| `reports/` | `outputs/raw_md/` | `app.py`, `flask_interface.py` |
| `final_reports/` | `outputs/final_exports/` | `ReportEngine/utils/config.py`, `docker-compose.yml` |
| `db_data/` | `data/db/` | `docker-compose.yml` |
| `data/` | `data/cache/` | - |
| `.env` | `ops/config/.env` | `docker-compose.yml` |

---

## 七、常见问题

### Q1: 执行后原项目还能用吗？
**A:** 能。脚本使用 `copytree` 和 `copy2`，不会删除原目录，`BettaFish-main` 保持不变。

### Q2: 如果路径替换失败怎么办？
**A:** 脚本会打印 `[WARN]` 提示未找到的替换目标。手动打开对应文件，搜索旧路径并替换。

### Q3: 如何回滚？
**A:** 删除 `BettaFish_V2` 目录即可，原项目未受影响。

### Q4: 数据库数据会丢失吗？
**A:** 不会。`db_data/` 会被复制到 `data/db/`，原数据保留。

### Q5: 需要重新安装依赖吗？
**A:** 不需要。`requirements.txt` 已复制，虚拟环境可继续使用。

---

## 八、后续优化建议

### 1. 填充 `docs/` 目录

将以下文档移入对应目录：
- `PRD产品需求文档.md` → `docs/prd/`
- `系统架构与API接口梳理.md` → `docs/architecture/`
- 核心 Prompt 模板 → `docs/prompts/`

### 2. 编写快捷脚本

在 `ops/scripts/` 中添加：
- `start.sh` / `start.bat` - 一键启动
- `stop.sh` / `stop.bat` - 一键停止
- `clean_logs.sh` - 清理日志

### 3. 更新 README.md

在新项目根目录的 README 中说明新架构，包括：
- 目录结构说明
- 启动流程
- 配置文件位置

---

## 九、验证清单

重构完成后，逐项检查：

- [ ] 后端能正常启动（`python src/backend/app.py`）
- [ ] 前端页面能访问（`http://localhost:8080`）
- [ ] 数据库连接正常（检查 `ops/logs/` 中的日志）
- [ ] 搜索功能正常（触发一次搜索，检查 `outputs/raw_md/` 是否生成报告）
- [ ] 报告生成正常（检查 `outputs/final_exports/` 是否有输出）
- [ ] Docker 启动正常（`docker-compose up -d`）
- [ ] 日志正常写入（检查 `ops/logs/` 目录）

---

**执行前请务必备份重要数据！**
