# papernook: self-contained app image.
# better-sqlite3 is a native module: it is installed and compiled INSIDE this
# image (Linux glibc), never copied from a dev machine.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ARG CLAUDE_CODE_VERSION=2.1.215
ARG CODEX_VERSION=0.144.6
# poppler-utils: pdftotext for capture/FTS. openssh-client: SSH agent mode + scp.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}"
ENV NODE_ENV=production
ENV PAPERNOOK_DATA_DIR=/data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/assets ./assets
COPY --from=build /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh
EXPOSE 3000
VOLUME /data
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "server.js"]
