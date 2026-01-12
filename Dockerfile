FROM node:24-alpine

WORKDIR /network

COPY package*.json ./

RUN npm ci

COPY . .

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /network

USER nodejs

EXPOSE 8667

CMD ["npm", "run", "dev"]
