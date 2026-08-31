"""Application WebSocket close-code partition.

``4000`` is only a real takeover by a newer daemon generation. ``4004`` is a
fencing or consistency failure (database/Redis ownership disagreement, pool or
bounded-send failure). ``4010`` means a Redis subscription ended and the peer
must reconnect to subscribe again. ``1012`` is reserved for server shutdown.
Protocol/content errors keep their existing ``4003``/``4002`` meanings.
"""

WS_CLOSE_SUPERSEDED = 4000
WS_CLOSE_CONTENT_FORBIDDEN = 4002
WS_CLOSE_PROTOCOL_REQUIRED = 4003
WS_CLOSE_CONSISTENCY = 4004
WS_CLOSE_KEEPALIVE_TIMEOUT = 4008
WS_CLOSE_SUBSCRIPTION_LOST = 4010
WS_CLOSE_SERVER_RESTART = 1012
