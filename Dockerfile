# ---------- 构建阶段 ----------
FROM node:20-alpine AS builder

WORKDIR /app

# 利用缓存：先拷贝依赖清单
COPY package.json package-lock.json* ./
RUN npm install

# 拷贝源码并构建（构建会执行 tsc 类型检查 + vite 打包）
COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine AS runner

ENV NODE_ENV=production
ENV PORT=3210
# 数据持久化目录（挂载卷），默认使用容器内的 /app/data
ENV KB_DB_PATH=/app/data/chat.db

WORKDIR /app

# 仅拷贝运行所需文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./package.json

# 创建数据目录，确保 SQLite 可写
RUN mkdir -p /app/data

EXPOSE 3210

# 启动：容器启动前会自动执行类型检查（build 阶段已完成），这里直接运行服务
CMD ["node", "--import", "tsx", "server/index.ts"]
