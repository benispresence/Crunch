"""
Configuration management for NiceMeta.

Loads settings from TOML configuration files and environment variables.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

import tomli
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseModel):
    """Application settings."""

    title: str = "NiceMeta"
    host: str = "0.0.0.0"
    port: int = 3690
    debug: bool = False
    secret_key: str = "change-this-to-a-random-secret-key-in-production"


class DatabaseSettings(BaseModel):
    """Internal database settings."""

    driver: Literal["postgresql", "sqlite"] = "sqlite"
    host: str = "localhost"
    port: int = 5432
    name: str = "crunch.db"
    user: str = "nicemeta"
    password: str = "nicemeta"

    @property
    def url(self) -> str:
        """Generate database URL."""
        if self.driver == "sqlite":
            return f"sqlite+aiosqlite:///{self.name}"
        elif self.driver == "postgresql":
            return f"postgresql+asyncpg://{self.user}:{self.password}@{self.host}:{self.port}/{self.name}"
        else:
            raise ValueError(f"Unsupported database driver: {self.driver}")

    @property
    def sync_url(self) -> str:
        """Generate synchronous database URL (for migrations)."""
        if self.driver == "sqlite":
            return f"sqlite:///{self.name}"
        elif self.driver == "postgresql":
            return f"postgresql://{self.user}:{self.password}@{self.host}:{self.port}/{self.name}"
        else:
            raise ValueError(f"Unsupported database driver: {self.driver}")


class AuthSettings(BaseModel):
    """Authentication settings."""

    jwt_lifetime_seconds: int = 3600
    allow_registration: bool = True
    require_verification: bool = False


class VisualizationSettings(BaseModel):
    """Visualization settings."""

    default_renderer: Literal["plotly", "matplotlib", "seaborn", "altair", "bokeh"] = "plotly"


class ServerSettings(BaseModel):
    """Server settings."""

    reload: bool = False
    workers: int = 1


class Settings(BaseSettings):
    """
    Main settings class that aggregates all configuration sections.
    
    Settings are loaded from:
    1. Default values
    2. TOML configuration file (config/settings.toml)
    3. Environment variables (prefixed with NICEMETA_)
    """

    model_config = SettingsConfigDict(
        env_prefix="NICEMETA_",
        env_nested_delimiter="__",
        extra="ignore",
    )

    app: AppSettings = Field(default_factory=AppSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)
    visualization: VisualizationSettings = Field(default_factory=VisualizationSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)

    @classmethod
    def from_toml(cls, path: Path | str) -> "Settings":
        """Load settings from a TOML file."""
        path = Path(path)
        if not path.exists():
            return cls()

        with open(path, "rb") as f:
            data = tomli.load(f)

        return cls(**data)


def find_config_file() -> Path | None:
    """
    Find the configuration file in standard locations.
    
    Searches in order:
    1. ./config/settings.toml
    2. ./settings.toml
    3. ~/.config/nicemeta/settings.toml
    """
    search_paths = [
        Path("config/settings.toml"),
        Path("settings.toml"),
        Path.home() / ".config" / "nicemeta" / "settings.toml",
    ]

    for path in search_paths:
        if path.exists():
            return path

    return None


@lru_cache
def get_settings() -> Settings:
    """
    Get application settings (cached).
    
    Loads from TOML config file if found, otherwise uses defaults.
    Environment variables can override any setting.
    """
    config_path = find_config_file()
    
    if config_path:
        return Settings.from_toml(config_path)
    
    return Settings()


def reload_settings() -> Settings:
    """Force reload settings (clears cache)."""
    get_settings.cache_clear()
    return get_settings()

