#!/usr/bin/env python3
"""
Prepares v1 Python config for black-box benchmark.
Generates Fernet key, proxy_config.enc, and env vars.
"""
import json
import os
import sys
from cryptography.fernet import Fernet

def setup_v1(config_dir: str, upstream_url: str = "http://127.0.0.1:19002/v1"):
    os.makedirs(config_dir, exist_ok=True)
    fernet_key = Fernet.generate_key().decode()

    cfg = {
        "upstream_timeout": 30,
        "schedule_total_budget": 30,
        "max_concurrency_per_key": 20,
        "cooldown_429_sec": 60,
        "providers": {
            "chaos_prov": {
                "base_url": upstream_url,
                "keys": {
                    "k1": "sk-key-1",
                    "k2": "sk-key-2"
                }
            }
        },
        "agent_models": {
            "bench-model": {
                "keys": [
                    {"provider": "chaos_prov", "key": "k1"},
                    {"provider": "chaos_prov", "key": "k2"}
                ]
            }
        },
        "candidates": {
            "chat": [{"provider": "chaos_prov", "key": "k1", "model": "bench-model"}],
            "ocr": [{"provider": "chaos_prov", "key": "k1", "model": "bench-ocr"}]
        }
    }

    fernet = Fernet(fernet_key.encode())
    enc_data = fernet.encrypt(json.dumps(cfg).encode("utf-8"))
    with open(os.path.join(config_dir, "proxy_config.enc"), "wb") as f:
        f.write(enc_data)

    env_content = f"""ENCRYPT_KEY={fernet_key}
CONFIG_DIR={config_dir}
CLIENT_KEY=test-proxy-client-key-8888
PROXY_API_KEY=test-proxy-client-key-8888
ADMIN_PASSWORD=bench-admin-secret
RUN_MODE=agent
APP_PORT=8787
APP_HOST=0.0.0.0
UVICORN_LIMIT_CONCURRENCY=512
"""
    with open(os.path.join(config_dir, "v1.env"), "w") as f:
        f.write(env_content)

    print(f"Config prepared in {config_dir} with ENCRYPT_KEY={fernet_key}")
    return fernet_key

if __name__ == "__main__":
    target_dir = sys.argv[1] if len(sys.argv) > 1 else "/data/home/bench/v1-config"
    setup_v1(target_dir)
