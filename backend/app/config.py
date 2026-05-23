from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://verkada:verkada@postgres:5432/vfusion"
    redis_url: str = "redis://redis:6379/0"
    secret_key: str = "dev-secret-change-me"
    fernet_key: str = ""
    cors_origins: str = "http://localhost:5173"
    # Set by named-tunnel deploys (Cloudflare Tunnel with a custom domain).
    # The Webhook Inbox banner displays this URL so users know what to paste
    # into Verkada Command. Quick-mode deploys auto-discover instead.
    public_webhook_base: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
