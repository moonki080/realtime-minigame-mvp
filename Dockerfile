FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY shared ./shared

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4310

EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4310) + '/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
