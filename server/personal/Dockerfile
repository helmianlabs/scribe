# Build + run the MCP server.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
# Meaning-based search is OFF by default and its package is not a dependency. Only with
# --build-arg WITH_EMBEDDINGS=1 is it installed (large: about 750 MB with its native runtime);
# it still does nothing unless SCRIBE_EMBEDDINGS=local is set and migrations/p002 is applied.
ARG WITH_EMBEDDINGS=0
RUN if [ "$WITH_EMBEDDINGS" = "1" ]; then npm install --no-save --no-audit --no-fund @huggingface/transformers@4.3.2; fi
COPY --from=build /app/dist ./dist
# Fly sets PORT; the app reads it.
EXPOSE 8080
CMD ["node", "dist/index.js"]
