# Weber — all-in-one image for platforms that give one container and one port.
#
# This is deliberately NOT the compose topology. There, nginx is the edge and
# the core sits behind it. A PaaS (Heroku, Render, Fly, Railway) runs a single
# process, so there is no edge:
#
#   * the core serves the built SPA itself
#   * the platform's PORT is honoured, since the router assigns it at runtime
#   * everything binds 0.0.0.0, because the router connects from outside
#
# The consequence worth understanding before deploying: with no edge and no
# authentication configured, the public URL is an open shell that executes
# allow-listed commands. Read the auth section below.

# ---------------------------------------------------------------------------
# build: full toolchain, so the SPA bundles and the types resolve.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json bunfig.toml ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

# The SPA must exist before the runtime stage copies it; a missing dist/web
# would make the deployment answer the API and 404 the UI.
RUN bun run build:web

# ---------------------------------------------------------------------------
# runtime: production dependencies only, non-root, one port.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    CORE_HOST=0.0.0.0 \
    # WEBER_WEB_ROOT points the core at the built SPA, since there is no nginx
    # to serve it. Without this the deployment serves the API only.
    WEBER_WEB_ROOT=/app/dist/web \
    WORKSPACE_ROOT=/workspaces \
    # Seeding is on, so a first-time visitor sees something rather than an
    # empty tree.
    WEBER_SEED=1

RUN mkdir -p /workspaces && chown -R bun:bun /workspaces /app 2>/dev/null || true

COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=bun:bun /app/bunfig.toml ./bunfig.toml
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules

USER bun

# Default for local runs. Platforms override this with their own PORT, which
# src/server/main.ts reads at startup — hardcoding one here would make the
# router unable to reach the app.
EXPOSE 8080
ENV CORE_PORT=8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD bun -e "await fetch('http://127.0.0.1:'+(process.env.PORT||process.env.CORE_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ---------------------------------------------------------------------------
# Authentication — READ THIS BEFORE DEPLOYING PUBLICLY.
#
# The core refuses to enable authentication unless BOTH are set:
#
#   GITHUB_CLIENT_ID     from a GitHub OAuth app with Device Flow enabled
#   WEBER_ALLOWED_LOGINS comma-separated logins permitted to sign in
#
# With either missing, the server starts unauthenticated and logs a warning.
# That warning is the last line of defence, not a formality: Weber exposes file
# access and an allow-listed command runner, so an unauthenticated public URL
# is a remote execution service.
#
# A session secret is also required once auth is on:
#
#   WEBER_SESSION_SECRET at least 16 characters; generate with:
#     head -c 32 /dev/urandom | base64
# ---------------------------------------------------------------------------

CMD ["bun", "run", "src/server/main.ts"]
