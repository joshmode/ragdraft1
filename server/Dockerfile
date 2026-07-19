FROM node:22-bookworm-slim AS client

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client ./
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server ./
COPY --from=client /app/client/dist /app/client/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "index.js"]
