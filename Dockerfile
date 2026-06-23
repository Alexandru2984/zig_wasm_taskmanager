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
# zap links facil.io as a shared library that lives only in the build cache,
# so stage the binary together with libfacil.io.so for the runtime image.
RUN zig build -Doptimize=ReleaseSafe \
    && mkdir -p /out/bin /out/lib \
    && cp zig-out/bin/taskmanager /out/bin/taskmanager \
    && cp "$(find .zig-cache -name 'libfacil.io.so' | head -n1)" /out/lib/libfacil.io.so

# ---------- runtime stage ----------
FROM debian:bookworm-slim AS runtime

# ca-certificates + curl: the app shells out to /usr/bin/curl to send email.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /app app

WORKDIR /app
COPY --from=build /out/bin/taskmanager /app/taskmanager
COPY --from=build /out/lib/ /app/lib/
COPY --from=build /src/public /app/public

USER app
EXPOSE 9000

# Listen on all interfaces inside the container; the host maps the port.
# LD_LIBRARY_PATH lets the binary find libfacil.io.so staged above.
ENV INTERFACE=0.0.0.0 \
    PORT=9000 \
    LD_LIBRARY_PATH=/app/lib

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:9000/api/health" || exit 1

CMD ["/app/taskmanager"]
