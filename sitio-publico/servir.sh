#!/usr/bin/env bash
# Sirve el sitio en http://localhost:8080 (solo local). Apuntá el túnel de Cloudflare a esa dirección.
cd "$(dirname "$0")"
exec python3 -m http.server 8080 --bind 127.0.0.1
