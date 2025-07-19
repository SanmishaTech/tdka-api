# Use official Node.js image as build stage
FROM node:18 AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source files
COPY . .

# Production image
FROM node:18-slim

WORKDIR /app

# Install OpenSSL for Prisma and ffmpeg
RUN apt-get update -y && apt-get install -y openssl

# Copy only necessary files from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.env ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/server.js ./

# Expose port (match your .env PORT)
EXPOSE 3000

# Start the app with migration
# CMD npx prisma migrate dev --name init && npx prisma generate && npm run seed && npm start
CMD npx prisma generate && npm start