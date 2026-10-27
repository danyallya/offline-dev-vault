FROM public.ecr.aws/docker/library/node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

RUN addgroup -S vault && adduser -S vault -G vault \
    && mkdir -p /data /config \
    && chown -R vault:vault /app /data /config

USER vault
EXPOSE 7373
CMD ["node", "src/server.js"]
