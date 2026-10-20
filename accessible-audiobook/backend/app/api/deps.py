"""Shared FastAPI dependencies."""
from __future__ import annotations

import hmac

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Book, User
from ..services.security import decode_token

_bearer = HTTPBearer(auto_error=False)


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
                 db: Session = Depends(get_db)) -> User:
    user_id = decode_token(credentials.credentials) if credentials else None
    user = db.get(User, user_id) if user_id else None
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in again.",
                            headers={"WWW-Authenticate": "Bearer"})
    return user


def readable_book(book_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Book:
    """A book the user may read: a shared sample or one they uploaded."""
    book = db.get(Book, book_id)
    if book is None or (book.owner_id is not None and book.owner_id != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Book not found.")
    return book


def ready_book(book: Book = Depends(readable_book)) -> Book:
    if book.status != "ready":
        raise HTTPException(status.HTTP_409_CONFLICT, "This book is still being prepared.")
    return book


def researcher(x_researcher_passcode: str = Header(default=""), _: User = Depends(current_user)) -> None:
    """Guards participant data when RESEARCHER_PASSCODE is configured."""
    expected = get_settings().researcher_passcode
    if expected and not hmac.compare_digest(x_researcher_passcode, expected):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Researcher passcode required.")
