FROM node:22-alpine

WORKDIR /app

# 1. 复制依赖清单
COPY package*.json ./

# 2. 安装全量依赖（包含 Vite 和 TypeScript），以支持容器内网页在线更新编译
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# 3. 复制宿主机预编译的静态资源与服务器代码
COPY dist ./dist
COPY worker ./worker
COPY adapter ./adapter
COPY entry.node.ts tsconfig.json VERSION ./

# 4. 全局安装 tsx 用于直接运行 typescript，同样利用缓存
RUN --mount=type=cache,target=/root/.npm \
    npm install -g tsx

EXPOSE 3000

CMD ["tsx", "entry.node.ts"]
