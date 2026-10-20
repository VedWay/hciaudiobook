"""Authentication.

A guest account is created silently on first visit so that a blind student is
never stopped by a sign-in form before they can listen. Registering later
upgrades the same account, keeping its books and reading positions.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..models.schemas import GuestRequest, LoginRequest, RegisterRequest, TokenOut, UserOut
from ..services.security import create_token, decode_token, hash_password, verify_password
from .deps import current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=False)


def _user_out(user: User) -> UserOut:
    return UserOut(id=user.id, display_name=user.display_name, email=user.email, is_guest=user.is_guest)


def _token(user: User) -> TokenOut:
    return TokenOut(access_token=create_token(user.id), user=_user_out(user))


@router.post("/guest", response_model=TokenOut)
def guest(body: GuestRequest, db: Session = Depends(get_db)) -> TokenOut:
    user = User(display_name=body.display_name.strip() or "Guest", is_guest=True)
    db.add(user)
    db.commit()
    return _token(user)


@router.post("/register", response_model=TokenOut)
def register(body: RegisterRequest, db: Session = Depends(get_db),
             credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> TokenOut:
    email = body.email.strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists.")
    guest_id = decode_token(credentials.credentials) if credentials else None
    user = db.get(User, guest_id) if guest_id else None
    if user is None or not user.is_guest:
        user = User()
        db.add(user)
    user.email = email
    user.password_hash = hash_password(body.password)
    user.display_name = body.display_name.strip() or email.split("@")[0]
    user.is_guest = False
    db.commit()
    return _token(user)


@router.post("/login", response_model=TokenOut)
def login(body: LoginRequest, db: Session = Depends(get_db)) -> TokenOut:
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "The email or password is not correct.")
    return _token(user)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)) -> UserOut:
    return _user_out(user)
