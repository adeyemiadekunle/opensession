# Egress proxy for sandboxes: the only way out of their internal networks.
# Allows HTTPS (CONNECT) and HTTP only to domains in allowlist.txt plus each user's
# own domains (conf.d, written by the gateway), and never to private, loopback,
# link-local (cloud metadata) or Docker addresses.
FROM alpine:3.20

RUN apk add --no-cache squid \
 && mkdir -p /var/cache/squid /var/log/squid /run/squid /etc/squid/conf.d \
 && echo "# per-user rules are written next to this file by the gateway" > /etc/squid/conf.d/00-base.conf \
 && chown -R squid:squid /var/cache/squid /var/log/squid /run/squid

COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt

USER squid
EXPOSE 3128
CMD ["squid", "-N", "-d", "1", "-f", "/etc/squid/squid.conf"]
