"""
conftest.py - 测试全局配置
在导入任何引擎模块之前，mock掉重量级依赖（torch/sklearn/sentence_transformers等），
避免因 DLL 加载失败或缺少 GPU 导致测试无法运行。

策略：先卸载已部分加载的真实模块，再用 MagicMock 占位。
"""

import sys
import types
from unittest.mock import MagicMock

# ============================================================
# 需要 mock 的重量级模块树
# ============================================================
_HEAVY_PREFIXES = [
    "torch",
    "sentence_transformers",
    "sklearn",
    "scipy",
    "transformers",
    "weasyprint",
    "xgboost",
]

# 先清除已经部分加载的真实模块（避免 Mock 和真实模块混用）
_to_remove = [k for k in sys.modules
              if any(k == p or k.startswith(p + ".") for p in _HEAVY_PREFIXES)]
for k in _to_remove:
    del sys.modules[k]

# 用一个可被 issubclass / isinstance 安全使用的假模块替代
class _SafeMock(MagicMock):
    """MagicMock 子类，让 issubclass(x, mock_obj) 不会 TypeError"""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # 让 scipy 的 is_torch_array → issubclass(cls, Tensor) 安全返回 False
        self.__class_getitem__ = classmethod(lambda cls, *a: cls)

    # 让 issubclass(anything, this_mock) 返回 False 而不是 TypeError
    @property
    def __mro_entries__(self):
        return lambda bases: []


def _make_module(name):
    """创建一个假 module 对象，属性访问返回 _SafeMock"""
    mod = types.ModuleType(name)
    mod.__path__ = []  # 让 Python 认为它是一个 package
    mod.__file__ = f"<mocked {name}>"
    mod.__loader__ = None
    mod.__spec__ = None

    class _AttrProxy:
        """让 mod.anything 返回 _SafeMock()"""
        def __getattr__(self, item):
            if item.startswith("_"):
                raise AttributeError(item)
            return _SafeMock(name=f"{name}.{item}")

    # 把 proxy 的 __getattr__ 绑到 module 上
    mod.__class__ = type(mod.__name__, (types.ModuleType,), {
        "__getattr__": lambda self, item: _SafeMock(name=f"{name}.{item}")
    })
    return mod


# 注入所有需要 mock 的顶层包及其常见子模块
_EXPLICIT_MODULES = []
for prefix in _HEAVY_PREFIXES:
    _EXPLICIT_MODULES.append(prefix)
    # 常见子模块
    for sub in ["nn", "nn.functional", "utils", "utils.data", "cuda", "optim",
                "cluster", "metrics", "model_selection", "preprocessing",
                "stats", "sparse", "linalg", "special", "optimize",
                "generation", "configuration_utils", "modeling_utils",
                "backend", "backend.load"]:
        _EXPLICIT_MODULES.append(f"{prefix}.{sub}")

for mod_name in _EXPLICIT_MODULES:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = _make_module(mod_name)

# 特殊处理：让 torch.cuda.is_available() 返回 False
_torch = sys.modules["torch"]
_torch.cuda = _SafeMock(name="torch.cuda")
_torch.cuda.is_available = MagicMock(return_value=False)
_torch.device = MagicMock(return_value="cpu")
_torch.no_grad = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
_torch.Tensor = type("Tensor", (), {})  # 真实的类，让 issubclass 安全

# numpy 保留真实的（它通常能正常加载）
# sklearn.cluster.KMeans 需要是可调用的
sys.modules["sklearn.cluster"].KMeans = MagicMock(name="KMeans")

# sentence_transformers.SentenceTransformer 需要是可调用的
sys.modules["sentence_transformers"].SentenceTransformer = MagicMock(name="SentenceTransformer")
