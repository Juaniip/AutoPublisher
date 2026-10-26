#!/usr/bin/env bash
# Copia el código a la Raspberry Pi y reinicia AutoPublisher.
# No toca la base de datos, los videos, los guiones ni las plantillas editadas desde el panel.
set -e
PI=juaniwilt@192.168.1.37
DIR='~/Desktop/autopublisher'
cd "$(dirname "$0")"

if ! ssh -o BatchMode=yes "$PI" "curl -s http://127.0.0.1:3000/api/state" | grep -q '"active":0'; then
  echo "Hay una subida a YouTube en curso (o AutoPublisher no responde). Probá de nuevo en unos minutos."
  exit 1
fi

tar czf - \
  --exclude=node_modules --exclude=data --exclude=publicar --exclude=publicados --exclude=guiones \
  --exclude=generados --exclude=pruebas-formulario --exclude=sitio-publico --exclude='*.bat' \
  --exclude='agentes/*.md' --exclude=agentes/config.json --exclude=agentes/personaje \
  . | ssh -o BatchMode=yes "$PI" "tar xzf - -C $DIR && cd $DIR && docker compose up -d --build"

echo "Listo: AutoPublisher actualizado en la Pi."
