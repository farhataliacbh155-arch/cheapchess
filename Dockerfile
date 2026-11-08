FROM node:22-slim
WORKDIR /app
COPY package.json server.js multiplayer.js engine.js Chess.html ./
ENV PORT=3000 DB_PATH=/data/chess.db TRUST_PROXY=1
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
