FROM node:20-alpine
WORKDIR /app
# Build context = raiz do repositório (para levar junto o db/001_dominio.sql)
COPY caravanas-service/package*.json ./
RUN npm install --production
COPY caravanas-service/ .
COPY db/ ./db/
USER node
EXPOSE 3000
CMD ["npm", "start"]
