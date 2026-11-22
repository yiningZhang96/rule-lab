FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY . .
EXPOSE 3000
# 端口由平台注入（PORT 环境变量），未设置时服务默认监听 3000；必须绑定 0.0.0.0
CMD ["node", "server.js"]
