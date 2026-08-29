# H.264 ingest receiver — Node builtins only + ffmpeg for the RTSP remux.
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY server.js au-framing.js au-framing.test.js test-send-h264.js test-transcode.js ./

EXPOSE 8080
CMD ["node", "server.js"]
