FROM node:26-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_HARMOLYN_APP_URL=https://web.harmolyn.com
ARG VITE_SOURCE_URL=https://github.com/cogniloom/harmolyn
ARG VITE_XOREIN_URL=https://xorein.com
ARG VITE_APP_VERSION=1.0.0-rc.1
ENV VITE_HARMOLYN_APP_URL=$VITE_HARMOLYN_APP_URL
ENV VITE_SOURCE_URL=$VITE_SOURCE_URL
ENV VITE_XOREIN_URL=$VITE_XOREIN_URL
ENV VITE_APP_VERSION=$VITE_APP_VERSION

RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

USER nginx

EXPOSE 8080
