import logging
import logging.handlers
import os
from pathlib import Path

_LOG_DIR = Path(os.getenv("LOG_DIR", "/app/logs"))
_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
_LOG_RETENTION_DAYS = 7
_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def setup_logging(service_name: str) -> None:
    """初始化全局日志配置：每天分割，保留7天，同时输出到文件和控制台。"""
    _LOG_DIR.mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(_LOG_FORMAT)

    file_handler = logging.handlers.TimedRotatingFileHandler(
        filename=_LOG_DIR / f"{service_name}.log",
        when="midnight",
        interval=1,
        backupCount=_LOG_RETENTION_DAYS,
        encoding="utf-8",
    )
    file_handler.suffix = "%Y-%m-%d"
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(_LOG_LEVEL)
    root.addHandler(file_handler)
    root.addHandler(console_handler)
