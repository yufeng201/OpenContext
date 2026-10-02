# Runtime example; build the reviewed Node release directory first.
# Supply a verified digest-qualified Node 24.19.0 image. No guessed digest.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
# Reviewed base must include Git for the approved repository connector.
RUN node -e "if(process.version!=='v24.19.0')process.exit(1)" && git --version
ARG PNPM_VERSION=11.19.0
RUN npm install --global pnpm@${PNPM_VERSION} --ignore-scripts
WORKDIR /opt/opencontext
COPY --chown=node:node . .
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
USER node
ENV NODE_ENV=production OPENCONTEXT_BIND_HOST=0.0.0.0 OPENCONTEXT_DATA_ROOT=/var/lib/opencontext OPENCONTEXT_OWNER_TOKEN_FILE=/run/opencontext-owner PORT=4310
EXPOSE 4310
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--max-old-space-size=512", "apps/server/src/main.ts"]
