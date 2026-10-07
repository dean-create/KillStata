"""KillStata 的独立 Python 计量引擎。"""

from .registry import REGISTRY_VERSION, get_method, method_catalog, search_methods

PROTOCOL_VERSION = 1

__all__ = ["PROTOCOL_VERSION", "REGISTRY_VERSION", "get_method", "method_catalog", "search_methods"]
