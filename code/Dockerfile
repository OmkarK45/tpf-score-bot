# Use Node.js LTS version based on Debian (supports ARM)
FROM node:18-slim

# Set working directory
WORKDIR /usr/src/app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Build TypeScript code (output to the "dist" folder)
RUN npm run build

# Create a directory for persistent data (SQLite file)
RUN mkdir -p /usr/src/app/data

# Expose a port if needed
EXPOSE 3000

# Start the bot using the compiled code
CMD ["npm", "start"]
