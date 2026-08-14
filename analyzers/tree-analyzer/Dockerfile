FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV TREE_ANALYZER_HOST=0.0.0.0
ENV TREE_ANALYZER_PORT=3041
EXPOSE 3041
CMD ["node", "dist/main.js"]
