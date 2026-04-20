"""
Report Engine渲染器集合。

提供 HTMLRenderer 和 PDFRenderer，支持HTML和PDF输出。
PDFRenderer 采用懒加载，避免模块导入时触发 WeasyPrint/GTK 初始化阻塞。
"""

from .html_renderer import HTMLRenderer
from .pdf_layout_optimizer import (
    PDFLayoutOptimizer,
    PDFLayoutConfig,
    PageLayout,
    KPICardLayout,
    CalloutLayout,
    TableLayout,
    ChartLayout,
    GridLayout,
)
from .markdown_renderer import MarkdownRenderer


def _get_pdf_renderer():
    from .pdf_renderer import PDFRenderer
    return PDFRenderer


class _LazyPDFRenderer:
    """PDFRenderer 的懒加载代理，首次实例化时才真正导入 pdf_renderer 模块。"""

    def __new__(cls, *args, **kwargs):
        PDFRenderer = _get_pdf_renderer()
        return PDFRenderer(*args, **kwargs)


PDFRenderer = _LazyPDFRenderer

__all__ = [
    "HTMLRenderer",
    "PDFRenderer",
    "MarkdownRenderer",
    "PDFLayoutOptimizer",
    "PDFLayoutConfig",
    "PageLayout",
    "KPICardLayout",
    "CalloutLayout",
    "TableLayout",
    "ChartLayout",
    "GridLayout",
]
