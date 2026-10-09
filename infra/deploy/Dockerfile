FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.19.0
WORKDIR /workspace

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS api-build
COPY . .
RUN pnpm exec turbo run build --filter=@uconext/api...

FROM base AS runtime-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --prod --frozen-lockfile --filter=@uconext/api...

FROM dependencies AS web-build
ARG NEXT_PUBLIC_WEB_ORIGIN=http://localhost:3000
ARG SOURCE_REVISION=local
ARG WEB_BUILD_KEY_FINGERPRINT
ENV NEXT_PUBLIC_WEB_ORIGIN=$NEXT_PUBLIC_WEB_ORIGIN
ENV UCONEXT_BUILD_ID=$SOURCE_REVISION
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --mount=type=secret,id=web-build-key,required=true pnpm exec turbo run build --filter=@uconext/web... && node infra/deploy/normalize-next-build.mjs

FROM base AS api-runtime
ARG SOURCE_DATE_EPOCH=0
ENV NODE_ENV=production
ENV UCONEXT_TRUSTED_PROXY_IPS=127.0.0.1
COPY --from=runtime-dependencies --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=runtime-dependencies --chown=node:node /workspace/apps/api/node_modules /app/apps/api/node_modules
COPY --from=runtime-dependencies --chown=node:node /workspace/packages/shared /app/packages/shared
COPY --from=api-build --chown=node:node /workspace/apps/api/dist /app/apps/api/dist
COPY --from=api-build --chown=node:node /workspace/apps/api/package.json /app/apps/api/package.json
COPY --from=api-build --chown=node:node /workspace/packages/shared/dist /app/packages/shared/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/api/v1/health/ready',{headers:{'x-forwarded-proto':'https'},redirect:'error'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

FROM api-runtime AS api
CMD ["node","dist/main.js"]

FROM api-runtime AS worker
EXPOSE 3001
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","dist/worker.js"]

FROM base AS web
ARG SOURCE_DATE_EPOCH=0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/standalone /app
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/static /app/apps/web/.next/static
COPY --from=web-build --chown=node:node /workspace/apps/web/public /app/apps/web/public
WORKDIR /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/icon-192.png',{redirect:'error'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","apps/web/server.js"]
