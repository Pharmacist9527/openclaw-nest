FROM node:22-alpine
WORKDIR /app
COPY dist/nest.cjs .
COPY public/ public/
EXPOSE 6800
ENV NEST_ENGINE=docker
ENV HOST_DATA_PATH=/data/openclaw-nest
CMD ["node", "nest.cjs", "--server"]
