FROM node:24-alpine AS builder

WORKDIR /network

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine

WORKDIR /network

COPY --from=builder /network/irc-network.js ./irc-network.js

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /network

USER nodejs

EXPOSE 8667

CMD ["node", "irc-network.js"]
