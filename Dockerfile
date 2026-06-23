# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM debian:bookworm-slim AS build
ARG ZIG_VERSION=0.15.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install the pinned Zig toolchain.
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
    && mkdir -p /opt/zig \
    && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
    && rm /tmp/zig.tar.xz
ENV PATH="/opt/zig:${PATH}"

WORKDIR /src
COPY build.zig build.zig.zon ./
COPY src ./src
COPY frontend ./frontend
COPY public ./public
RUN zig build -Doptimize=ReleaseSafe

# ---------- runtime stage ----------
FROM debian:bookworm-slim AS runtime

# ca-certificates + curl: the app shells out to /usr/bin/curl to send email.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /app app

WORKDIR /app
COPY --from=build /src/zig-out/bin/taskmanager /app/taskmanager
COPY --from=build /src/public /app/public

USER app
EXPOSE 9000

# Listen on all interfaces inside the container; the host maps the port.
ENV INTERFACE=0.0.0.0 \
    PORT=9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:9000/api/health" || exit 1

CMD ["/app/taskmanager"]
