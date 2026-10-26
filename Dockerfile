FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
