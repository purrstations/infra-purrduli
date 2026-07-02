# MJPEG ingest receiver — Node builtins only + ffmpeg for the actual transcode.
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY server.js framing.js ./

EXPOSE 8080
CMD ["node", "server.js"]
