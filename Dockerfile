FROM node:22-slim
WORKDIR /app

# Install dockerode (marked as external in esbuild bundle)
RUN npm init -y > /dev/null 2>&1 && npm install dockerode --omit=dev && \
    rm -rf /root/.npm /tmp/*

COPY dist/nest.cjs .
COPY public/ public/

EXPOSE 6800
ENV NEST_ENGINE=docker
ENV HOST_DATA_PATH=/data/openclaw-nest
CMD ["node", "nest.cjs", "--server"]
