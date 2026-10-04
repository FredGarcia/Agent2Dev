FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY sidecar.mjs ./

CMD ["node", "sidecar.mjs"]
