# Heroku process declaration.
#
# A single web process. The core serves the built SPA itself, which is what
# makes a one-dyno deployment work at all — there is no separate edge process
# to run on this platform.
#
# The platform injects PORT at runtime and src/server/main.ts reads it. Binding
# anything else means the router cannot reach the app, and the symptom is a
# request timeout with no error in the log.
web: bun run src/server/main.ts
