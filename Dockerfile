# syntax=docker/dockerfile:1

FROM node:25-alpine AS prod
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Copy server code
COPY server ./server

# Expose API port
EXPOSE 3000

# Start the API server
CMD ["npm", "run", "start"]
