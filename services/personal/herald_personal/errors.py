"""Errors with intentionally bounded, non-sensitive public messages."""


class ServiceError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail
