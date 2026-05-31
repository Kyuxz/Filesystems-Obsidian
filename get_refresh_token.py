#!/usr/bin/env python3
"""
get_refresh_token.py
--------------------
Run this ONCE to exchange your Dropbox app credentials for a long-lived
refresh token that never expires.

Usage:
  pip install dropbox
  python get_refresh_token.py

You'll need your App Key and App Secret from:
  https://www.dropbox.com/developers/apps  → your app → Settings tab
"""

from dropbox import DropboxOAuth2FlowNoRedirect

print("=" * 60)
print("Dropbox Refresh Token Generator")
print("=" * 60)
print()
print("Open https://www.dropbox.com/developers/apps")
print("Select your app → Settings tab → copy App Key & App Secret")
print()

app_key    = input("Enter your App Key    : ").strip()
app_secret = input("Enter your App Secret : ").strip()

auth_flow = DropboxOAuth2FlowNoRedirect(
    app_key,
    app_secret,
    token_access_type="offline",  # ← this gives a non-expiring refresh token
)

authorize_url = auth_flow.start()

print()
print("─" * 60)
print("1. Go to this URL in your browser:")
print()
print(f"   {authorize_url}")
print()
print("2. Click 'Allow' to authorise your app.")
print("3. Copy the authorisation code shown on screen.")
print("─" * 60)
print()

code = input("Paste the authorisation code here: ").strip()

try:
    result = auth_flow.finish(code)
    print()
    print("✅  Success! Add these to your deployment environment variables:")
    print()
    print(f"  DROPBOX_APP_KEY={app_key}")
    print(f"  DROPBOX_APP_SECRET={app_secret}")
    print(f"  DROPBOX_REFRESH_TOKEN={result.refresh_token}")
    print()
    print("Keep these values private — they give full access to your Dropbox.")
except Exception as e:
    print(f"\n❌  Error: {e}")
    print("Check the code was copied correctly and try again.")
