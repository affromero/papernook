# papernook: self-contained app image.
# better-sqlite3 is a native module: it is installed and compiled INSIDE this
# image (Linux glibc), never copied from a dev machine.

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/patch-tldraw-font-manager.mjs ./scripts/patch-tldraw-font-manager.mjs
RUN npm ci

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
WORKDIR /app
ARG CLAUDE_CODE_VERSION=2.1.225
ARG CODEX_VERSION=0.144.6
# poppler-utils: pdftotext for capture/FTS. qpdf: linearizes captured PDFs so
# the reader paints page 1 early. openssh-client: SSH agent mode + scp.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils qpdf openssh-client ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}"
ENV NODE_ENV=production
ENV PAPERNOOK_DATA_DIR=/data
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOME=/home/node
COPY --chown=node:node --from=build /app/.next/runtime ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node --from=build /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh \
  && mkdir -p /data /home/node/.codex /home/node/.claude /home/node/.ssh \
  && chown -R node:node /data /home/node /app
EXPOSE 3000
VOLUME /data
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "server.js"]
