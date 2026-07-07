# syntax=docker/dockerfile:1
# ESP32 syntax-only runner — xtensa-esp-elf toolchain (~200MB), NOT full ESP-IDF.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG TOOLCHAIN_VERSION=14.2.0_20241119
ARG TOOLCHAIN_RELEASE=esp-14.2.0_20241119

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
    amd64) TOOLCHAIN_ARCH=x86_64 ;; \
    arm64) TOOLCHAIN_ARCH=aarch64 ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2 && exit 1 ;; \
  esac \
  && wget -q \
    "https://github.com/espressif/crosstool-NG/releases/download/${TOOLCHAIN_RELEASE}/xtensa-esp-elf-${TOOLCHAIN_VERSION}-${TOOLCHAIN_ARCH}-linux-gnu.tar.xz" \
    -O /tmp/xtensa-esp-elf.tar.xz \
  && mkdir -p /opt \
  && tar -xf /tmp/xtensa-esp-elf.tar.xz -C /opt \
  && rm /tmp/xtensa-esp-elf.tar.xz \
  && ln -sf /opt/xtensa-esp-elf/bin /opt/xtensa-esp-elf-bin

ENV PATH="/opt/xtensa-esp-elf-bin:${PATH}"

COPY vendor/cJSON.h /opt/vendor/cJSON.h

# quicktype cjson also includes hashtable.h / list.h — syntax-only stubs suffice.
RUN printf '%s\n' \
  '#ifndef HASHTABLE_H' \
  '#define HASHTABLE_H' \
  'typedef struct hashtable hashtable_t;' \
  '#endif' \
  > /opt/vendor/hashtable.h \
  && printf '%s\n' \
  '#ifndef LIST_H' \
  '#define LIST_H' \
  'typedef struct list list_t;' \
  '#endif' \
  > /opt/vendor/list.h

COPY run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/run.sh"]
