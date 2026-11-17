"""Exact unsigned timestamps on SQLite and PostgreSQL, without floating point."""

from sqlalchemy import String
from sqlalchemy.types import TypeDecorator


class UnsignedMillis(TypeDecorator):
    # Fixed-width decimal text sorts numerically and covers all of u64 on SQLite.
    impl = String(20)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if type(value) is not int or not 0 <= value < 1 << 64:
            raise ValueError("timestamp outside unsigned 64-bit range")
        return f"{value:020d}"

    def process_result_value(self, value, dialect):
        return None if value is None else int(value)
