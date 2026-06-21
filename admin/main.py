import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from routes import proxy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Pi Agent Admin - LLM Proxy", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(proxy.router)


@app.on_event("startup")
async def on_startup() -> None:
    logger.info(
        "Admin LLM Proxy 启动: upstream=%s model=%s",
        settings.llm_base_url,
        settings.llm_model,
    )


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok"}
