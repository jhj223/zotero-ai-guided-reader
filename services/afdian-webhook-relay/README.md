# Afdian webhook relay

This Cloudflare Pages Function is a narrow TLS compatibility relay for Afdian.
It accepts only `POST /webhooks/afdian`, forwards the unchanged JSON body to the
licensing Worker, and returns the Worker's response. It stores no credentials or
payment data and does not decide whether a license is granted.
