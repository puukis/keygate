FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS build

WORKDIR /app

# Native modules and Playwright runtime dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    make \
    g++ \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/discord/package.json packages/discord/package.json
COPY packages/slack/package.json packages/slack/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM base AS runtime

WORKDIR /app

ENV NODE_ENV="production"
ENV PORT="18790"
ENV KEYGATE_OPEN_CHAT_ON_START="false"
ENV KEYGATE_CHAT_URL="http://localhost:18790"
ENV WORKSPACE_PATH="/workspace"
ENV KEYGATE_CODEX_BIN="/usr/local/bin/codex"
ENV KEYGATE_AUTO_SETUP_MCP_BROWSER="true"
ENV KEYGATE_AUTO_SETUP_MCP_BROWSER_STRICT="false"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN npm i -g @openai/codex

COPY --from=build /app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /workspace /home/node/.config/keygate /home/node/.codex /home/node/.cache/ms-playwright \
    && chown -R node:node /workspace /home/node/.config /home/node/.codex /home/node/.cache /app

USER node

EXPOSE 18790
VOLUME ["/home/node/.config/keygate", "/home/node/.codex", "/home/node/.cache/ms-playwright", "/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/status" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "/app/packages/cli/dist/main.js", "serve"]
