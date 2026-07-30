FROM oven/bun:1.3.13-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV PORT=8787
EXPOSE 8787

CMD ["bun", "src/index.ts"]
