# fisco-backend
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY sql ./sql
COPY data ./data
EXPOSE 3000
# start-period generoso: o boot pode gastar os 20s do lock_timeout
# esperando uma carga em andamento antes de desistir e subir.
HEALTHCHECK --interval=30s --timeout=5s --start-period=50s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]
