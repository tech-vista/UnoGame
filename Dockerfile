FROM heroiclabs/nakama:3.21.1

# Create the build directory structure that Nakama expects
RUN mkdir -p /nakama/data/modules/build

# Copy the JavaScript module to the correct location
COPY --chown=nakama:nakama ./src/index.js /nakama/data/modules/build/index.js

# Copy the configuration file
COPY --chown=nakama:nakama ./local.yml /nakama/data/

# Use local.yml as default config (so Nakama doesn’t fall back to CockroachDB)
ENTRYPOINT ["/nakama/nakama", "--config", "/nakama/data/local.yml"]
