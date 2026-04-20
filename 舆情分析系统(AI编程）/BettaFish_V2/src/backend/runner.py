"""
runner.py - 搜索与报告生成流水线
串联 InsightEngine、MediaEngine、QueryEngine、ReportEngine，
对外暴露 run_pipeline 供 app.py 调用。
"""

import concurrent.futures
from loguru import logger


def run_insight(query: str, progress_cb=None) -> dict:
    from InsightEngine.agent import DeepSearchAgent
    from InsightEngine.utils.config import Settings

    if progress_cb:
        progress_cb("insight", "InsightEngine 启动中...")

    config = Settings()
    agent = DeepSearchAgent(config)
    agent._generate_report_structure(query)

    for i, _ in enumerate(agent.state.paragraphs):
        agent._initial_search_and_summary(i)
        agent._reflection_loop(i)
        if progress_cb:
            progress_cb("insight", f"InsightEngine 段落 {i+1}/{len(agent.state.paragraphs)} 完成")

    report = agent._generate_final_report()
    agent._save_report(report)

    if progress_cb:
        progress_cb("insight", "InsightEngine 完成")

    return {"engine": "insight", "status": "done", "report": report}


def run_media(query: str, progress_cb=None) -> dict:
    from MediaEngine.utils.config import Settings

    if progress_cb:
        progress_cb("media", "MediaEngine 启动中...")

    config = Settings()
    if getattr(config, "SEARCH_TOOL_TYPE", "AnspireAPI") == "AnspireAPI":
        from MediaEngine.agent import AnspireSearchAgent
        agent = AnspireSearchAgent(config)
    else:
        from MediaEngine.agent import DeepSearchAgent
        agent = DeepSearchAgent(config)

    agent._generate_report_structure(query)

    for i, _ in enumerate(agent.state.paragraphs):
        agent._initial_search_and_summary(i)
        agent._reflection_loop(i)
        if progress_cb:
            progress_cb("media", f"MediaEngine 段落 {i+1}/{len(agent.state.paragraphs)} 完成")

    report = agent._generate_final_report()
    agent._save_report(report)

    if progress_cb:
        progress_cb("media", "MediaEngine 完成")

    return {"engine": "media", "status": "done", "report": report}


def run_query(query: str, progress_cb=None) -> dict:
    from QueryEngine.agent import DeepSearchAgent
    from QueryEngine.utils.config import Settings

    if progress_cb:
        progress_cb("query", "QueryEngine 启动中...")

    config = Settings()
    agent = DeepSearchAgent(config)
    agent._generate_report_structure(query)

    for i, _ in enumerate(agent.state.paragraphs):
        agent._initial_search_and_summary(i)
        agent._reflection_loop(i)
        if progress_cb:
            progress_cb("query", f"QueryEngine 段落 {i+1}/{len(agent.state.paragraphs)} 完成")

    report = agent._generate_final_report()
    agent._save_report(report)

    if progress_cb:
        progress_cb("query", "QueryEngine 完成")

    return {"engine": "query", "status": "done", "report": report}


def run_all_engines(query: str, progress_cb=None) -> list:
    """并发运行三个采集引擎，任一失败不影响其他，返回成功的报告列表。"""
    results = []

    def _run(fn, name):
        try:
            return fn(query, progress_cb)
        except Exception as exc:
            logger.error(f"[runner] {name} 执行异常: {exc}", exc_info=True)
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {
            pool.submit(_run, run_insight, "InsightEngine"): "insight",
            pool.submit(_run, run_media,   "MediaEngine"):   "media",
            pool.submit(_run, run_query,   "QueryEngine"):   "query",
        }
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result and result.get("status") == "done":
                results.append(result["report"])

    return results


def run_report(query: str, reports: list, progress_cb=None, forum_logs: str = "", custom_template: str = "") -> dict:
    from ReportEngine.agent import create_agent

    if progress_cb:
        progress_cb("report", "ReportEngine 启动中...")

    agent = create_agent()
    result = agent.generate_report(
        query=query,
        reports=reports,
        forum_logs=forum_logs,
        custom_template=custom_template,
        save_report=True,
    )

    if progress_cb:
        progress_cb("report", "ReportEngine 完成")

    return result


def run_pipeline(query: str, progress_cb=None, force_refresh: bool = False, task_id: str = "") -> dict:
    """
    完整搜索流水线：三引擎并发采集 → ReportEngine 生成报告。
    返回与 ReportEngine.generate_report 相同结构的 dict。
    """
    # 缓存检查
    if not force_refresh:
        try:
            from utils.report_cache import ReportCache
            cache = ReportCache()
            cached = cache.get(query)
            if cached:
                logger.info(f"[runner] 命中缓存 query={query!r}")
                cached["from_cache"] = True
                return cached
        except Exception as exc:
            logger.warning(f"[runner] 缓存读取失败，跳过: {exc}")

    if progress_cb:
        progress_cb("pipeline", "启动三引擎并发采集...")

    reports = run_all_engines(query, progress_cb)

    if not reports:
        raise RuntimeError("所有采集引擎均失败，无法生成报告")

    if progress_cb:
        progress_cb("pipeline", f"采集完成，共 {len(reports)} 份报告，启动 ReportEngine...")

    result = run_report(query, reports, progress_cb=progress_cb)

    # 写缓存
    try:
        from utils.report_cache import ReportCache
        cache = ReportCache()
        cache.put(query, result)
    except Exception as exc:
        logger.warning(f"[runner] 缓存写入失败，跳过: {exc}")

    result["from_cache"] = False
    if task_id:
        result["report_task_id"] = task_id

    return result
