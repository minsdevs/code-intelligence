FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV TS_ANALYZER_HOST=0.0.0.0
ENV TS_ANALYZER_PORT=3040
EXPOSE 3040
CMD ["node", "dist/main.js"]
