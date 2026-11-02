#!/bin/bash
# Khởi động Local AI Chat (tự bật Ollama nếu chưa chạy)
cd "/home/tranvanhuy0642/Projects/My projects/local-ai"
curl -s -m 1 http://127.0.0.1:11434/api/tags >/dev/null || (nohup ollama serve >/dev/null 2>&1 &)
exec env -u ELECTRON_RUN_AS_NODE "/home/tranvanhuy0642/Projects/My projects/local-ai/node_modules/electron/dist/electron" "/home/tranvanhuy0642/Projects/My projects/local-ai" --no-sandbox "$@"
