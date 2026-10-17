# BA Copilot – image chạy bản đã đóng gói sẵn (dist/server.mjs + public/), không cần npm install.
# Trước khi deploy bản code mới: chạy `npm run bundle` để cập nhật dist/ và public/app.js.
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/ba-copilot.db \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY dist ./dist
COPY public ./public
COPY model ./model
COPY package.json ./
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
