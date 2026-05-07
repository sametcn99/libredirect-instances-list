# LibRedirect Instances List

A client-side web app that fetches and displays [LibRedirect](https://github.com/libredirect/libredirect) alternative front-end instances directly in your browser.

## Features

- Fetches instance data from the [libredirect/instances](https://github.com/libredirect/instances) repository
- Filter by network type: Clearnet, Tor, I2P, Loki
- Search instances by service name or URL
- Check availability of instances directly from the browser
- Tor, I2P, and Loki instances are automatically skipped during checks (cannot be reached from a regular browser)
- Hide unavailable instances with one click
- Favorite services and URLs — favorited items are pinned to the top
- Favorites are persisted in your browser's localStorage
- Clear all favorites with one button (with confirmation)

## Caveats

- The availability check uses the Fetch API in `no-cors` mode, which returns opaque responses. A successful response only confirms the server is reachable — CORS-restricted instances may appear unreachable despite being online.
- `no-cors` GET requests cannot read response bodies, so availability is based on whether the request succeeds, not on HTTP status codes.

## Running Locally

No build step or dependencies required. Just serve the files with any static file server:

```bash
# Python
python3 -m http.server 8080

# Node.js (npx)
npx serve .

# Bun
bunx serve .

# PHP
php -S localhost:8080
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

> **Note:** Opening `index.html` directly via `file://` will not work — the Fetch API requires a proper HTTP origin to make cross-origin requests.

## License

This project is a standalone frontend for the LibRedirect instances data. See the [libredirect/instances](https://github.com/libredirect/instances) repository for data licensing.
