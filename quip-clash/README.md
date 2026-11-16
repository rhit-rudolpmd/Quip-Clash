# Quip Clash

A party game for 3-6 players. No dependencies, no accounts, no database. Just Node 18+.

## Run it on your computer
    node server.js
Open http://localhost:3000. Friends on the same Wi-Fi can open http://YOUR-COMPUTER-IP:3000.

## Put it online (free)
Any host that runs Node works. Example with Render.com:
1. Put this folder in a GitHub repo.
2. On render.com: New > Web Service > pick the repo.
3. Runtime: Node. Build command: (leave empty). Start command: `node server.js`.
4. Deploy. Render gives you a link like https://quip-clash-xxxx.onrender.com.
Railway, Fly.io, Glitch and any VPS work the same way (the server reads the PORT environment variable).

## How to play
Create a room, copy the invite link, send it to friends. Everyone opens it, enters a name, and the host starts.
Rounds 1 and 2: each player answers 2 prompts, everyone else votes on each matchup. Round 2 is worth double.
Last Lap: everyone answers one prompt and votes for up to 3 favorites.

## Notes
- Games live in server memory. Restarting the server ends active games.
- A player who reloads or loses signal rejoins automatically.
- Prompts come from a built-in bank plus randomized templates, so no AI service is needed.
