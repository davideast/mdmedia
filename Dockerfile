# Multi-stage hermetic Cloud Run build for mdmedia studio.
#
# Stage 1 compiles the root `mdmedia` package and packs it into a self-contained
# tarball. Stage 2 installs studio dependencies with all local Pyric dev-only
# packages and postinstall hooks stripped, builds the Next.js production app,
# and starts the server on port 8080 using Cloud Run's attached runtime service
# account (Application Default Credentials) and Secret Manager environment vars.

FROM node:22-slim AS mdmedia-pack
WORKDIR /workspace/mdmedia
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm install && npm run build && npm pack

FROM node:22-slim AS studio-build
WORKDIR /workspace/studio
COPY studio/package.json ./
COPY --from=mdmedia-pack /workspace/mdmedia/mdmedia-0.1.0.tgz /workspace/mdmedia-0.1.0.tgz

# Strip local-only dev tarballs and dev postinstall before installing
RUN npm pkg delete devDependencies.@pyric/cli \
    && npm pkg delete devDependencies.create-pyric \
    && npm pkg delete devDependencies.pyric \
    && npm pkg delete devDependencies.pyric-admin \
    && npm pkg delete scripts.postinstall \
    && npm install

COPY studio/tsconfig.json studio/next.config.ts studio/postcss.config.mjs ./
COPY studio/public ./public
COPY studio/src ./src

ARG NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyC05u0Xoy3HGawRmkVJ8VKgfg7bFmPD4EM
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=mdmedia-dev.firebaseapp.com
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID=mdmedia-dev
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=mdmedia-dev.firebasestorage.app
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=932128201314
ARG NEXT_PUBLIC_FIREBASE_APP_ID=1:932128201314:web:1fbb8c7eb31a45982a8f3b
ARG NEXT_PUBLIC_API_ORIGIN=https://studio-932128201314.us-central1.run.app

ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN \
    NODE_ENV=production
RUN npx next build

FROM node:22-slim AS runner
WORKDIR /workspace/studio
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    FIREBASE_PROJECT_ID=mdmedia-dev \
    FIREBASE_STORAGE_BUCKET=mdmedia-dev.firebasestorage.app
EXPOSE 8080

COPY --from=studio-build /workspace/studio/public ./public
COPY --from=studio-build /workspace/studio/.next/standalone ./
COPY --from=studio-build /workspace/studio/.next/static ./.next/static

CMD ["node", "server.js"]
