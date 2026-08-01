FROM node:26-alpine AS build

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .

# Vite inlines VITE_* vars at build time — declare as ARGs and promote to ENV
ARG VITE_XOREIN_CONTROL_ENDPOINT=https://node.xorein.com
ARG VITE_SOURCE_URL=https://github.com/cogniloom/harmolyn
ENV VITE_XOREIN_CONTROL_ENDPOINT=$VITE_XOREIN_CONTROL_ENDPOINT
ENV VITE_SOURCE_URL=$VITE_SOURCE_URL

RUN npm run build

# Runtime stage: serve dist/ with nginx
FROM nginxinc/nginx-unprivileged:alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Run as non-root user
USER nginx

EXPOSE 8080
