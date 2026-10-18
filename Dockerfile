FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY ui ./ui
COPY examples ./examples
RUN npm link
ENTRYPOINT ["safe-load-lab"]
CMD ["--help"]
