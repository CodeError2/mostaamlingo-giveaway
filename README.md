# جوائز مستعملينجو — Comment Giveaway Picker

Pick giveaway winners from the comments of a TikTok / Facebook / YouTube video, with an AI filter that keeps only comments from people who want to enter, a countdown, a wheel animation and a winners screen.

Zero npm dependencies (Node 18+).

## Online (GitHub Pages)
The `docs/` folder is a fully static version: open the site, click ⚙️, and paste your keys (they are stored only in that browser's localStorage, never in this repo).

## Run locally
1. Copy `.env.example` to `.env` and fill in the keys you need.
2. `node server.js` (or double-click `start.bat` on Windows), then open http://localhost:3000

## Keys
| Platform | Needs |
|---|---|
| TikTok | nothing (unofficial tikwm.com API) |
| YouTube | `YOUTUBE_API_KEY` (YouTube Data API v3) |
| Facebook | `APIFY_TOKEN` (easiest) or `FACEBOOK_ACCESS_TOKEN` |
| AI filter | `GEMINI_API_KEY` (falls through several models when a daily quota runs out) |

by Omar Ahmed · CodeError
