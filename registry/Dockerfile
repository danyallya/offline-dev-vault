FROM node:24-alpine

WORKDIR /opt/verdaccio
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && mkdir -p /verdaccio/storage /verdaccio/conf \
    && chown -R node:node /verdaccio /opt/verdaccio

USER node
EXPOSE 4873
CMD ["./node_modules/.bin/verdaccio", "--config", "/verdaccio/conf/config.yaml", "--listen", "0.0.0.0:4873"]
