FROM node:18

RUN mkdir -p /home/node/network/node_modules && chown -R node:node /home/node/network

WORKDIR /home/node/network

COPY package*.json ./

USER node

RUN npm ci --only=production

COPY --chown=node:node . .

EXPOSE 8081
CMD [ "npm", "run", "dev" ]
