import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import proxy
from routes.config import router as config_router
from services import mongo_client
from services.llm_config_store import load_from_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Pi Agent Admin", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(proxy.router)
app.include_router(config_router)


@app.on_event("startup")
async def on_startup() -> None:
    await mongo_client.connect()
    # 从 MongoDB 加载 LLM 配置到内存，之后 proxy 直接读内存，无 DB IO
    await load_from_db()
    logger.info("Admin 服务已就绪")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await mongo_client.disconnect()


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok"}
